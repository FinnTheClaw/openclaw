from __future__ import annotations

import errno
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from functional_finn_authority.canonical_frame import encode_release_frame
from functional_finn_authority.finnsig_service import FinnsigApplication
from functional_finn_authority.ingress_ledger import BoundDelivery, IngressLedger
from functional_finn_authority.protocol import SendSignedFrame, request_document
from functional_finn_authority.sender_ledger import SenderLedger
from functional_finn_authority.signal_cli_transport import (
    MAX_CHILD_LINE_BYTES,
    SignalCliJsonRpcTransport,
    SignalCliTransportError,
)
from functional_finn_authority.signing import FrameSigner

from .support import sample_frame
from .test_ingress_ledger import observation


@unittest.skipIf(os.name == "nt", "requires an executable process fixture")
class SignalCliTransportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = self.root / "signal-store"
        self.config.mkdir()
        source = Path(__file__).parent / "fixtures" / "fake_signal_cli.py"
        self.binary = self.root / "signal-cli"
        self.binary.write_bytes(source.read_bytes())
        self.binary.chmod(0o755)
        self.ledger = IngressLedger(self.root / "ingress.sqlite")
        self.transports: list[SignalCliJsonRpcTransport] = []

    def tearDown(self) -> None:
        for transport in self.transports:
            transport.close()
        self.ledger.close()
        self.temporary.cleanup()

    def transport(self, **overrides: object) -> SignalCliJsonRpcTransport:
        values = {
            "binary": self.binary,
            "config_path": self.config,
            "account": "+15550001111",
            "account_id": "finn-signal",
            "ingress": self.ledger,
            "request_timeout_seconds": 1.0,
            "now": lambda: 1_723_700_100,
        }
        values.update(overrides)
        created = SignalCliJsonRpcTransport(**values)  # type: ignore[arg-type]
        self.transports.append(created)
        return created

    def target(self, *, kind: str = "direct") -> BoundDelivery:
        return BoundDelivery(
            ingress_id="ingress-1",
            binding_id="binding-1",
            account_id="finn-signal",
            destination_kind=kind,
            reply_destination="recipient-1" if kind == "direct" else "group-1",
            turn_sequence=7,
        )

    def test_real_child_send_is_exact_and_returns_authoritative_timestamp(self) -> None:
        result = self.transport().send_text(self.target(), "Exact answer.")
        self.assertEqual(result.message_id, "1723700999000")
        rows = (self.config / "physical-send.log").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0]), {"message": "Exact answer.", "recipient": ["recipient-1"]})

    def test_real_child_normalizes_inbound_before_pull(self) -> None:
        notification = {
            "jsonrpc": "2.0",
            "method": "receive",
            "params": {
                "envelope": {
                    "sourceUuid": "123e4567-e89b-12d3-a456-426614174000",
                    "timestamp": 1723700000123,
                    "dataMessage": {"timestamp": 1723700000123, "message": "Observed fact."},
                }
            },
        }
        (self.config / "inbound.json").write_text(json.dumps(notification), encoding="utf-8")
        transport = self.transport()
        transport.start()
        result = transport.send_text(self.target(), "Exact answer.")
        self.assertEqual(result.message_id, "1723700999000")
        rows = self.ledger.pull(after_ordinal=0, limit=10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].content, "Observed fact.")
        self.assertEqual(rows[0].source_kind, "uuid")
        self.assertEqual(rows[0].conversation_kind, "direct")

    def test_spawn_eagain_is_bounded_without_child_or_send(self) -> None:
        def unavailable(*_args: object, **_kwargs: object) -> object:
            raise OSError(errno.EAGAIN, "resource unavailable")

        transport = self.transport(popen=unavailable)
        with self.assertRaisesRegex(SignalCliTransportError, "could not start"):
            transport.send_text(self.target(), "Exact answer.")
        self.assertFalse((self.config / "physical-send.log").exists())

    def test_malformed_oversized_and_crashed_children_fail_closed(self) -> None:
        for mode in ("malformed", "oversized", "crash"):
            with self.subTest(mode=mode):
                (self.config / "mode").write_text(mode, encoding="utf-8")
                transport = self.transport()
                with self.assertRaises(SignalCliTransportError):
                    transport.send_text(self.target(), "Exact answer.")
                transport.close()
                self.assertFalse((self.config / "physical-send.log").exists())
                (self.config / "mode").unlink()

    def test_group_destination_and_close_are_deterministic(self) -> None:
        transport = self.transport()
        transport.send_text(self.target(kind="group"), "Exact answer.")
        transport.close()
        transport.close()
        with self.assertRaisesRegex(SignalCliTransportError, "closed"):
            transport.send_text(self.target(kind="group"), "Again.")
        self.assertEqual(MAX_CHILD_LINE_BYTES, 1024 * 1024)

    def test_timeout_wakes_request_without_deadlock_or_worker_residue(self) -> None:
        (self.config / "mode").write_text("hang", encoding="utf-8")
        transport = self.transport(request_timeout_seconds=0.05)
        failures: list[BaseException] = []

        def run() -> None:
            try:
                transport.send_text(self.target(), "Exact answer.")
            except BaseException as error:
                failures.append(error)

        started = time.monotonic()
        caller = threading.Thread(target=run, name="signal-timeout-caller")
        caller.start()
        caller.join(timeout=1)
        self.assertFalse(caller.is_alive())
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], SignalCliTransportError)
        transport.close()
        self.assertFalse(
            any(
                thread.is_alive() and thread.name.startswith("finnsig-signal-")
                for thread in threading.enumerate()
            )
        )
        self.assertFalse((self.config / "physical-send.log").exists())

    def test_crash_after_physical_attempt_is_unknown_and_never_retried(self) -> None:
        view = self.ledger.ingest(observation())
        sender_path = self.root / "sender.sqlite"
        sender = SenderLedger(sender_path)
        signer = FrameSigner(Ed25519PrivateKey.generate())
        frame = sample_frame(
            ingress_id=view.ingress_id,
            destination_binding_id=view.binding_id,
            account_id=view.account_id,
            turn_sequence=view.sequence,
        )
        document = request_document(SendSignedFrame("send-1", signer.sign(encode_release_frame(frame))))
        (self.config / "mode").write_text("after_send_crash", encoding="utf-8")
        transport = self.transport()
        app = FinnsigApplication(
            ingress=self.ledger, sender_ledger=sender, physical_sender=transport,
            release_public_key=signer.public_key(), release_key_id=frame.key_id,
            now=lambda: 1_723_700_100,
        )
        try:
            first = app.handle_release(document)
            self.assertEqual(first["state"], "UNKNOWN")
            transport.close()
            sender.close()
            sender = SenderLedger(sender_path)
            (self.config / "mode").write_text("success", encoding="utf-8")
            restarted_transport = self.transport()
            restarted = FinnsigApplication(
                ingress=self.ledger, sender_ledger=sender, physical_sender=restarted_transport,
                release_public_key=signer.public_key(), release_key_id=frame.key_id,
                now=lambda: 1_723_700_101,
            )
            second = restarted.handle_release(document)
            self.assertEqual(second["state"], "UNKNOWN")
            self.assertEqual(len((self.config / "physical-send.log").read_text().splitlines()), 1)
        finally:
            sender.close()


if __name__ == "__main__":
    unittest.main()

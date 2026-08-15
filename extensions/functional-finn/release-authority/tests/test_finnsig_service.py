from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from functional_finn_authority.canonical_frame import encode_release_frame
from functional_finn_authority.finnsig_service import FinnsigApplication, FinnsigServiceError
from functional_finn_authority.ingress_ledger import BoundDelivery, IngressLedger
from functional_finn_authority.protocol import IngressLookup, IngressPull, SendSignedFrame, request_document
from functional_finn_authority.sender_ledger import SendResult, SenderLedger, SenderState
from functional_finn_authority.signing import FrameSigner

from .support import sample_frame
from .test_ingress_ledger import observation


class SignalProbe:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[BoundDelivery, str]] = []

    def send_text(self, target: BoundDelivery, message: str) -> SendResult:
        self.calls.append((target, message))
        if self.fail:
            raise RuntimeError("ambiguous Signal transport")
        return SendResult("signal-message-1")


class FinnsigServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.ingress = IngressLedger(root / "ingress.sqlite")
        self.sender = SenderLedger(root / "sender.sqlite")
        self.view = self.ingress.ingest(observation())
        self.signer = FrameSigner(Ed25519PrivateKey.generate())
        self.probe = SignalProbe()
        self.app = self.application(self.probe)

    def tearDown(self) -> None:
        self.ingress.close()
        self.sender.close()
        self.temporary.cleanup()

    def application(self, probe: SignalProbe) -> FinnsigApplication:
        return FinnsigApplication(
            ingress=self.ingress,
            sender_ledger=self.sender,
            physical_sender=probe,
            release_public_key=self.signer.public_key(),
            release_key_id="release-key-2026-08",
            now=lambda: 1_723_700_100,
        )

    def send_document(self, **changes: object) -> dict[str, object]:
        frame = sample_frame(
            ingress_id=self.view.ingress_id,
            destination_binding_id=self.view.binding_id,
            account_id=self.view.account_id,
            turn_sequence=self.view.sequence,
            **changes,
        )
        signed = self.signer.sign(encode_release_frame(frame))
        return request_document(SendSignedFrame("send-request-1", signed))

    def test_lookup_and_pull_never_expose_reply_destination(self) -> None:
        lookup = self.app.handle_release(request_document(IngressLookup("lookup-1", self.view.ingress_id)))
        pull = self.app.handle_openclaw(request_document(IngressPull("pull-1", 0, 10)))
        self.assertEqual(lookup["record"]["bindingId"], self.view.binding_id)
        self.assertNotIn("destination", str(lookup).lower())
        self.assertNotIn("destination", str(pull).lower())
        with self.assertRaises(FinnsigServiceError):
            self.app.handle_openclaw(request_document(IngressLookup("lookup-2", self.view.ingress_id)))

    def test_signed_bound_frame_sends_exactly_once_to_ledger_destination(self) -> None:
        first = self.app.handle_release(self.send_document())
        second = self.app.handle_release(self.send_document())
        self.assertEqual(first["state"], "DELIVERED")
        self.assertEqual(second, first)
        self.assertEqual(len(self.probe.calls), 1)
        target, message = self.probe.calls[0]
        self.assertEqual(target.reply_destination, "trusted-recipient-opaque-1")
        self.assertEqual(message, "A supported answer.")

    def test_wrong_destination_key_or_expiry_fails_before_physical_send(self) -> None:
        cases = (
            {"destination_binding_id": "binding:" + "0" * 64},
            {"account_id": "other-account"},
            {"turn_sequence": 9},
            {"key_id": "other-key"},
            {"expires_at": 1_723_700_099},
        )
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(Exception):
                self.app.handle_release(self.send_document(**changes))
        self.assertEqual(self.probe.calls, [])

    def test_unknown_never_retries_across_replay_or_restart(self) -> None:
        failing = SignalProbe(fail=True)
        self.app = self.application(failing)
        first = self.app.handle_release(self.send_document())
        second = self.app.handle_release(self.send_document())
        self.assertEqual(first["state"], "UNKNOWN")
        self.assertEqual(second["state"], "UNKNOWN")
        self.assertEqual(len(failing.calls), 1)
        self.sender.close()
        self.sender = SenderLedger(Path(self.temporary.name) / "sender.sqlite")
        healthy = SignalProbe()
        restarted = self.application(healthy)
        third = restarted.handle_release(self.send_document())
        self.assertEqual(third["state"], "UNKNOWN")
        self.assertEqual(healthy.calls, [])

    def test_crashed_attempt_recovers_unknown_and_never_calls_sender(self) -> None:
        document = self.send_document()
        request = SendSignedFrame("send-request-1", self.signer.sign(encode_release_frame(sample_frame(
            ingress_id=self.view.ingress_id,
            destination_binding_id=self.view.binding_id,
            account_id=self.view.account_id,
            turn_sequence=self.view.sequence,
        ))))
        self.sender.receive(request.signed_frame, public_key=self.signer.public_key(), now=1_723_700_100)
        self.sender.begin_attempt("frame-001", now=1_723_700_100)
        self.sender.close()
        self.sender = SenderLedger(Path(self.temporary.name) / "sender.sqlite")
        self.assertEqual(self.sender.recover_after_restart(now=1_723_700_101), 1)
        probe = SignalProbe()
        self.app = self.application(probe)
        result = self.app.handle_release(document)
        self.assertEqual(result["state"], SenderState.UNKNOWN.value)
        self.assertEqual(probe.calls, [])


if __name__ == "__main__":
    unittest.main()

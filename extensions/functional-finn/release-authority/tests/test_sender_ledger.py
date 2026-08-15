from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

from functional_finn_authority.canonical_frame import ReleaseFrame
from functional_finn_authority.sender_ledger import (
    SendResult,
    SenderCoordinator,
    SenderLedger,
    SenderLedgerError,
    SenderState,
)
from functional_finn_authority.signing import SignedFrame

from .support import signed_frame


class CountingSender:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.frames: list[ReleaseFrame] = []

    def send(self, frame: ReleaseFrame) -> SendResult:
        self.frames.append(frame)
        if self.fail:
            raise RuntimeError("ambiguous transport failure")
        return SendResult(message_id="signal-message-1")


class SenderLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "sender.sqlite"
        self.ledger = SenderLedger(self.path, max_records=2)
        self.signed, self.signer = signed_frame()

    def tearDown(self) -> None:
        self.ledger.close()
        self.temporary.cleanup()

    def receive(self) -> None:
        record = self.ledger.receive(self.signed, public_key=self.signer.public_key(), now=100)
        self.assertEqual(record.state, SenderState.RECEIVED)

    def test_signature_and_exact_frame_binding_are_required(self) -> None:
        self.receive()
        self.assertEqual(
            self.ledger.receive(self.signed, public_key=self.signer.public_key(), now=101).state,
            SenderState.RECEIVED,
        )
        tampered = SignedFrame(self.signed.payload + b" ", self.signed.signature)
        with self.assertRaises(SenderLedgerError):
            self.ledger.receive(tampered, public_key=self.signer.public_key(), now=102)

    def test_success_has_at_most_one_automatic_attempt(self) -> None:
        self.receive()
        sender = CountingSender()
        coordinator = SenderCoordinator(self.ledger, sender)
        first = coordinator.attempt_once("frame-001", now=101)
        second = coordinator.attempt_once("frame-001", now=102)
        self.assertEqual(first.state, SenderState.DELIVERED)
        self.assertEqual(second, first)
        self.assertEqual(len(sender.frames), 1)

    def test_ambiguous_failure_becomes_unknown_and_never_retries(self) -> None:
        self.receive()
        sender = CountingSender(fail=True)
        coordinator = SenderCoordinator(self.ledger, sender)
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            coordinator.attempt_once("frame-001", now=101)
        self.assertEqual(self.ledger.lookup("frame-001").state, SenderState.UNKNOWN)  # type: ignore[union-attr]
        coordinator.attempt_once("frame-001", now=102)
        self.assertEqual(len(sender.frames), 1)

    def test_restart_converts_incomplete_attempt_to_unknown_without_send(self) -> None:
        self.receive()
        self.assertEqual(
            self.ledger.begin_attempt("frame-001", now=101).state,  # type: ignore[union-attr]
            SenderState.ATTEMPT_STARTED,
        )
        self.ledger.close()
        self.ledger = SenderLedger(self.path)
        self.assertEqual(self.ledger.recover_after_restart(now=102), 1)
        sender = CountingSender()
        record = SenderCoordinator(self.ledger, sender).attempt_once("frame-001", now=103)
        self.assertEqual(record.state, SenderState.UNKNOWN)
        self.assertEqual(sender.frames, [])

    def test_capacity_rejects_without_evicting_prior_send_history(self) -> None:
        self.receive()
        second, second_signer = signed_frame(frame_id="frame-002")
        self.ledger.receive(second, public_key=second_signer.public_key(), now=101)
        third, third_signer = signed_frame(frame_id="frame-003")
        with self.assertRaisesRegex(SenderLedgerError, "capacity"):
            self.ledger.receive(third, public_key=third_signer.public_key(), now=102)
        self.assertIsNotNone(self.ledger.lookup("frame-001"))

    def test_main_thread_construction_serializes_worker_requests_and_close(self) -> None:
        barrier = threading.Barrier(9)
        records: list[object] = []
        errors: list[BaseException] = []

        def run() -> None:
            try:
                barrier.wait()
                records.append(
                    self.ledger.receive(
                        self.signed,
                        public_key=self.signer.public_key(),
                        now=100,
                    )
                )
            except BaseException as error:
                errors.append(error)

        workers = [threading.Thread(target=run) for _ in range(8)]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join(timeout=2)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(errors, [])
        self.assertEqual(len(records), 8)
        self.assertTrue(all(record == records[0] for record in records))
        self.ledger.close()
        self.ledger.close()
        with self.assertRaisesRegex(SenderLedgerError, "closed"):
            self.ledger.lookup("frame-001")


if __name__ == "__main__":
    unittest.main()

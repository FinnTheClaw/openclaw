from __future__ import annotations

import tempfile
import unittest
import hashlib
from pathlib import Path

from functional_finn_authority.release_ledger import (
    CandidateBinding,
    ReleaseLedger,
    ReleaseLedgerError,
    ReleaseState,
)

from .support import signed_frame


def binding(**overrides: object) -> CandidateBinding:
    payload = b'{"message":"Observed fact."}'
    values: dict[str, object] = {
        "candidate_id": "candidate-1",
        "turn_ticket": "turn-1",
        "revision": 0,
        "ingress_id": "ingress-001",
        "candidate_digest": hashlib.sha256(payload).hexdigest(),
        "candidate_payload": payload,
        "accepted_at": 100,
    }
    values.update(overrides)
    return CandidateBinding(**values)  # type: ignore[arg-type]


class ReleaseLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "release.sqlite"
        self.ledger = ReleaseLedger(self.path, max_records=2)

    def tearDown(self) -> None:
        self.ledger.close()
        self.temporary.cleanup()

    def test_candidate_acceptance_is_exactly_once_and_conflicts_fail(self) -> None:
        first = self.ledger.accept(binding())
        replay = self.ledger.accept(binding())
        self.assertEqual(first, replay)
        self.assertEqual(first.state, ReleaseState.RECEIVED)
        for changed in (
            {"candidate_digest": "d" * 64},
            {"candidate_id": "candidate-other"},
            {"turn_ticket": "turn-other"},
        ):
            with self.subTest(changed=changed), self.assertRaises(ReleaseLedgerError):
                self.ledger.accept(binding(**changed))

    def test_only_one_revision_is_admitted(self) -> None:
        self.ledger.accept(binding())
        self.assertEqual(
            self.ledger.require_revision("candidate-1", now=101).state,
            ReleaseState.REVISION_REQUIRED,
        )
        revised = self.ledger.accept(
            binding(candidate_id="candidate-2", revision=1)
        )
        self.assertEqual(revised.revision, 1)
        with self.assertRaises(ReleaseLedgerError):
            self.ledger.accept(binding(candidate_id="candidate-3", revision=2))

    def test_signed_frame_and_sender_outcome_are_immutable(self) -> None:
        self.ledger.accept(binding())
        self.ledger.record_validated("candidate-1", evidence_set_digest="e" * 64, now=101)
        signed, _signer = signed_frame()
        stored = self.ledger.commit_signed_frame(
            "candidate-1",
            signed,
            expected_candidate_digest=binding().candidate_digest,
            expected_message="Observed fact.",
            now=102,
        )
        self.assertEqual(stored.state, ReleaseState.FRAME_SIGNED)
        self.assertEqual(self.ledger.commit_signed_frame(
            "candidate-1",
            signed,
            expected_candidate_digest=binding().candidate_digest,
            expected_message="Observed fact.",
            now=103,
        ), stored)
        other, _ = signed_frame(frame_id="frame-other")
        with self.assertRaises(ReleaseLedgerError):
            self.ledger.commit_signed_frame(
                "candidate-1",
                other,
                expected_candidate_digest=binding().candidate_digest,
                expected_message="Observed fact.",
                now=103,
            )
        delivered = self.ledger.record_sender_outcome(
            "candidate-1", delivered=True, message_id="signal-message-1", now=104
        )
        self.assertEqual(delivered.state, ReleaseState.DELIVERED)
        self.assertEqual(
            self.ledger.record_sender_outcome(
                "candidate-1", delivered=True, message_id="signal-message-1", now=105
            ),
            delivered,
        )

    def test_capacity_rejects_instead_of_evicting_idempotency_rows(self) -> None:
        self.ledger.accept(binding())
        self.ledger.accept(
            binding(candidate_id="candidate-2", turn_ticket="turn-2")
        )
        with self.assertRaisesRegex(ReleaseLedgerError, "capacity"):
            self.ledger.accept(
                binding(candidate_id="candidate-3", turn_ticket="turn-3")
            )
        self.assertIsNotNone(self.ledger.lookup("candidate-1"))


if __name__ == "__main__":
    unittest.main()

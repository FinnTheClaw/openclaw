from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from functional_finn_authority.ingress_ledger import (
    IngressLedger,
    IngressLedgerError,
    IngressObservation,
)

from .support import sample_frame


def observation(**overrides: object) -> IngressObservation:
    values: dict[str, object] = {
        "ingress_id": "ingress-001",
        "account_id": "finn-signal",
        "source_id": "signal-source-1",
        "source_kind": "uuid",
        "conversation_id": "conversation-1",
        "conversation_kind": "direct",
        "reply_destination": "trusted-recipient-opaque-1",
        "sequence": 7,
        "received_at": 1_723_700_000,
        "content": "Observed fact.",
    }
    values.update(overrides)
    return IngressObservation(**values)  # type: ignore[arg-type]


class IngressLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "ingress.sqlite"
        self.ledger = IngressLedger(self.path, max_records=2)

    def tearDown(self) -> None:
        self.ledger.close()
        self.temporary.cleanup()

    def test_ingress_is_exactly_bound_and_replay_conflicts_fail(self) -> None:
        first = self.ledger.ingest(observation())
        self.assertEqual(self.ledger.ingest(observation()), first)
        self.assertEqual(first.content_digest, "4c454d071f2ff6944f3de4ee8d0a5aef1ecc7863ba2d9ca359f166128c501cbb")
        for changed in (
            {"content": "Different."},
            {"reply_destination": "attacker-selected"},
            {"account_id": "other-account"},
        ):
            with self.subTest(changed=changed), self.assertRaises(IngressLedgerError):
                self.ledger.ingest(observation(**changed))

    def test_sequence_conflict_and_capacity_reject_without_eviction(self) -> None:
        self.ledger.ingest(observation())
        with self.assertRaisesRegex(IngressLedgerError, "sequence"):
            self.ledger.ingest(observation(ingress_id="ingress-002", content="Second."))
        self.ledger.ingest(observation(ingress_id="ingress-002", sequence=8, content="Second."))
        with self.assertRaisesRegex(IngressLedgerError, "capacity"):
            self.ledger.ingest(observation(ingress_id="ingress-003", sequence=9, content="Third."))
        self.assertIsNotNone(self.ledger.lookup("ingress-001"))

    def test_destination_is_hidden_from_views_and_frame_binding_is_exact(self) -> None:
        view = self.ledger.ingest(observation())
        self.assertNotIn("destination", vars(view))
        frame = sample_frame(
            ingress_id=view.ingress_id,
            destination_binding_id=view.binding_id,
            account_id=view.account_id,
            turn_sequence=view.sequence,
        )
        bound = self.ledger.bind_frame(frame)
        self.assertEqual(bound.reply_destination, "trusted-recipient-opaque-1")
        for changed in (
            {"destination_binding_id": "binding:" + "0" * 64},
            {"account_id": "other-account"},
            {"turn_sequence": 8},
            {"ingress_id": "ingress-unknown"},
        ):
            with self.subTest(changed=changed), self.assertRaises(IngressLedgerError):
                self.ledger.bind_frame(replace(frame, **changed))

    def test_restart_preserves_content_binding_and_pull_order(self) -> None:
        first = self.ledger.ingest(observation())
        second = self.ledger.ingest(observation(ingress_id="ingress-002", sequence=8, content="Second."))
        self.ledger.close()
        self.ledger = IngressLedger(self.path, max_records=2)
        self.assertEqual(self.ledger.lookup(first.ingress_id), first)
        self.assertEqual(self.ledger.pull(after_ordinal=first.ordinal, limit=10), (second,))


if __name__ == "__main__":
    unittest.main()

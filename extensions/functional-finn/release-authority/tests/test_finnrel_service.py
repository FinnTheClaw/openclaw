from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
import hashlib
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from functional_finn_authority.finnrel_service import FinnrelApplication
from functional_finn_authority.finnsig_service import FinnsigApplication
from functional_finn_authority.ingress_ledger import BoundDelivery, IngressLedger
from functional_finn_authority.protocol import (
    AtomicClaim,
    CandidateSubmit,
    CandidateRelease,
    EvidenceReference,
    SendResultMessage,
    SendSignedFrame,
    request_document,
)
from functional_finn_authority.raw_framing import canonical_json_bytes
from functional_finn_authority.release_ledger import ReleaseLedger, ReleaseState
from functional_finn_authority.sender_ledger import SendResult, SenderLedger
from functional_finn_authority.signing import FrameSigner, SignedFrame

from .test_ingress_ledger import observation


class AlwaysSupport:
    def supports(self, _support: str, _claim: str) -> bool:
        return True


class SignalProbe:
    def __init__(self) -> None:
        self.calls: list[tuple[BoundDelivery, str]] = []

    def send_text(self, target: BoundDelivery, message: str) -> SendResult:
        self.calls.append((target, message))
        return SendResult("signal-message-1")


class UnknownSignalProbe(SignalProbe):
    def send_text(self, target: BoundDelivery, message: str) -> SendResult:
        self.calls.append((target, message))
        raise RuntimeError("transport outcome is unknown")


class IngressClient:
    def __init__(self, ledger: IngressLedger) -> None:
        self.ledger = ledger

    def lookup(self, ingress_id: str):
        return self.ledger.lookup(ingress_id)


class SenderClient:
    def __init__(self, app: FinnsigApplication, *, fail_after_send: bool = False) -> None:
        self.app = app
        self.fail_after_send = fail_after_send

    def send(self, request_id: str, signed: SignedFrame) -> SendResultMessage:
        result = self.app.handle_release(request_document(SendSignedFrame(request_id, signed)))
        if self.fail_after_send:
            self.fail_after_send = False
            raise RuntimeError("controller crashed after sender commit")
        return SendResultMessage(
            request_id=result["requestId"],
            frame_id=result["frameId"],
            state=result["state"],
            message_id=result["messageId"],
        )


def factual(**changes: object) -> CandidateSubmit:
    reference = EvidenceReference(
        kind="signal_ingress",
        ingress_id="ingress-001",
        start_byte=0,
        end_byte=14,
        quote="Observed fact.",
        receipt_id=None,
    )
    values: dict[str, object] = {
        "request_id": "candidate-request-1",
        "candidate_id": "candidate-1",
        "turn_ticket": "turn-1",
        "revision": 0,
        "ingress_id": "ingress-001",
        "binding_id": "binding:" + hashlib.sha256(canonical_json_bytes({
            "accountId": "finn-signal",
            "conversationId": "conversation-1",
            "conversationKind": "direct",
            "replyDestination": "trusted-recipient-opaque-1",
            "sourceId": "signal-source-1",
            "sourceKind": "uuid",
        })).hexdigest(),
        "response_class": "factual",
        "message": "Observed fact.",
        "claims": (AtomicClaim("claim-1", "Observed fact.", (reference,)),),
    }
    values.update(changes)
    return CandidateSubmit(**values)  # type: ignore[arg-type]


class FinnrelServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.release_path = root / "release.sqlite"
        self.release = ReleaseLedger(self.release_path)
        self.ingress = IngressLedger(root / "ingress.sqlite")
        self.sender = SenderLedger(root / "sender.sqlite")
        self.ingress.ingest(observation())
        self.signer = FrameSigner(Ed25519PrivateKey.generate())
        self.probe = SignalProbe()
        self.finnsig = FinnsigApplication(
            ingress=self.ingress,
            sender_ledger=self.sender,
            physical_sender=self.probe,
            release_public_key=self.signer.public_key(),
            release_key_id="release-key-2026-08",
            now=lambda: 1_723_700_100,
        )
        self.sender_client = SenderClient(self.finnsig)
        self.app = self.application(self.sender_client)

    def tearDown(self) -> None:
        self.release.close()
        self.ingress.close()
        self.sender.close()
        self.temporary.cleanup()

    def application(self, sender_client: SenderClient) -> FinnrelApplication:
        return FinnrelApplication(
            ledger=self.release,
            signer=self.signer,
            key_id="release-key-2026-08",
            ingress_client=IngressClient(self.ingress),
            sender_client=sender_client,
            now=lambda: 1_723_700_100,
            support_gate=AlwaysSupport(),
        )

    def validate(self, request: CandidateSubmit) -> dict[str, object]:
        return self.app.handle_openclaw(request_document(request))

    def release_candidate(self, request: CandidateSubmit) -> dict[str, object]:
        candidate = request_document(request)["candidate"]
        digest = hashlib.sha256(canonical_json_bytes(candidate)).hexdigest()
        return self.app.handle_openclaw(request_document(CandidateRelease(
            "release-" + request.request_id,
            request.candidate_id,
            request.turn_ticket,
            request.revision,
            digest,
            request.message,
        )))

    def test_factual_candidate_derives_destination_and_is_idempotent(self) -> None:
        self.assertEqual(self.validate(factual())["status"], "validated")
        self.assertEqual(self.probe.calls, [])
        first = self.release_candidate(factual())
        second = self.release_candidate(factual())
        self.assertEqual(first["status"], "delivered")
        self.assertEqual(second["status"], "delivered")
        self.assertEqual(len(self.probe.calls), 1)
        self.assertEqual(self.probe.calls[0][0].reply_destination, "trusted-recipient-opaque-1")

    def test_tool_evidence_fails_closed_after_exactly_one_revision(self) -> None:
        tool = replace(
            factual().claims[0].evidence[0],
            kind="tool_observation",
            receipt_id="plugin-asserted-receipt",
        )
        first = factual(claims=(AtomicClaim("claim-1", "Observed fact.", (tool,)),))
        second = factual(
            request_id="candidate-request-2",
            candidate_id="candidate-2",
            revision=1,
            claims=(AtomicClaim("claim-1", "Observed fact.", (tool,)),),
        )
        self.assertEqual(self.validate(first)["status"], "revision_required")
        self.assertEqual(self.validate(second)["status"], "abstained")
        self.assertEqual(self.probe.calls, [])

    def test_revision_requires_same_prior_turn_and_ingress(self) -> None:
        orphan = factual(candidate_id="candidate-orphan", turn_ticket="orphan-turn", revision=1)
        self.assertEqual(self.validate(orphan)["status"], "denied")
        invalid = factual(message="Unsupported.")
        self.assertEqual(self.validate(invalid)["status"], "revision_required")
        wrong_ingress = factual(
            request_id="candidate-request-2",
            candidate_id="candidate-2",
            revision=1,
            ingress_id="ingress-other",
        )
        self.assertEqual(self.validate(wrong_ingress)["status"], "denied")

    def test_nonfactual_acknowledgement_is_a_closed_mechanical_class(self) -> None:
        accepted = factual(
            candidate_id="ack-1",
            turn_ticket="ack-turn-1",
            response_class="non_factual_ack",
            message="Acknowledged.",
            claims=(),
        )
        rejected = factual(
            request_id="ack-request-2",
            candidate_id="ack-2",
            turn_ticket="ack-turn-2",
            response_class="non_factual_ack",
            message="Acknowledged, the system is healthy.",
            claims=(),
        )
        self.assertEqual(self.validate(accepted)["status"], "validated")
        self.assertEqual(self.probe.calls, [])
        self.assertEqual(self.release_candidate(accepted)["status"], "delivered")
        self.assertEqual(self.validate(rejected)["status"], "denied")

    def test_factual_message_must_equal_ordered_claims_without_filler(self) -> None:
        changed = factual(message="Observed fact.\nUnsupported filler.")
        self.assertEqual(self.validate(changed)["status"], "revision_required")
        self.assertEqual(self.probe.calls, [])

    def test_post_validation_mutation_cannot_sign_or_send(self) -> None:
        request = factual()
        self.assertEqual(self.validate(request)["status"], "validated")
        candidate = request_document(request)["candidate"]
        digest = hashlib.sha256(canonical_json_bytes(candidate)).hexdigest()
        changed = CandidateRelease(
            "release-mutated",
            request.candidate_id,
            request.turn_ticket,
            request.revision,
            digest,
            "Mutated after validation.",
        )
        with self.assertRaisesRegex(Exception, "message"):
            self.app.handle_openclaw(request_document(changed))
        self.assertEqual(self.release.lookup(request.candidate_id).state, ReleaseState.VALIDATED)  # type: ignore[union-attr]
        self.assertEqual(self.probe.calls, [])

    def test_unknown_release_never_automatically_resends(self) -> None:
        self.probe = UnknownSignalProbe()
        self.finnsig = FinnsigApplication(
            ingress=self.ingress,
            sender_ledger=self.sender,
            physical_sender=self.probe,
            release_public_key=self.signer.public_key(),
            release_key_id="release-key-2026-08",
            now=lambda: 1_723_700_100,
        )
        self.app = self.application(SenderClient(self.finnsig))
        request = factual()
        self.assertEqual(self.validate(request)["status"], "validated")
        self.assertEqual(self.release_candidate(request)["status"], "unknown")
        self.assertEqual(self.release_candidate(request)["status"], "unknown")
        self.assertEqual(len(self.probe.calls), 1)

    def test_restart_after_sender_commit_adopts_without_second_send(self) -> None:
        crashing = SenderClient(self.finnsig, fail_after_send=True)
        self.app = self.application(crashing)
        self.assertEqual(self.validate(factual())["status"], "validated")
        with self.assertRaisesRegex(RuntimeError, "crashed"):
            self.release_candidate(factual())
        self.assertEqual(self.release.lookup("candidate-1").state, ReleaseState.FRAME_SIGNED)  # type: ignore[union-attr]
        self.release.close()
        self.release = ReleaseLedger(self.release_path)
        self.app = self.application(SenderClient(self.finnsig))
        result = self.release_candidate(factual())
        self.assertEqual(result["status"], "delivered")
        self.assertEqual(len(self.probe.calls), 1)


if __name__ == "__main__":
    unittest.main()

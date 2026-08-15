"""_finnrel candidate validation, one-revision policy, signing, and dispatch."""

from __future__ import annotations

import hashlib
import json
import socket
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from .canonical_frame import ReleaseFrame, encode_release_frame
from .evidence_policy import EvidencePolicyError, EvidenceRecord, EvidenceSpan, validate_evidence
from .peer_credentials import PeerUidPolicy
from .protocol import (
    CandidateResult,
    CandidateRelease,
    CandidateSubmit,
    IngressView,
    PROTOCOL_SCHEMA,
    SendResultMessage,
    parse_request,
    request_document,
    response_document,
)
from .raw_framing import canonical_json_bytes
from .release_ledger import CandidateBinding, ReleaseLedger, ReleaseRecord, ReleaseState
from .signing import FrameSigner, SignedFrame
from .semantic_support import RejectingSupportGate, SemanticSupportError
from .unix_server import handle_attested_request

ACK_MESSAGES = frozenset(("Acknowledged.", "Understood.", "Thanks."))
ABSTENTION_MESSAGE = "I don't have enough verified evidence to answer."


class FinnrelServiceError(RuntimeError):
    pass


class IngressEvidenceClient(Protocol):
    def lookup(self, ingress_id: str) -> IngressView | None: ...


class FrameSubmitClient(Protocol):
    def send(self, request_id: str, signed: SignedFrame) -> SendResultMessage: ...


@dataclass(frozen=True)
class ValidationOutcome:
    ingress: IngressView
    evidence_digest: str


class FinnrelApplication:
    def __init__(
        self,
        *,
        ledger: ReleaseLedger,
        signer: FrameSigner,
        key_id: str,
        ingress_client: IngressEvidenceClient,
        sender_client: FrameSubmitClient,
        now: Callable[[], int],
        ingress_freshness_seconds: int = 86_400,
        frame_ttl_seconds: int = 300,
        support_gate: Any | None = None,
    ) -> None:
        if ingress_freshness_seconds < 1 or frame_ttl_seconds < 1:
            raise ValueError("freshness and frame TTL must be positive")
        self._ledger = ledger
        self._signer = signer
        self._key_id = key_id
        self._ingress_client = ingress_client
        self._sender_client = sender_client
        self._now = now
        self._freshness = ingress_freshness_seconds
        self._frame_ttl = frame_ttl_seconds
        self._support_gate = support_gate or RejectingSupportGate()

    def handle_openclaw(self, value: Any) -> dict[str, Any]:
        request = parse_request(value)
        if isinstance(request, CandidateSubmit):
            return response_document(self._validate_candidate(request))
        if isinstance(request, CandidateRelease):
            return response_document(self._release_candidate(request))
        raise FinnrelServiceError("_openclaw may only validate or release response candidates")

    def _validate_candidate(self, request: CandidateSubmit) -> CandidateResult:
        candidate = request_document(request)["candidate"]
        candidate_payload = canonical_json_bytes(candidate)
        candidate_digest = hashlib.sha256(candidate_payload).hexdigest()
        now = self._now()
        record = self._ledger.accept(
            CandidateBinding(
                candidate_id=request.candidate_id,
                turn_ticket=request.turn_ticket,
                revision=request.revision,
                ingress_id=request.ingress_id,
                candidate_digest=candidate_digest,
                candidate_payload=candidate_payload,
                accepted_at=now,
            )
        )
        if record.state is not ReleaseState.RECEIVED:
            if record.state in (ReleaseState.VALIDATED, ReleaseState.FRAME_SIGNED):
                return CandidateResult(
                    request_id=request.request_id,
                    candidate_id=record.candidate_id,
                    status="validated",
                    frame_id=record.frame_id,
                    message_id=None,
                )
            return self._result(request.request_id, record)
        if request.revision == 1:
            prior = self._ledger.lookup_turn_revision(request.turn_ticket, 0)
            if (
                prior is None
                or prior.state is not ReleaseState.REVISION_REQUIRED
                or prior.ingress_id != request.ingress_id
            ):
                denied = self._ledger.record_denied(request.candidate_id, now=now)
                return self._result(request.request_id, denied)
        if (
            request.response_class == "factual"
            and not request.claims
            and request.message == ABSTENTION_MESSAGE
        ):
            abstained = self._ledger.record_abstained(request.candidate_id, now=now)
            return self._result(request.request_id, abstained)
        try:
            outcome = self._validate(request, now=now)
        except (EvidencePolicyError, FinnrelServiceError):
            if request.response_class == "non_factual_ack":
                denied = self._ledger.record_denied(request.candidate_id, now=now)
                return self._result(request.request_id, denied)
            if request.revision == 0:
                pending = self._ledger.require_revision(request.candidate_id, now=now)
                return self._result(request.request_id, pending)
            abstained = self._ledger.record_abstained(request.candidate_id, now=now)
            return self._result(request.request_id, abstained)
        validated = self._ledger.record_validated(
            request.candidate_id,
            evidence_set_digest=outcome.evidence_digest,
            now=now,
        )
        return self._result(request.request_id, validated)

    def _release_candidate(self, request: CandidateRelease) -> CandidateResult:
        record = self._ledger.lookup(request.candidate_id)
        if record is None:
            raise FinnrelServiceError("candidate escrow is unavailable")
        if (
            record.turn_ticket != request.turn_ticket
            or record.revision != request.revision
            or record.candidate_digest != request.candidate_digest
        ):
            raise FinnrelServiceError("candidate release binding is invalid")
        replay = self._terminal_result(request.request_id, record)
        if replay is not None:
            return replay
        if record.candidate_payload is None or record.evidence_set_digest is None:
            raise FinnrelServiceError("validated candidate escrow is incomplete")
        try:
            candidate = json.loads(record.candidate_payload.decode("utf-8"))
            validated = parse_request(
                {
                    "candidate": candidate,
                    "op": "candidate.validate",
                    "requestId": request.request_id,
                    "schema": PROTOCOL_SCHEMA,
                }
            )
        except (UnicodeDecodeError, ValueError, TypeError) as error:
            raise FinnrelServiceError("validated candidate escrow is corrupt") from error
        if not isinstance(validated, CandidateSubmit) or validated.message != request.message:
            raise FinnrelServiceError("candidate release message binding is invalid")
        ingress = self._ingress_client.lookup(validated.ingress_id)
        if ingress is None or ingress.binding_id != validated.binding_id:
            raise FinnrelServiceError("candidate ingress binding is unavailable")
        now = self._now()
        frame_id = "frame:" + hashlib.sha256(
            f"{validated.candidate_id}:{record.candidate_digest}".encode("utf-8")
        ).hexdigest()
        frame = ReleaseFrame(
            frame_id=frame_id,
            key_id=self._key_id,
            ingress_id=ingress.ingress_id,
            destination_binding_id=ingress.binding_id,
            account_id=ingress.account_id,
            turn_sequence=ingress.sequence,
            revision=validated.revision,
            message=validated.message,
            quote_ingress_id=ingress.ingress_id,
            issued_at=now,
            expires_at=now + self._frame_ttl,
            envelope_digest=record.candidate_digest,
            evidence_set_digest=record.evidence_set_digest,
        )
        signed = self._signer.sign(encode_release_frame(frame))
        signed_record = self._ledger.commit_signed_frame(
            request.candidate_id,
            signed,
            expected_candidate_digest=request.candidate_digest,
            expected_message=request.message,
            now=now,
        )
        return self._dispatch(request.request_id, signed_record, signed, now=now)

    def _validate(self, request: CandidateSubmit, *, now: int) -> ValidationOutcome:
        ingress = self._ingress_client.lookup(request.ingress_id)
        if ingress is None:
            raise FinnrelServiceError("candidate ingress is unknown")
        if request.binding_id != ingress.binding_id:
            raise FinnrelServiceError("candidate ingress binding is invalid")
        if request.response_class == "non_factual_ack":
            if request.message not in ACK_MESSAGES or request.claims:
                raise FinnrelServiceError("non-factual acknowledgement is not mechanically valid")
            return ValidationOutcome(ingress, hashlib.sha256(b"[]").hexdigest())
        if not request.claims:
            if request.message == ABSTENTION_MESSAGE:
                return ValidationOutcome(ingress, hashlib.sha256(b"[]").hexdigest())
            raise FinnrelServiceError("factual candidate has no atomic claims")
        if request.message != "\n".join(claim.text for claim in request.claims):
            raise FinnrelServiceError("factual message must equal its ordered atomic claims")
        scope_id = f"signal:{ingress.account_id}:{ingress.conversation_id}"
        for claim in request.claims:
            if not claim.evidence:
                raise FinnrelServiceError("claim lacks evidence")
            support: list[str] = []
            for reference in claim.evidence:
                if reference.kind == "tool_observation":
                    raise FinnrelServiceError("candidate-supplied tool evidence is not authoritative")
                if reference.ingress_id != request.ingress_id:
                    raise FinnrelServiceError("claim references a different ingress")
                selected = validate_evidence(
                    record=EvidenceRecord(
                        evidence_id=ingress.ingress_id,
                        scope_id=scope_id,
                        content=ingress.content,
                        observed_at=ingress.received_at,
                        freshness_until=ingress.received_at + self._freshness,
                        source_kind="signal_ingress",
                        attestation_kind="finnsig_ingress",
                        attestation_id=ingress.binding_id,
                        state="current",
                    ),
                    span=EvidenceSpan(
                        evidence_id=reference.ingress_id,
                        start_byte=reference.start_byte,
                        end_byte=reference.end_byte,
                        quote=reference.quote,
                    ),
                    expected_scope_id=scope_id,
                    now=now,
                )
                support.append(selected)
            try:
                if not self._support_gate.supports("\n".join(support), claim.text):
                    raise FinnrelServiceError("claim lacks semantic support")
            except SemanticSupportError as error:
                raise FinnrelServiceError("semantic support is unavailable") from error
        evidence = [
            {
                "claimId": claim.claim_id,
                "evidence": [
                    {
                        "endByte": item.end_byte,
                        "ingressId": item.ingress_id,
                        "kind": item.kind,
                        "quote": item.quote,
                        "startByte": item.start_byte,
                    }
                    for item in claim.evidence
                ],
            }
            for claim in request.claims
        ]
        return ValidationOutcome(
            ingress,
            hashlib.sha256(canonical_json_bytes(evidence)).hexdigest(),
        )

    def _dispatch(
        self,
        request_id: str,
        record: ReleaseRecord,
        signed: SignedFrame,
        *,
        now: int,
    ) -> CandidateResult:
        result = self._sender_client.send("send:" + request_id, signed)
        delivered = result.state == "DELIVERED"
        settled = self._ledger.record_sender_outcome(
            record.candidate_id,
            delivered=delivered,
            message_id=result.message_id,
            now=now,
        )
        return self._result(request_id, settled)

    def _terminal_result(self, request_id: str, record: ReleaseRecord) -> CandidateResult | None:
        if record.state is ReleaseState.FRAME_SIGNED:
            if record.frame_payload is None or record.frame_signature is None:
                raise FinnrelServiceError("signed frame record is incomplete")
            return self._dispatch(
                request_id,
                record,
                SignedFrame(record.frame_payload, record.frame_signature),
                now=self._now(),
            )
        if record.state in (ReleaseState.RECEIVED, ReleaseState.VALIDATED):
            return None
        return self._result(request_id, record)

    @staticmethod
    def _result(request_id: str, record: ReleaseRecord) -> CandidateResult:
        status = {
            ReleaseState.VALIDATED: "validated",
            ReleaseState.REVISION_REQUIRED: "revision_required",
            ReleaseState.DELIVERED: "delivered",
            ReleaseState.UNKNOWN: "unknown",
            ReleaseState.ABSTAINED: "abstained",
            ReleaseState.DENIED: "denied",
        }.get(record.state)
        if status is None:
            raise FinnrelServiceError("candidate is not in a reportable state")
        return CandidateResult(
            request_id=request_id,
            candidate_id=record.candidate_id,
            status=status,
            frame_id=record.frame_id,
            message_id=record.message_id,
        )

    def serve_openclaw_once(self, connection: socket.socket, *, expected_uid: int) -> None:
        handle_attested_request(
            connection,
            peer_policy=PeerUidPolicy(expected_uid),
            handler=self.handle_openclaw,
        )

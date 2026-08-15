"""Closed canonical IPC protocol shared by _openclaw, _finnrel, and _finnsig."""

from __future__ import annotations

import base64
import re
import unicodedata
from dataclasses import asdict, dataclass
from typing import Any, Literal, Union

from .raw_framing import canonical_json_bytes
from .signing import SignedFrame

PROTOCOL_SCHEMA = "functional-finn.release-ipc.v1"
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_REQUEST_ID = 96
MAX_MESSAGE_CHARS = 3_500
MAX_CLAIMS = 32
MAX_EVIDENCE_PER_CLAIM = 16
MAX_PULL_LIMIT = 100


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class EvidenceReference:
    kind: Literal["signal_ingress", "tool_observation"]
    ingress_id: str
    start_byte: int
    end_byte: int
    quote: str
    receipt_id: str | None


@dataclass(frozen=True)
class AtomicClaim:
    claim_id: str
    text: str
    evidence: tuple[EvidenceReference, ...]


@dataclass(frozen=True)
class CandidateSubmit:
    request_id: str
    candidate_id: str
    turn_ticket: str
    revision: int
    ingress_id: str
    binding_id: str
    response_class: Literal["factual", "non_factual_ack"]
    message: str
    claims: tuple[AtomicClaim, ...]


@dataclass(frozen=True)
class CandidateRelease:
    request_id: str
    candidate_id: str
    turn_ticket: str
    revision: int
    candidate_digest: str
    message: str


@dataclass(frozen=True)
class SendSignedFrame:
    request_id: str
    signed_frame: SignedFrame


@dataclass(frozen=True)
class IngressPull:
    request_id: str
    after_ordinal: int
    limit: int


@dataclass(frozen=True)
class IngressLookup:
    request_id: str
    ingress_id: str


Request = Union[CandidateSubmit, CandidateRelease, SendSignedFrame, IngressPull, IngressLookup]


@dataclass(frozen=True)
class IngressView:
    ingress_id: str
    binding_id: str
    account_id: str
    source_id: str
    source_kind: Literal["phone", "uuid"]
    conversation_id: str
    conversation_kind: Literal["direct", "group"]
    ordinal: int
    sequence: int
    received_at: int
    content_digest: str
    content: str


@dataclass(frozen=True)
class CandidateResult:
    request_id: str
    candidate_id: str
    status: Literal[
        "validated", "revision_required", "delivered", "unknown", "abstained", "denied"
    ]
    frame_id: str | None
    message_id: str | None


@dataclass(frozen=True)
class SendResultMessage:
    request_id: str
    frame_id: str
    state: Literal["DELIVERED", "UNKNOWN"]
    message_id: str | None


@dataclass(frozen=True)
class IngressPullResult:
    request_id: str
    records: tuple[IngressView, ...]


@dataclass(frozen=True)
class IngressLookupResult:
    request_id: str
    record: IngressView | None


Response = Union[CandidateResult, SendResultMessage, IngressPullResult, IngressLookupResult]


def _exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ProtocolError(f"{label} has unexpected or missing keys")
    return value


def _id(value: Any, label: str, *, request: bool = False) -> str:
    limit = MAX_REQUEST_ID if request else 128
    if not isinstance(value, str) or len(value) > limit or not ID_PATTERN.fullmatch(value):
        raise ProtocolError(f"{label} is invalid")
    return value


def _text(value: Any, label: str, *, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or unicodedata.normalize("NFC", value) != value
        or any(ord(char) < 0x20 and char not in "\n\t" for char in value)
    ):
        raise ProtocolError(f"{label} is invalid")
    return value


def _literal(value: Any, label: str, allowed: tuple[str, ...]) -> Any:
    if not isinstance(value, str) or value not in allowed:
        raise ProtocolError(f"{label} is invalid")
    return value


def _uint(
    value: Any,
    label: str,
    *,
    minimum: int = 0,
    maximum: int = 9_007_199_254_740_991,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ProtocolError(f"{label} is invalid")
    return value


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: Any, label: str, *, maximum: int) -> bytes:
    if not isinstance(value, str) or len(value) > maximum * 2:
        raise ProtocolError(f"{label} is invalid")
    try:
        decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (ValueError, TypeError) as error:
        raise ProtocolError(f"{label} is invalid") from error
    if len(decoded) > maximum or _b64(decoded) != value:
        raise ProtocolError(f"{label} is not canonical")
    return decoded


def request_document(request: Request) -> dict[str, Any]:
    if isinstance(request, CandidateSubmit):
        return {
            "op": "candidate.validate",
            "requestId": request.request_id,
            "schema": PROTOCOL_SCHEMA,
            "candidate": {
                "candidateId": request.candidate_id,
                "claims": [
                    {
                        "claimId": claim.claim_id,
                        "evidence": [
                            {
                                "endByte": item.end_byte,
                                "ingressId": item.ingress_id,
                                "kind": item.kind,
                                "quote": item.quote,
                                "receiptId": item.receipt_id,
                                "startByte": item.start_byte,
                            }
                            for item in claim.evidence
                        ],
                        "text": claim.text,
                    }
                    for claim in request.claims
                ],
                        "ingressId": request.ingress_id,
                        "bindingId": request.binding_id,
                "message": request.message,
                "responseClass": request.response_class,
                "revision": request.revision,
                "turnTicket": request.turn_ticket,
            },
        }
    if isinstance(request, CandidateRelease):
        return {
            "candidateDigest": request.candidate_digest,
            "candidateId": request.candidate_id,
            "message": request.message,
            "op": "candidate.release",
            "requestId": request.request_id,
            "revision": request.revision,
            "schema": PROTOCOL_SCHEMA,
            "turnTicket": request.turn_ticket,
        }
    if isinstance(request, SendSignedFrame):
        return {
            "op": "frame.send",
            "requestId": request.request_id,
            "schema": PROTOCOL_SCHEMA,
            "frame": {"payload": _b64(request.signed_frame.payload), "signature": request.signed_frame.signature},
        }
    if isinstance(request, IngressPull):
        return {
            "afterOrdinal": request.after_ordinal,
            "limit": request.limit,
            "op": "ingress.pull",
            "requestId": request.request_id,
            "schema": PROTOCOL_SCHEMA,
        }
    return {
        "ingressId": request.ingress_id,
        "op": "ingress.lookup",
        "requestId": request.request_id,
        "schema": PROTOCOL_SCHEMA,
    }


def request_bytes(request: Request) -> bytes:
    document = request_document(request)
    parse_request(document)
    return canonical_json_bytes(document)


def parse_request(value: Any) -> Request:
    if not isinstance(value, dict) or value.get("schema") != PROTOCOL_SCHEMA:
        raise ProtocolError("request schema is invalid")
    operation = value.get("op")
    if operation == "candidate.validate":
        root = _exact(value, {"schema", "op", "requestId", "candidate"}, "candidate request")
        candidate = _exact(
            root["candidate"],
            {
                "bindingId", "candidateId", "turnTicket", "revision", "ingressId",
                "responseClass", "message", "claims",
            },
            "candidate",
        )
        claims_value = candidate["claims"]
        if not isinstance(claims_value, list) or len(claims_value) > MAX_CLAIMS:
            raise ProtocolError("candidate claims are invalid")
        claims: list[AtomicClaim] = []
        for raw_claim in claims_value:
            claim = _exact(raw_claim, {"claimId", "text", "evidence"}, "claim")
            evidence_value = claim["evidence"]
            if not isinstance(evidence_value, list) or len(evidence_value) > MAX_EVIDENCE_PER_CLAIM:
                raise ProtocolError("claim evidence is invalid")
            evidence: list[EvidenceReference] = []
            for raw_item in evidence_value:
                item = _exact(
                    raw_item,
                    {"kind", "ingressId", "startByte", "endByte", "quote", "receiptId"},
                    "evidence reference",
                )
                kind = item["kind"]
                if kind not in ("signal_ingress", "tool_observation"):
                    raise ProtocolError("evidence kind is invalid")
                receipt = item["receiptId"]
                if receipt is not None:
                    receipt = _id(receipt, "receiptId")
                evidence.append(
                    EvidenceReference(
                        kind=kind,
                        ingress_id=_id(item["ingressId"], "evidence ingressId"),
                        start_byte=_uint(item["startByte"], "startByte"),
                        end_byte=_uint(item["endByte"], "endByte"),
                        quote=_text(item["quote"], "evidence quote", maximum=2_000),
                        receipt_id=receipt,
                    )
                )
            claims.append(
                AtomicClaim(
                    claim_id=_id(claim["claimId"], "claimId"),
                    text=_text(claim["text"], "claim text", maximum=2_000),
                    evidence=tuple(evidence),
                )
            )
        response_class = candidate["responseClass"]
        if response_class not in ("factual", "non_factual_ack"):
            raise ProtocolError("response class is invalid")
        revision = _uint(candidate["revision"], "revision", maximum=1)
        return CandidateSubmit(
            request_id=_id(root["requestId"], "requestId", request=True),
            candidate_id=_id(candidate["candidateId"], "candidateId"),
            turn_ticket=_id(candidate["turnTicket"], "turnTicket"),
            revision=revision,
            ingress_id=_id(candidate["ingressId"], "ingressId"),
            binding_id=_id(candidate["bindingId"], "bindingId"),
            response_class=response_class,
            message=_text(candidate["message"], "message", maximum=MAX_MESSAGE_CHARS),
            claims=tuple(claims),
        )
    if operation == "candidate.release":
        root = _exact(
            value,
            {
                "schema", "op", "requestId", "candidateId", "turnTicket", "revision",
                "candidateDigest", "message",
            },
            "candidate release request",
        )
        digest = root["candidateDigest"]
        if not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest):
            raise ProtocolError("candidate digest is invalid")
        return CandidateRelease(
            request_id=_id(root["requestId"], "requestId", request=True),
            candidate_id=_id(root["candidateId"], "candidateId"),
            turn_ticket=_id(root["turnTicket"], "turnTicket"),
            revision=_uint(root["revision"], "revision", maximum=1),
            candidate_digest=digest,
            message=_text(root["message"], "message", maximum=MAX_MESSAGE_CHARS),
        )
    if operation == "frame.send":
        root = _exact(value, {"schema", "op", "requestId", "frame"}, "send request")
        frame = _exact(root["frame"], {"payload", "signature"}, "signed frame")
        signature = frame["signature"]
        if not isinstance(signature, str) or not 40 <= len(signature) <= 128:
            raise ProtocolError("frame signature is invalid")
        return SendSignedFrame(
            request_id=_id(root["requestId"], "requestId", request=True),
            signed_frame=SignedFrame(_unb64(frame["payload"], "frame payload", maximum=16_384), signature),
        )
    if operation == "ingress.pull":
        root = _exact(value, {"schema", "op", "requestId", "afterOrdinal", "limit"}, "pull request")
        return IngressPull(
            request_id=_id(root["requestId"], "requestId", request=True),
            after_ordinal=_uint(root["afterOrdinal"], "afterOrdinal"),
            limit=_uint(root["limit"], "limit", minimum=1, maximum=MAX_PULL_LIMIT),
        )
    if operation == "ingress.lookup":
        root = _exact(value, {"schema", "op", "requestId", "ingressId"}, "lookup request")
        return IngressLookup(
            request_id=_id(root["requestId"], "requestId", request=True),
            ingress_id=_id(root["ingressId"], "ingressId"),
        )
    raise ProtocolError("request operation is invalid")


def ingress_document(record: IngressView) -> dict[str, Any]:
    value = asdict(record)
    return {
        "accountId": value["account_id"],
        "bindingId": value["binding_id"],
        "content": value["content"],
        "contentDigest": value["content_digest"],
        "conversationId": value["conversation_id"],
        "conversationKind": value["conversation_kind"],
        "ingressId": value["ingress_id"],
        "ordinal": value["ordinal"],
        "receivedAt": value["received_at"],
        "sequence": value["sequence"],
        "sourceId": value["source_id"],
        "sourceKind": value["source_kind"],
    }


def response_document(response: Response) -> dict[str, Any]:
    if isinstance(response, CandidateResult):
        return {"candidateId": response.candidate_id, "frameId": response.frame_id, "messageId": response.message_id, "requestId": response.request_id, "schema": PROTOCOL_SCHEMA, "status": response.status}
    if isinstance(response, SendResultMessage):
        return {"frameId": response.frame_id, "messageId": response.message_id, "requestId": response.request_id, "schema": PROTOCOL_SCHEMA, "state": response.state}
    if isinstance(response, IngressPullResult):
        return {"records": [ingress_document(item) for item in response.records], "requestId": response.request_id, "schema": PROTOCOL_SCHEMA}
    return {"record": None if response.record is None else ingress_document(response.record), "requestId": response.request_id, "schema": PROTOCOL_SCHEMA}


def _parse_ingress(value: Any) -> IngressView:
    record = _exact(
        value,
        {
            "ingressId",
            "bindingId",
            "accountId",
            "sourceId",
            "sourceKind",
            "conversationId",
            "conversationKind",
            "ordinal",
            "sequence",
            "receivedAt",
            "contentDigest",
            "content",
        },
        "ingress record",
    )
    digest = record["contentDigest"]
    if not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest):
        raise ProtocolError("ingress content digest is invalid")
    return IngressView(
        ingress_id=_id(record["ingressId"], "ingressId"),
        binding_id=_id(record["bindingId"], "bindingId"),
        account_id=_id(record["accountId"], "accountId"),
        source_id=_id(record["sourceId"], "sourceId"),
        source_kind=_literal(record["sourceKind"], "sourceKind", ("phone", "uuid")),
        conversation_id=_id(record["conversationId"], "conversationId"),
        conversation_kind=_literal(
            record["conversationKind"], "conversationKind", ("direct", "group")
        ),
        ordinal=_uint(record["ordinal"], "ordinal", minimum=1),
        sequence=_uint(record["sequence"], "sequence", minimum=1),
        received_at=_uint(record["receivedAt"], "receivedAt", minimum=1),
        content_digest=digest,
        content=_text(record["content"], "content", maximum=65_536),
    )


def parse_response(value: Any) -> Response:
    if not isinstance(value, dict) or value.get("schema") != PROTOCOL_SCHEMA:
        raise ProtocolError("response schema is invalid")
    if "status" in value:
        root = _exact(
            value,
            {"schema", "requestId", "candidateId", "status", "frameId", "messageId"},
            "candidate response",
        )
        status = root["status"]
        if status not in (
            "validated", "revision_required", "delivered", "unknown", "abstained", "denied"
        ):
            raise ProtocolError("candidate status is invalid")
        return CandidateResult(
            request_id=_id(root["requestId"], "requestId", request=True),
            candidate_id=_id(root["candidateId"], "candidateId"),
            status=status,
            frame_id=None if root["frameId"] is None else _id(root["frameId"], "frameId"),
            message_id=None if root["messageId"] is None else _id(root["messageId"], "messageId"),
        )
    if "state" in value:
        root = _exact(
            value,
            {"schema", "requestId", "frameId", "state", "messageId"},
            "send response",
        )
        state = root["state"]
        if state not in ("DELIVERED", "UNKNOWN"):
            raise ProtocolError("sender state is invalid")
        return SendResultMessage(
            request_id=_id(root["requestId"], "requestId", request=True),
            frame_id=_id(root["frameId"], "frameId"),
            state=state,
            message_id=None if root["messageId"] is None else _id(root["messageId"], "messageId"),
        )
    if "records" in value:
        root = _exact(value, {"schema", "requestId", "records"}, "pull response")
        records = root["records"]
        if not isinstance(records, list) or len(records) > MAX_PULL_LIMIT:
            raise ProtocolError("pull response records are invalid")
        return IngressPullResult(
            request_id=_id(root["requestId"], "requestId", request=True),
            records=tuple(_parse_ingress(item) for item in records),
        )
    root = _exact(value, {"schema", "requestId", "record"}, "lookup response")
    return IngressLookupResult(
        request_id=_id(root["requestId"], "requestId", request=True),
        record=None if root["record"] is None else _parse_ingress(root["record"]),
    )

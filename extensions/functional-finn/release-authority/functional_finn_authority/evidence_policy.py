"""Independent evidence eligibility checks owned by _finnrel."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SourceKind = Literal[
    "signal_ingress",
    "authoritative_import",
    "verified_memory",
    "tool_observation",
]
AttestationKind = Literal[
    "finnsig_ingress",
    "root_import",
    "finnrel_memory",
    "external_tool_receipt",
    "openclaw_asserted",
]


class EvidencePolicyError(ValueError):
    pass


@dataclass(frozen=True)
class EvidenceRecord:
    evidence_id: str
    scope_id: str
    content: str
    observed_at: int
    freshness_until: int
    source_kind: SourceKind
    attestation_kind: AttestationKind
    attestation_id: str | None
    state: Literal["current", "superseded", "quarantined"]


@dataclass(frozen=True)
class EvidenceSpan:
    evidence_id: str
    start_byte: int
    end_byte: int
    quote: str


def validate_evidence(
    *,
    record: EvidenceRecord,
    span: EvidenceSpan,
    expected_scope_id: str,
    now: int,
) -> str:
    if record.evidence_id != span.evidence_id:
        raise EvidencePolicyError("evidence identity mismatch")
    if record.scope_id != expected_scope_id:
        raise EvidencePolicyError("evidence belongs to another scope")
    if record.state != "current":
        raise EvidencePolicyError("evidence is superseded or quarantined")
    if record.observed_at > now or record.freshness_until < now:
        raise EvidencePolicyError("evidence is not currently fresh")
    expected_attestation = {
        "signal_ingress": "finnsig_ingress",
        "authoritative_import": "root_import",
        "verified_memory": "finnrel_memory",
        "tool_observation": "external_tool_receipt",
    }[record.source_kind]
    if record.attestation_kind != expected_attestation or not record.attestation_id:
        if record.source_kind == "tool_observation":
            raise EvidencePolicyError("tool observation lacks externally verifiable provenance")
        raise EvidencePolicyError("evidence lacks its required external attestation")
    content = record.content.encode("utf-8")
    if (
        span.start_byte < 0
        or span.end_byte <= span.start_byte
        or span.end_byte > len(content)
    ):
        raise EvidencePolicyError("evidence span is out of range")
    try:
        selected = content[span.start_byte : span.end_byte].decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise EvidencePolicyError("evidence span splits a UTF-8 sequence") from error
    if selected != span.quote:
        raise EvidencePolicyError("evidence quote does not match exact UTF-8 bytes")
    return selected

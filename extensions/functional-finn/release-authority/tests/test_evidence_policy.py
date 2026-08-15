from __future__ import annotations

import unittest

from functional_finn_authority.evidence_policy import (
    EvidencePolicyError,
    EvidenceRecord,
    EvidenceSpan,
    validate_evidence,
)


def record(**overrides: object) -> EvidenceRecord:
    values: dict[str, object] = {
        "evidence_id": "e-1",
        "scope_id": "signal:finn:thread-1",
        "content": "Observed temperature is 20°C.",
        "observed_at": 100,
        "freshness_until": 200,
        "source_kind": "signal_ingress",
        "attestation_kind": "finnsig_ingress",
        "attestation_id": "ingress-receipt-1",
        "state": "current",
    }
    values.update(overrides)
    return EvidenceRecord(**values)  # type: ignore[arg-type]


def span() -> EvidenceSpan:
    content = record().content.encode("utf-8")
    quote = "temperature is 20°C"
    start = content.index(quote.encode("utf-8"))
    return EvidenceSpan("e-1", start, start + len(quote.encode("utf-8")), quote)


class EvidencePolicyTest(unittest.TestCase):
    def test_exact_fresh_attested_span_is_eligible(self) -> None:
        self.assertEqual(
            validate_evidence(
                record=record(), span=span(), expected_scope_id="signal:finn:thread-1", now=150
            ),
            "temperature is 20°C",
        )

    def test_tool_observation_requires_external_receipt(self) -> None:
        untrusted = record(source_kind="tool_observation", attestation_kind="openclaw_asserted")
        with self.assertRaisesRegex(EvidencePolicyError, "externally verifiable"):
            validate_evidence(
                record=untrusted, span=span(), expected_scope_id=untrusted.scope_id, now=150
            )
        trusted = record(
            source_kind="tool_observation",
            attestation_kind="external_tool_receipt",
            attestation_id="tool-host-receipt-7",
        )
        self.assertEqual(
            validate_evidence(record=trusted, span=span(), expected_scope_id=trusted.scope_id, now=150),
            span().quote,
        )

    def test_scope_freshness_state_and_exact_bytes_fail_closed(self) -> None:
        cases = (
            (record(), "signal:finn:other", 150, span()),
            (record(freshness_until=149), "signal:finn:thread-1", 150, span()),
            (record(state="quarantined"), "signal:finn:thread-1", 150, span()),
            (record(), "signal:finn:thread-1", 150, EvidenceSpan("e-1", 0, 8, "wrong")),
        )
        for candidate, scope_id, now, candidate_span in cases:
            with self.subTest(candidate=candidate), self.assertRaises(EvidencePolicyError):
                validate_evidence(
                    record=candidate,
                    span=candidate_span,
                    expected_scope_id=scope_id,
                    now=now,
                )


if __name__ == "__main__":
    unittest.main()

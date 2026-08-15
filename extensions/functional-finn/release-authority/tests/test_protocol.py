from __future__ import annotations

import io
import json
import unittest
from pathlib import Path

from functional_finn_authority.protocol import (
    AtomicClaim,
    CandidateSubmit,
    CandidateRelease,
    EvidenceReference,
    IngressLookup,
    IngressPull,
    ProtocolError,
    SendSignedFrame,
    parse_request,
    request_document,
)
from functional_finn_authority.raw_framing import encode_packet, read_packet
from functional_finn_authority.raw_framing import canonical_json_bytes

from .support import signed_frame


def candidate() -> CandidateSubmit:
    return CandidateSubmit(
        request_id="request-1",
        candidate_id="candidate-1",
        turn_ticket="turn-1",
        revision=0,
        ingress_id="ingress-001",
        binding_id="binding-001",
        response_class="factual",
        message="Observed fact.",
        claims=(
            AtomicClaim(
                claim_id="claim-1",
                text="Observed fact.",
                evidence=(
                    EvidenceReference(
                        kind="signal_ingress",
                        ingress_id="ingress-001",
                        start_byte=0,
                        end_byte=14,
                        quote="Observed fact.",
                        receipt_id=None,
                    ),
                ),
            ),
        ),
    )


class ProtocolTest(unittest.TestCase):
    def test_canonical_bytes_match_cross_language_fixture(self) -> None:
        fixture = json.loads(
            (Path(__file__).parents[4] / "test/fixtures/functional-finn-release-ipc.json").read_text()
        )
        validation = request_document(candidate())
        release = request_document(CandidateRelease(
            "release-1", "candidate-1", "turn-1", 0, fixture["candidateDigest"], "Observed fact."
        ))
        pull = request_document(IngressPull("pull-1", after_ordinal=7, limit=20))
        self.assertEqual(canonical_json_bytes(validation).decode(), fixture["validationCanonical"])
        self.assertEqual(canonical_json_bytes(release).decode(), fixture["releaseCanonical"])
        self.assertEqual(canonical_json_bytes(pull).decode(), fixture["ingressPullCanonical"])

    def test_all_four_requests_round_trip_through_canonical_framing(self) -> None:
        signed, _ = signed_frame()
        requests = (
            candidate(),
            CandidateRelease("request-2", "candidate-1", "turn-1", 0, "a" * 64, "Observed fact."),
            SendSignedFrame("request-3", signed),
            IngressPull("request-4", after_ordinal=0, limit=10),
            IngressLookup("request-5", "ingress-001"),
        )
        for request in requests:
            with self.subTest(request=request):
                document = request_document(request)
                framed = encode_packet(document)
                self.assertEqual(parse_request(read_packet(io.BytesIO(framed))), request)

    def test_candidate_has_no_destination_or_presigned_frame_surface(self) -> None:
        document = request_document(candidate())
        self.assertNotIn("destination", str(document).lower())
        self.assertNotIn("frame", document["candidate"])
        for key in ("destination", "destinationBindingId", "frame", "signature"):
            changed = request_document(candidate())
            changed["candidate"][key] = "attacker-selected"
            with self.subTest(key=key), self.assertRaises(ProtocolError):
                parse_request(changed)

    def test_unknown_keys_and_out_of_bounds_values_fail_closed(self) -> None:
        cases = []
        extra_root = request_document(IngressLookup("request-1", "ingress-001"))
        extra_root["extra"] = True
        cases.append(extra_root)
        zero_limit = request_document(IngressPull("request-2", 0, 1))
        zero_limit["limit"] = 0
        cases.append(zero_limit)
        too_many = request_document(candidate())
        too_many["candidate"]["claims"] = too_many["candidate"]["claims"] * 33
        cases.append(too_many)
        for document in cases:
            with self.subTest(document=document), self.assertRaises(ProtocolError):
                parse_request(document)

    def test_tool_observation_is_representable_but_not_self_attesting(self) -> None:
        document = request_document(candidate())
        evidence = document["candidate"]["claims"][0]["evidence"][0]
        evidence["kind"] = "tool_observation"
        evidence["receiptId"] = "plugin-claimed-receipt"
        parsed = parse_request(document)
        self.assertEqual(parsed.claims[0].evidence[0].kind, "tool_observation")  # type: ignore[union-attr]


if __name__ == "__main__":
    unittest.main()

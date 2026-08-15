import hashlib
import json
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from server import ABSTENTION, FunctionalFinnVerifier, _encode_signal_frame


class _Support:
    def score(self, _support: str, _claim: str) -> float:
        return 0.99


class FunctionalFinnVerifierTest(unittest.TestCase):
    def setUp(self) -> None:
        self.verifier = object.__new__(FunctionalFinnVerifier)
        self.verifier._private_key = Ed25519PrivateKey.generate()
        self.verifier._key_id = "test-key"
        self.verifier._support = _Support()
        now = int(time.time() * 1000)
        self.evidence = {
            "evidenceId": "e1",
            "agentId": "finn",
            "content": "status=healthy",
            "observedAt": now - 100,
            "freshnessUntil": now + 10_000,
            "state": "current",
        }

    def envelope(self) -> dict:
        return {
            "schemaVersion": 1,
            "responseClass": "factual",
            "answerText": "The service is healthy.",
            "abstain": False,
            "claims": [{
                "claimId": "c1",
                "text": "The service is healthy.",
                "classification": "observed",
                "confidence": 0.99,
                "sources": [{"evidenceId": "e1", "start": 7, "end": 14, "quote": "healthy"}],
            }],
        }

    def request(self, envelope: dict, operation: str = "validate") -> dict:
        return {
            "schemaVersion": 1,
            "operation": operation,
            "agentId": "finn",
            "sessionKey": "session",
            "runId": "run",
            "accountId": "default",
            "target": "+15551234567",
            "revision": 0,
            "envelope": envelope,
            "evidence": [self.evidence],
        }

    def test_rejects_zero_claim_tail_inference_and_assertive_abstention(self) -> None:
        zero = {**self.envelope(), "claims": []}
        tail = {**self.envelope(), "answerText": "The service is healthy.\nIt will stay healthy."}
        inferred = self.envelope()
        inferred["claims"] = [{**inferred["claims"][0], "classification": "inferred"}]
        assertive = {
            "schemaVersion": 1,
            "responseClass": "factual",
            "answerText": "The service is down, so I cannot answer.",
            "abstain": True,
            "claims": [],
        }
        for envelope in (zero, tail, inferred, assertive):
            self.assertFalse(self.verifier.handle(self.request(envelope))["ok"])

    def test_accepts_only_fixed_abstention(self) -> None:
        abstention = {
            "schemaVersion": 1,
            "responseClass": "factual",
            "answerText": ABSTENTION,
            "abstain": True,
            "claims": [],
        }
        self.assertTrue(self.verifier.handle(self.request(abstention))["ok"])

    def test_authorization_binds_an_exact_canonical_frame_at_revision_one(self) -> None:
        request = self.request(self.envelope(), "authorize")
        request["revision"] = 1
        authorization = self.verifier.handle(request)["authorization"]
        frame = {
            "schema": "functional-finn.signal.send.v1",
            "method": "send",
            "accountId": "default",
            "account": "+15550001111",
            "targetKind": "recipient",
            "targetValue": "+15551234567",
            "message": "The service is healthy.",
            "textStyle": ["0:3:BOLD"],
            "quoteTimestamp": None,
            "quoteAuthor": None,
            "quoteMessage": None,
        }
        result = self.verifier.handle({
            "schemaVersion": 1,
            "operation": "bind_frame",
            "authorization": authorization,
            "candidateText": "The service is healthy.",
            "frame": frame,
        })
        self.assertTrue(result["ok"])
        self.assertEqual(result["receipt"]["revision"], 1)
        self.assertEqual(
            result["receipt"]["frameDigest"], hashlib.sha256(_encode_signal_frame(frame)).hexdigest()
        )

        changed = {**frame, "message": "altered"}
        self.assertTrue(self.verifier.handle({
            "schemaVersion": 1,
            "operation": "bind_frame",
            "authorization": authorization,
            "candidateText": "The service is healthy.",
            "frame": changed,
        })["ok"])

    def test_rejects_tampered_authorization(self) -> None:
        authorization = self.verifier.handle(self.request(self.envelope(), "authorize"))["authorization"]
        authorization = {**authorization, "accountId": "other"}
        result = self.verifier.handle({
            "schemaVersion": 1,
            "operation": "bind_frame",
            "authorization": authorization,
            "candidateText": "The service is healthy.",
            "frame": {},
        })
        self.assertEqual(result, {"ok": False, "code": "INVALID_FRAME_BINDING"})

    def test_signal_frame_fixtures_match_typescript_bytes(self) -> None:
        fixture_path = Path(__file__).parents[3] / "test/fixtures/functional-finn-signal-frames.json"
        fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
        for fixture in fixtures:
            with self.subTest(fixture["name"]):
                encoded = _encode_signal_frame(fixture["frame"])
                self.assertEqual(encoded.hex(), fixture["encodedHex"])
                self.assertEqual(hashlib.sha256(encoded).hexdigest(), fixture["digest"])

    def test_signal_frame_rejects_shared_malformed_unicode_fixtures(self) -> None:
        fixture_path = Path(__file__).parents[3] / "test/fixtures/functional-finn-signal-frame-invalid.json"
        fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
        for fixture in fixtures:
            with self.subTest(fixture["name"]), self.assertRaises(ValueError):
                _encode_signal_frame(fixture["frame"])

    def test_signal_frame_rejects_unknown_nested_numeric_and_unicode_values(self) -> None:
        fixture_path = Path(__file__).parents[3] / "test/fixtures/functional-finn-signal-frames.json"
        frame = json.loads(fixture_path.read_text(encoding="utf-8"))[0]["frame"]
        invalid = (
            {**frame, "extra": True},
            {"schema": 1, "method": "send", "params": {}},
            {**frame, "quoteTimestamp": float("nan")},
            {**frame, "quoteTimestamp": 9_007_199_254_740_992},
            {**frame, "message": "cafe\u0301"},
        )
        for value in invalid:
            with self.assertRaises(ValueError):
                _encode_signal_frame(value)


if __name__ == "__main__":
    unittest.main()

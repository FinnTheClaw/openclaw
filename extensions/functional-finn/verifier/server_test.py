import hashlib
import json
import time
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from server import ABSTENTION, FunctionalFinnVerifier


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
        target_digest = hashlib.sha256(b"+15551234567").hexdigest()
        frame = {
            "schemaVersion": 1,
            "method": "send",
            "accountId": "default",
            "targetDigest": target_digest,
            "params": {
                "message": "The service is healthy.",
                "text-style": ["0:3:BOLD"],
                "account": "+15550001111",
                "recipient": ["+15551234567"],
            },
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
        canonical = json.dumps(frame, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
        self.assertEqual(result["receipt"]["frameDigest"], hashlib.sha256(canonical.encode()).hexdigest())

        changed = {**frame, "params": {**frame["params"], "message": "altered"}}
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


if __name__ == "__main__":
    unittest.main()

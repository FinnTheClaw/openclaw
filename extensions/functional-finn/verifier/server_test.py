import time
import unittest

from server import FunctionalFinnVerifier


class _Support:
    def score(self, _support: str, _claim: str) -> float:
        return 0.99


class FunctionalFinnVerifierTest(unittest.TestCase):
    def setUp(self) -> None:
        self.verifier = object.__new__(FunctionalFinnVerifier)
        self.verifier._support = _Support()
        now = int(time.time() * 1000)
        self.evidence = {
            "evidenceId": "e1",
            "agentId": "finn",
            "content": "status🙂=healthy",
            "observedAt": now - 100,
            "freshnessUntil": now + 10_000,
            "sourceKind": "user_confirmed",
            "state": "current",
        }

    def request(self) -> dict:
        return {
            "schemaVersion": 1,
            "operation": "verify_memory",
            "agentId": "finn",
            "claim": "The service is healthy.",
            "evidence": self.evidence,
            "sourceStartByte": len("status🙂=".encode("utf-8")),
            "sourceEndByte": len("status🙂=healthy".encode("utf-8")),
            "sourceQuote": "healthy",
        }

    def test_accepts_exact_utf8_byte_span_after_astral_text(self) -> None:
        self.assertEqual(self.verifier.handle(self.request()), {"ok": True})

    def test_rejects_codepoint_offsets_and_split_utf8_sequences(self) -> None:
        codepoint = {**self.request(), "sourceStartByte": 8, "sourceEndByte": 15}
        split = {**self.request(), "sourceStartByte": 7}
        self.assertEqual(self.verifier.handle(codepoint)["code"], "SPAN_MISMATCH")
        self.assertEqual(self.verifier.handle(split)["code"], "SPAN_MISMATCH")

    def test_rejects_non_nfc_controls_and_unattested_tool_evidence(self) -> None:
        decomposed = {**self.request(), "claim": "cafe\u0301"}
        control = {**self.request(), "sourceQuote": "healthy\r"}
        tool = {
            **self.request(),
            "evidence": {**self.evidence, "sourceKind": "tool_observation"},
        }
        self.assertEqual(self.verifier.handle(decomposed)["code"], "NON_CANONICAL_TEXT")
        self.assertEqual(self.verifier.handle(control)["code"], "NON_CANONICAL_TEXT")
        self.assertEqual(self.verifier.handle(tool)["code"], "UNATTESTED_TOOL_EVIDENCE")

    def test_has_no_release_or_signing_operation(self) -> None:
        for operation in ("validate", "authorize", "bind_frame"):
            with self.subTest(operation=operation):
                self.assertEqual(
                    self.verifier.handle({"schemaVersion": 1, "operation": operation}),
                    {"ok": False, "code": "INVALID_OPERATION"},
                )
        self.assertFalse(hasattr(self.verifier, "_private_key"))


if __name__ == "__main__":
    unittest.main()

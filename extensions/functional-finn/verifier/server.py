#!/usr/bin/env python3
"""Bounded local verifier for Functional Finn answer release and memory admission."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import socket
import sys
import time
import uuid
from pathlib import Path
from typing import Any

MAX_REQUEST_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
ACK = re.compile(r"^(?:ok(?:ay)?|thanks|thank you|got it|understood|noted|sounds good|you're welcome)[!. ]*$", re.I)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _english_bounded(value: str, limit: int) -> bool:
    if not value or len(value) > limit:
        return False
    printable_ascii = sum(1 for char in value if char in "\n\r\t" or 32 <= ord(char) <= 126)
    return printable_ascii / len(value) >= 0.9


class SupportModel:
    def __init__(self, bundle: Path) -> None:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        from transformers import AutoConfig, AutoModelForSequenceClassification

        config = AutoConfig.from_pretrained(str(bundle), trust_remote_code=True, local_files_only=True)
        foundation = os.environ.get("FUNCTIONAL_FINN_FLAN_BUNDLE")
        if not foundation:
            raise RuntimeError("FUNCTIONAL_FINN_FLAN_BUNDLE is required")
        config.foundation = foundation
        self._model = AutoModelForSequenceClassification.from_pretrained(
            str(bundle), config=config, trust_remote_code=True, local_files_only=True
        )

    def score(self, support: str, claim: str) -> float:
        if not _english_bounded(support, 32_000) or not _english_bounded(claim, 2_000):
            return 0.0
        prediction = self._model.predict([(support, claim)])
        return float(prediction[0])


class FunctionalFinnVerifier:
    def __init__(self) -> None:
        from cryptography.hazmat.primitives import serialization

        key_file = Path(os.environ["FUNCTIONAL_FINN_PRIVATE_KEY_FILE"])
        self._private_key = serialization.load_pem_private_key(key_file.read_bytes(), password=None)
        self._key_id = os.environ["FUNCTIONAL_FINN_KEY_ID"]
        self._support = SupportModel(Path(os.environ["FUNCTIONAL_FINN_HHEM_BUNDLE"]))

    def _validate_evidence(self, request: dict[str, Any], claim: dict[str, Any], now: int) -> tuple[bool, str]:
        evidence_by_id = {
            item.get("evidenceId"): item
            for item in request.get("evidence", [])
            if isinstance(item, dict)
        }
        support: list[str] = []
        for source in claim.get("sources", []):
            if not isinstance(source, dict):
                return False, "INVALID_SOURCE"
            item = evidence_by_id.get(source.get("evidenceId"))
            if not item or item.get("state") != "current":
                return False, "UNAVAILABLE_EVIDENCE"
            if item.get("agentId") != request.get("agentId"):
                return False, "WRONG_SCOPE"
            observed = item.get("observedAt")
            fresh = item.get("freshnessUntil")
            if not isinstance(observed, int) or not isinstance(fresh, int) or observed > now or fresh < now:
                return False, "STALE_EVIDENCE"
            start, end, quote = source.get("start"), source.get("end"), source.get("quote")
            content = item.get("content")
            if (
                not isinstance(start, int)
                or not isinstance(end, int)
                or not isinstance(quote, str)
                or not isinstance(content, str)
                or start < 0
                or end <= start
                or content[start:end] != quote
            ):
                return False, "SPAN_MISMATCH"
            support.append(quote)
        if not support or self._support.score("\n".join(support), claim.get("text", "")) < 0.8:
            return False, "UNSUPPORTED_CLAIM"
        return True, "OK"

    def _validate_answer(self, request: dict[str, Any], now: int) -> tuple[bool, str]:
        envelope = request.get("envelope")
        if not isinstance(envelope, dict) or envelope.get("schemaVersion") != 1:
            return False, "INVALID_ENVELOPE"
        answer = envelope.get("answerText")
        claims = envelope.get("claims")
        if not isinstance(answer, str) or not _english_bounded(answer, 3_500) or not isinstance(claims, list):
            return False, "INVALID_ENVELOPE"
        if envelope.get("responseClass") == "non_factual_ack":
            return (True, "OK") if not claims and not envelope.get("abstain") and ACK.fullmatch(answer.strip()) else (False, "INVALID_ACK")
        if envelope.get("responseClass") != "factual" or len(claims) > 20:
            return False, "INVALID_ENVELOPE"
        if envelope.get("abstain"):
            return (True, "OK") if not claims else (False, "INVALID_ABSTENTION")
        for claim in claims:
            if not isinstance(claim, dict) or not _english_bounded(claim.get("text", ""), 2_000):
                return False, "INVALID_CLAIM"
            valid, code = self._validate_evidence(request, claim, now)
            if not valid:
                return False, code
        return True, "OK"

    def _sign(self, request: dict[str, Any], now: int) -> dict[str, Any]:
        evidence_digest = _digest(_canonical(request.get("evidence", [])).decode("utf-8"))
        receipt = {
            "schemaVersion": 1,
            "receiptId": str(uuid.uuid4()),
            "keyId": self._key_id,
            "nonce": secrets.token_urlsafe(24),
            "agentId": request["agentId"],
            "sessionKeyDigest": _digest(request["sessionKey"]),
            "runId": request["runId"],
            "channel": "signal",
            "accountId": request["accountId"],
            "targetDigest": _digest(request["target"].strip().lower()),
            "payloadDigest": _digest(request["envelope"]["answerText"]),
            "evidenceDigest": evidence_digest,
            "revision": 0,
            "issuedAt": now,
            "expiresAt": now + 60_000,
        }
        serialized = _canonical([
            receipt["schemaVersion"], receipt["receiptId"], receipt["keyId"], receipt["nonce"],
            receipt["agentId"], receipt["sessionKeyDigest"], receipt["runId"], receipt["channel"],
            receipt["accountId"], receipt["targetDigest"], receipt["payloadDigest"],
            receipt["evidenceDigest"], receipt["revision"], receipt["issuedAt"], receipt["expiresAt"],
        ])
        signature = self._private_key.sign(serialized)
        receipt["signature"] = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
        return receipt

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        now = int(time.time() * 1000)
        if request.get("schemaVersion") != 1:
            return {"ok": False, "code": "INVALID_REQUEST"}
        if request.get("operation") == "verify_memory":
            evidence = request.get("evidence")
            claim = request.get("claim")
            if not isinstance(evidence, dict) or not isinstance(claim, str):
                return {"ok": False, "code": "INVALID_MEMORY_REQUEST"}
            synthetic = {
                "agentId": request.get("agentId"),
                "evidence": [evidence],
            }
            valid, code = self._validate_evidence(
                synthetic,
                {
                    "text": claim,
                    "sources": [{
                        "evidenceId": evidence.get("evidenceId"),
                        "start": request.get("sourceStart"),
                        "end": request.get("sourceEnd"),
                        "quote": request.get("sourceQuote"),
                    }],
                },
                now,
            )
            return {"ok": valid, **({} if valid else {"code": code})}
        if request.get("operation") not in ("validate", "verify_and_sign"):
            return {"ok": False, "code": "INVALID_OPERATION"}
        valid, code = self._validate_answer(request, now)
        if not valid:
            return {"ok": False, "code": code}
        if request["operation"] == "validate":
            return {"ok": True}
        for field in ("agentId", "sessionKey", "runId", "accountId", "target"):
            if not isinstance(request.get(field), str) or not request[field]:
                return {"ok": False, "code": "MISSING_RELEASE_BINDING"}
        return {"ok": True, "receipt": self._sign(request, now)}


def _serve(socket_path: Path) -> None:
    verifier = FunctionalFinnVerifier()
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if socket_path.exists():
        socket_path.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path))
    os.chmod(socket_path, 0o600)
    server.listen(8)
    while True:
        connection, _ = server.accept()
        with connection:
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = connection.recv(16 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_REQUEST_BYTES:
                    chunks = []
                    break
                chunks.append(chunk)
            try:
                if not chunks:
                    raise ValueError("empty or oversized request")
                request = json.loads(b"".join(chunks))
                if not isinstance(request, dict):
                    raise ValueError("request must be an object")
                response = verifier.handle(request)
            except Exception:
                response = {"ok": False, "code": "VERIFIER_FAILURE"}
            encoded = _canonical(response) + b"\n"
            if len(encoded) > MAX_RESPONSE_BYTES:
                encoded = b'{"ok":false,"code":"VERIFIER_FAILURE"}\n'
            connection.sendall(encoded)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: server.py SOCKET_PATH")
    _serve(Path(sys.argv[1]))

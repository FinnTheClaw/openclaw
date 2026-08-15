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
import unicodedata
import uuid
from pathlib import Path
from typing import Any

MAX_REQUEST_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SIGNAL_FRAME_SCHEMA = "functional-finn.signal.send.v1"
SIGNAL_FRAME_KEYS = frozenset({
    "schema", "method", "accountId", "account", "targetKind", "targetValue",
    "message", "textStyle", "quoteTimestamp", "quoteAuthor", "quoteMessage",
})
ACK = re.compile(r"^(?:ok(?:ay)?|thanks|thank you|got it|understood|noted|sounds good|you're welcome)[!. ]*$", re.I)
ABSTENTION = "I don't have enough verified evidence to answer."


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _canonical_string(value: Any, allow_empty: bool = False) -> str:
    if (
        not isinstance(value, str)
        or (not allow_empty and not value)
        or unicodedata.normalize("NFC", value) != value
        or any(0xD800 <= ord(char) <= 0xDFFF for char in value)
    ):
        raise ValueError("noncanonical Signal frame string")
    return value


def _encode_signal_frame(value: Any) -> bytes:
    if not isinstance(value, dict) or set(value) != SIGNAL_FRAME_KEYS:
        raise ValueError("unknown or missing Signal frame fields")
    if value["schema"] != SIGNAL_FRAME_SCHEMA or value["method"] != "send":
        raise ValueError("invalid Signal frame schema")
    target_kind = value["targetKind"]
    if target_kind not in ("recipient", "group", "username"):
        raise ValueError("invalid Signal frame target")
    styles = value["textStyle"]
    if not isinstance(styles, list):
        raise ValueError("invalid Signal frame text-style")
    timestamp = value["quoteTimestamp"]
    quote_absent = timestamp is None and value["quoteAuthor"] is None and value["quoteMessage"] is None
    quote_present = (
        isinstance(timestamp, int)
        and not isinstance(timestamp, bool)
        and 0 < timestamp <= MAX_SAFE_INTEGER
        and isinstance(value["quoteAuthor"], str)
        and isinstance(value["quoteMessage"], str)
    )
    if not quote_absent and not quote_present:
        raise ValueError("incomplete or noncanonical Signal frame quote")
    account = value["account"]
    ordered = [
        SIGNAL_FRAME_SCHEMA,
        "send",
        _canonical_string(value["accountId"]),
        None if account is None else _canonical_string(account),
        target_kind,
        _canonical_string(value["targetValue"]),
        _canonical_string(value["message"]),
        [_canonical_string(style) for style in styles],
        timestamp,
        None if value["quoteAuthor"] is None else _canonical_string(value["quoteAuthor"]),
        None if value["quoteMessage"] is None else _canonical_string(value["quoteMessage"], True),
    ]
    return json.dumps(ordered, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


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
            return (
                (True, "OK")
                if not claims and not envelope.get("abstain") and answer == answer.strip() and ACK.fullmatch(answer)
                else (False, "INVALID_ACK")
            )
        if envelope.get("responseClass") != "factual" or len(claims) > 20:
            return False, "INVALID_ENVELOPE"
        if envelope.get("abstain"):
            return (True, "OK") if not claims and answer == ABSTENTION else (False, "INVALID_ABSTENTION")
        if not claims:
            return False, "INVALID_ENVELOPE"
        rendered: list[str] = []
        claim_ids: set[str] = set()
        for claim in claims:
            if not isinstance(claim, dict) or not _english_bounded(claim.get("text", ""), 2_000):
                return False, "INVALID_CLAIM"
            claim_id = claim.get("claimId")
            claim_text = claim.get("text")
            confidence = claim.get("confidence")
            if (
                not isinstance(claim_id, str)
                or not claim_id
                or claim_id != claim_id.strip()
                or claim_id in claim_ids
                or not isinstance(claim_text, str)
                or claim_text != claim_text.strip()
                or claim.get("classification") != "observed"
                or not isinstance(confidence, (int, float))
                or isinstance(confidence, bool)
                or confidence < 0.8
                or confidence > 1
            ):
                return False, "INELIGIBLE_CLAIM"
            claim_ids.add(claim_id)
            rendered.append(claim_text)
            valid, code = self._validate_evidence(request, claim, now)
            if not valid:
                return False, code
        if answer != "\n".join(rendered):
            return False, "NON_CANONICAL_ANSWER"
        return True, "OK"

    def _sign_authorization(self, request: dict[str, Any], now: int) -> dict[str, Any]:
        evidence_digest = _digest(_canonical(request.get("evidence", [])).decode("utf-8"))
        authorization = {
            "schemaVersion": 1,
            "authorizationId": str(uuid.uuid4()),
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
            "revision": request["revision"],
            "issuedAt": now,
            "expiresAt": now + 60_000,
        }
        serialized = _canonical([
            authorization["schemaVersion"], authorization["authorizationId"], authorization["keyId"],
            authorization["nonce"], authorization["agentId"], authorization["sessionKeyDigest"],
            authorization["runId"], authorization["channel"], authorization["accountId"],
            authorization["targetDigest"], authorization["payloadDigest"], authorization["evidenceDigest"],
            authorization["revision"], authorization["issuedAt"], authorization["expiresAt"],
        ])
        signature = self._private_key.sign(serialized)
        authorization["signature"] = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
        return authorization

    def _verify_authorization(self, value: Any, now: int) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        required_strings = (
            "authorizationId", "keyId", "nonce", "agentId", "sessionKeyDigest", "runId",
            "channel", "accountId", "targetDigest", "payloadDigest", "evidenceDigest", "signature",
        )
        if (
            value.get("schemaVersion") != 1
            or value.get("keyId") != self._key_id
            or value.get("channel") != "signal"
            or value.get("revision") not in (0, 1)
            or not all(isinstance(value.get(field), str) and value[field] for field in required_strings)
            or not isinstance(value.get("issuedAt"), int)
            or not isinstance(value.get("expiresAt"), int)
            or value["issuedAt"] > now
            or value["expiresAt"] < now
            or value["expiresAt"] - value["issuedAt"] > 60_000
        ):
            return None
        serialized = _canonical([
            value["schemaVersion"], value["authorizationId"], value["keyId"], value["nonce"],
            value["agentId"], value["sessionKeyDigest"], value["runId"], value["channel"],
            value["accountId"], value["targetDigest"], value["payloadDigest"], value["evidenceDigest"],
            value["revision"], value["issuedAt"], value["expiresAt"],
        ])
        try:
            signature = base64.urlsafe_b64decode(value["signature"] + "=" * (-len(value["signature"]) % 4))
            self._private_key.public_key().verify(signature, serialized)
        except Exception:
            return None
        return value

    def _sign_frame(self, request: dict[str, Any], now: int) -> dict[str, Any] | None:
        authorization = self._verify_authorization(request.get("authorization"), now)
        frame = request.get("frame")
        candidate = request.get("candidateText")
        if (
            not authorization
            or not isinstance(candidate, str)
            or _digest(candidate) != authorization["payloadDigest"]
        ):
            return None
        try:
            encoded_frame = _encode_signal_frame(frame)
        except (TypeError, ValueError, UnicodeError):
            return None
        if frame["accountId"] != authorization["accountId"]:
            return None
        frame_digest = hashlib.sha256(encoded_frame).hexdigest()
        receipt = {
            **{key: authorization[key] for key in (
                "schemaVersion", "keyId", "agentId", "sessionKeyDigest", "runId", "channel", "accountId",
                "targetDigest", "payloadDigest", "evidenceDigest", "revision",
            )},
            "receiptId": str(uuid.uuid4()),
            "nonce": secrets.token_urlsafe(24),
            "frameDigest": frame_digest,
            "issuedAt": now,
            "expiresAt": min(authorization["expiresAt"], now + 60_000),
        }
        serialized = _canonical([
            receipt["schemaVersion"], receipt["receiptId"], receipt["keyId"], receipt["nonce"],
            receipt["agentId"], receipt["sessionKeyDigest"], receipt["runId"], receipt["channel"],
            receipt["accountId"], receipt["targetDigest"], receipt["payloadDigest"], receipt["frameDigest"],
            receipt["evidenceDigest"], receipt["revision"], receipt["issuedAt"], receipt["expiresAt"],
        ])
        receipt["signature"] = base64.urlsafe_b64encode(self._private_key.sign(serialized)).decode("ascii").rstrip("=")
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
        if request.get("operation") == "bind_frame":
            receipt = self._sign_frame(request, now)
            return {"ok": True, "receipt": receipt} if receipt else {"ok": False, "code": "INVALID_FRAME_BINDING"}
        if request.get("operation") not in ("validate", "authorize"):
            return {"ok": False, "code": "INVALID_OPERATION"}
        valid, code = self._validate_answer(request, now)
        if not valid:
            return {"ok": False, "code": code}
        if request["operation"] == "validate":
            return {"ok": True}
        for field in ("agentId", "sessionKey", "runId", "accountId", "target"):
            if not isinstance(request.get(field), str) or not request[field]:
                return {"ok": False, "code": "MISSING_RELEASE_BINDING"}
        if request.get("revision") not in (0, 1):
            return {"ok": False, "code": "INVALID_REVISION"}
        return {"ok": True, "authorization": self._sign_authorization(request, now)}


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

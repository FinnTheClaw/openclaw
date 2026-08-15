#!/usr/bin/env python3
"""Bounded semantic-support service for Functional Finn memory admission."""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

MAX_REQUEST_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
MAX_EVIDENCE_BYTES = 64 * 1024
MAX_CLAIM_SCALARS = 2_000
MAX_QUOTE_SCALARS = 4_096


def _canonical(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _canonical_text(value: Any, *, maximum_scalars: int, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value) or len(value) > maximum_scalars:
        raise ValueError("text is missing or oversized")
    if unicodedata.normalize("NFC", value) != value:
        raise ValueError("text is not NFC")
    for character in value:
        codepoint = ord(character)
        if 0xD800 <= codepoint <= 0xDFFF:
            raise ValueError("text contains a surrogate")
        if codepoint < 0x20 and character not in "\n\t":
            raise ValueError("text contains a forbidden control character")
    return value


def _utf8_span(content: str, start_byte: Any, end_byte: Any, quote: str) -> bool:
    encoded = content.encode("utf-8")
    if (
        not isinstance(start_byte, int)
        or isinstance(start_byte, bool)
        or not isinstance(end_byte, int)
        or isinstance(end_byte, bool)
        or start_byte < 0
        or end_byte <= start_byte
        or end_byte > len(encoded)
    ):
        return False
    try:
        selected = encoded[start_byte:end_byte].decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return False
    return selected == quote


def _english_bounded(value: str, limit: int) -> bool:
    if not value or len(value) > limit:
        return False
    printable_ascii = sum(1 for char in value if char in "\n\t" or 32 <= ord(char) <= 126)
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
        if not _english_bounded(support, 32_000) or not _english_bounded(claim, MAX_CLAIM_SCALARS):
            return 0.0
        prediction = self._model.predict([(support, claim)])
        return float(prediction[0])


class FunctionalFinnVerifier:
    """Semantic support only: this process owns no key and cannot authorize release."""

    def __init__(self) -> None:
        self._support = SupportModel(Path(os.environ["FUNCTIONAL_FINN_HHEM_BUNDLE"]))

    def _validate_memory(self, request: dict[str, Any], now: int) -> tuple[bool, str]:
        evidence = request.get("evidence")
        if not isinstance(evidence, dict):
            return False, "INVALID_MEMORY_REQUEST"
        if evidence.get("sourceKind") == "tool_observation":
            return False, "UNATTESTED_TOOL_EVIDENCE"
        if evidence.get("sourceKind") not in ("user_confirmed", "authoritative_import"):
            return False, "INELIGIBLE_EVIDENCE"
        if evidence.get("state") != "current":
            return False, "UNAVAILABLE_EVIDENCE"
        if evidence.get("agentId") != request.get("agentId"):
            return False, "WRONG_SCOPE"
        observed = evidence.get("observedAt")
        fresh = evidence.get("freshnessUntil")
        if (
            not isinstance(observed, int)
            or isinstance(observed, bool)
            or not isinstance(fresh, int)
            or isinstance(fresh, bool)
            or observed > now
            or fresh < now
        ):
            return False, "STALE_EVIDENCE"
        try:
            content = _canonical_text(
                evidence.get("content"), maximum_scalars=MAX_EVIDENCE_BYTES
            )
            if len(content.encode("utf-8")) > MAX_EVIDENCE_BYTES:
                return False, "OVERSIZED_EVIDENCE"
            quote = _canonical_text(request.get("sourceQuote"), maximum_scalars=MAX_QUOTE_SCALARS)
            claim = _canonical_text(request.get("claim"), maximum_scalars=MAX_CLAIM_SCALARS)
        except (UnicodeError, ValueError):
            return False, "NON_CANONICAL_TEXT"
        if not _utf8_span(
            content,
            request.get("sourceStartByte"),
            request.get("sourceEndByte"),
            quote,
        ):
            return False, "SPAN_MISMATCH"
        if self._support.score(quote, claim) < 0.8:
            return False, "UNSUPPORTED_CLAIM"
        return True, "OK"

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        if request.get("schemaVersion") != 1 or request.get("operation") != "verify_memory":
            return {"ok": False, "code": "INVALID_OPERATION"}
        valid, code = self._validate_memory(request, int(time.time() * 1000))
        return {"ok": valid, **({} if valid else {"code": code})}


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

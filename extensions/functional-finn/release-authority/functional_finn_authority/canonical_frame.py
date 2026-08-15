"""Closed deterministic text-frame schema signed by _finnrel."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

FRAME_SCHEMA = "functional-finn.signal.text.v1"
HEX_256 = re.compile(r"^[0-9a-f]{64}$")
MAX_TEXT_CHARS = 3_500
MAX_SAFE_INTEGER = 9_007_199_254_740_991


class CanonicalFrameError(ValueError):
    pass


@dataclass(frozen=True)
class ReleaseFrame:
    frame_id: str
    key_id: str
    ingress_id: str
    destination_binding_id: str
    account_id: str
    turn_sequence: int
    revision: int
    message: str
    quote_ingress_id: str | None
    issued_at: int
    expires_at: int
    envelope_digest: str
    evidence_set_digest: str


def _string(value: Any, label: str, *, allow_newlines: bool = False) -> str:
    if not isinstance(value, str) or not value or unicodedata.normalize("NFC", value) != value:
        raise CanonicalFrameError(f"{label} must be a non-empty NFC string")
    for char in value:
        code = ord(char)
        if 0xD800 <= code <= 0xDFFF or (code < 0x20 and not (allow_newlines and char in "\n\t")):
            raise CanonicalFrameError(f"{label} contains a forbidden code point")
    return value


def _integer(value: Any, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= MAX_SAFE_INTEGER:
        raise CanonicalFrameError(f"{label} must be a bounded integer")
    return value


def _validated(frame: ReleaseFrame) -> list[Any]:
    message = _string(frame.message, "message", allow_newlines=True)
    if len(message) > MAX_TEXT_CHARS:
        raise CanonicalFrameError("message exceeds the text-only MVP limit")
    if frame.revision not in (0, 1):
        raise CanonicalFrameError("revision must be zero or one")
    issued_at = _integer(frame.issued_at, "issued_at", minimum=1)
    expires_at = _integer(frame.expires_at, "expires_at", minimum=1)
    if expires_at <= issued_at:
        raise CanonicalFrameError("frame expiry must follow issuance")
    for digest, label in (
        (frame.envelope_digest, "envelope_digest"),
        (frame.evidence_set_digest, "evidence_set_digest"),
    ):
        if not HEX_256.fullmatch(digest):
            raise CanonicalFrameError(f"{label} must be a lowercase SHA-256 digest")
    quote = None if frame.quote_ingress_id is None else _string(frame.quote_ingress_id, "quote")
    return [
        FRAME_SCHEMA,
        _string(frame.frame_id, "frame_id"),
        _string(frame.key_id, "key_id"),
        _string(frame.ingress_id, "ingress_id"),
        _string(frame.destination_binding_id, "destination_binding_id"),
        _string(frame.account_id, "account_id"),
        _integer(frame.turn_sequence, "turn_sequence", minimum=1),
        frame.revision,
        message,
        quote,
        issued_at,
        expires_at,
        frame.envelope_digest,
        frame.evidence_set_digest,
    ]


def encode_release_frame(frame: ReleaseFrame) -> bytes:
    return json.dumps(_validated(frame), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def decode_release_frame(payload: bytes) -> ReleaseFrame:
    try:
        value = json.loads(
            payload.decode("utf-8", errors="strict"),
            parse_float=lambda _value: (_ for _ in ()).throw(CanonicalFrameError("floats forbidden")),
            parse_constant=lambda _value: (_ for _ in ()).throw(
                CanonicalFrameError("non-finite values forbidden")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CanonicalFrameError("release frame is not valid UTF-8 JSON") from error
    if not isinstance(value, list) or len(value) != 14 or value[0] != FRAME_SCHEMA:
        raise CanonicalFrameError("release frame schema or field count is invalid")
    frame = ReleaseFrame(
        frame_id=value[1],
        key_id=value[2],
        ingress_id=value[3],
        destination_binding_id=value[4],
        account_id=value[5],
        turn_sequence=value[6],
        revision=value[7],
        message=value[8],
        quote_ingress_id=value[9],
        issued_at=value[10],
        expires_at=value[11],
        envelope_digest=value[12],
        evidence_set_digest=value[13],
    )
    if encode_release_frame(frame) != payload:
        raise CanonicalFrameError("release frame is not byte-for-byte canonical")
    return frame


def frame_digest(payload: bytes) -> str:
    decode_release_frame(payload)
    return hashlib.sha256(payload).hexdigest()

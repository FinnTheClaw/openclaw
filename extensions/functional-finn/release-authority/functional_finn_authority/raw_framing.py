"""Bounded canonical JSON framing for local Unix sockets.

The four-byte length is checked before reading or decoding the body. IPC documents
use canonical JSON because this frozen tree has no CBOR dependency. Signed release
frames use the stricter positional codec in canonical_frame.py.
"""

from __future__ import annotations

import json
import struct
from typing import Any, BinaryIO

MAX_PACKET_BYTES = 256 * 1024


class FrameError(ValueError):
    pass


class FrameTooLarge(FrameError):
    pass


def _validate_json(value: Any) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        raise FrameError("floating-point values are not allowed")
    if isinstance(value, list):
        for item in value:
            _validate_json(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise FrameError("JSON object keys must be strings")
            _validate_json(item)
        return
    raise FrameError(f"unsupported JSON value: {type(value).__name__}")


def canonical_json_bytes(value: Any) -> bytes:
    _validate_json(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def encode_packet(value: Any, max_bytes: int = MAX_PACKET_BYTES) -> bytes:
    payload = canonical_json_bytes(value)
    if len(payload) > max_bytes:
        raise FrameTooLarge("outbound IPC frame exceeds the byte limit")
    return struct.pack(">I", len(payload)) + payload


def _read_exact(stream: BinaryIO, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise FrameError("truncated IPC frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise FrameError("duplicate JSON object key")
        result[key] = value
    return result


def decode_document(payload: bytes) -> Any:
    try:
        text = payload.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_float=lambda _value: (_ for _ in ()).throw(FrameError("floats are forbidden")),
            parse_constant=lambda _value: (_ for _ in ()).throw(
                FrameError("non-finite numbers are forbidden")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FrameError("invalid canonical JSON frame") from error
    _validate_json(value)
    if canonical_json_bytes(value) != payload:
        raise FrameError("IPC frame is not byte-for-byte canonical")
    return value


def read_packet(stream: BinaryIO, max_bytes: int = MAX_PACKET_BYTES) -> Any:
    header = _read_exact(stream, 4)
    (length,) = struct.unpack(">I", header)
    if length > max_bytes:
        raise FrameTooLarge("inbound IPC frame exceeds the byte limit")
    return decode_document(_read_exact(stream, length))

from __future__ import annotations

import io
import struct
import unittest

from functional_finn_authority.raw_framing import (
    FrameError,
    FrameTooLarge,
    decode_document,
    encode_packet,
    read_packet,
)


class HeaderOnlyStream:
    def __init__(self, header: bytes) -> None:
        self.header = header
        self.reads: list[int] = []

    def read(self, length: int) -> bytes:
        self.reads.append(length)
        if len(self.reads) == 1:
            return self.header
        raise AssertionError("oversized body must not be read")


class RawFramingTest(unittest.TestCase):
    def test_round_trip_is_canonical(self) -> None:
        packet = encode_packet({"z": [True, None], "a": "é"})
        self.assertEqual(read_packet(io.BytesIO(packet)), {"a": "é", "z": [True, None]})
        self.assertEqual(packet[4:], b'{"a":"\xc3\xa9","z":[true,null]}')

    def test_length_is_rejected_before_body_read_or_parse(self) -> None:
        stream = HeaderOnlyStream(struct.pack(">I", 65))
        with self.assertRaises(FrameTooLarge):
            read_packet(stream, max_bytes=64)  # type: ignore[arg-type]
        self.assertEqual(stream.reads, [4])

    def test_noncanonical_and_ambiguous_json_are_rejected(self) -> None:
        for payload in (b'{"z":1,"a":2}', b'{"a":1,"a":2}', b'{"a":1.0}', b'{"a":NaN}'):
            with self.subTest(payload=payload), self.assertRaises(FrameError):
                decode_document(payload)

    def test_outbound_limit_is_bytes_not_characters(self) -> None:
        with self.assertRaises(FrameTooLarge):
            encode_packet({"value": "é" * 10}, max_bytes=12)


if __name__ == "__main__":
    unittest.main()

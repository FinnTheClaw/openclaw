from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from functional_finn_authority.canonical_frame import (
    CanonicalFrameError,
    decode_release_frame,
    encode_release_frame,
)
from functional_finn_authority.peer_credentials import PeerCredentialError
from functional_finn_authority.signing import FrameSigner, SignedFrame, verify_signed_frame, write_test_key

from .support import sample_frame


class CanonicalFrameTest(unittest.TestCase):
    def test_positional_frame_has_exact_byte_parity(self) -> None:
        payload = encode_release_frame(sample_frame())
        self.assertEqual(encode_release_frame(decode_release_frame(payload)), payload)
        with self.assertRaises(CanonicalFrameError):
            decode_release_frame(payload + b" ")

    def test_schema_rejects_text_and_time_mutations(self) -> None:
        for changes in (
            {"message": "bad\x00text"},
            {"message": "x" * 3_501},
            {"revision": 2},
            {"expires_at": 1_723_700_000},
            {"envelope_digest": "A" * 64},
        ):
            with self.subTest(changes=changes), self.assertRaises(CanonicalFrameError):
                encode_release_frame(sample_frame(**changes))

    def test_signature_covers_exact_canonical_bytes(self) -> None:
        signer = FrameSigner(Ed25519PrivateKey.generate())
        signed = signer.sign(encode_release_frame(sample_frame()))
        self.assertTrue(verify_signed_frame(signed, signer.public_key()))
        altered = SignedFrame(payload=signed.payload.replace(b"supported", b"different"), signature=signed.signature)
        self.assertFalse(verify_signed_frame(altered, signer.public_key()))

    @unittest.skipIf(os.name == "nt", "POSIX ownership/mode check")
    def test_private_key_requires_exact_owner_and_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.pem"
            write_test_key(path, Ed25519PrivateKey.generate())
            FrameSigner.from_file(path, expected_uid=os.getuid())
            path.chmod(0o600)
            with self.assertRaises(PeerCredentialError):
                FrameSigner.from_file(path, expected_uid=os.getuid())


if __name__ == "__main__":
    unittest.main()

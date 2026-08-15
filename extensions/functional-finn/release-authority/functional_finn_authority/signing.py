"""Ed25519 frame signing owned exclusively by _finnrel."""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from .canonical_frame import decode_release_frame
from .peer_credentials import assert_private_regular_file


@dataclass(frozen=True)
class SignedFrame:
    payload: bytes
    signature: str


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode_b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class FrameSigner:
    def __init__(self, private_key: Ed25519PrivateKey) -> None:
        self._private_key = private_key

    @classmethod
    def from_file(cls, path: Path, expected_uid: int) -> "FrameSigner":
        assert_private_regular_file(path, expected_uid=expected_uid, expected_mode=0o400)
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("release signing key is not Ed25519")
        return cls(key)

    def sign(self, payload: bytes) -> SignedFrame:
        decode_release_frame(payload)
        return SignedFrame(payload=payload, signature=_b64url(self._private_key.sign(payload)))

    def public_key(self) -> Ed25519PublicKey:
        return self._private_key.public_key()


def verify_signed_frame(signed: SignedFrame, public_key: Ed25519PublicKey) -> bool:
    try:
        decode_release_frame(signed.payload)
        public_key.verify(_decode_b64url(signed.signature), signed.payload)
        return True
    except Exception:
        return False


def load_public_key(path: Path) -> Ed25519PublicKey:
    key = serialization.load_pem_public_key(path.read_bytes())
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("release verification key is not Ed25519")
    return key


def write_test_key(path: Path, key: Ed25519PrivateKey) -> None:
    """Test helper; production installers create keys before daemon startup."""
    path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    os.chmod(path, 0o400)

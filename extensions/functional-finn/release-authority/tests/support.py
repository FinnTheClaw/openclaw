from __future__ import annotations

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from functional_finn_authority.canonical_frame import ReleaseFrame, encode_release_frame
from functional_finn_authority.signing import FrameSigner, SignedFrame


def sample_frame(**overrides: object) -> ReleaseFrame:
    values: dict[str, object] = {
        "frame_id": "frame-001",
        "key_id": "release-key-2026-08",
        "ingress_id": "ingress-001",
        "destination_binding_id": "binding-001",
        "account_id": "finn-signal",
        "turn_sequence": 7,
        "revision": 0,
        "message": "A supported answer.",
        "quote_ingress_id": None,
        "issued_at": 1_723_700_000,
        "expires_at": 1_723_700_300,
        "envelope_digest": "a" * 64,
        "evidence_set_digest": "b" * 64,
    }
    values.update(overrides)
    return ReleaseFrame(**values)  # type: ignore[arg-type]


def signed_frame(**overrides: object) -> tuple[SignedFrame, FrameSigner]:
    signer = FrameSigner(Ed25519PrivateKey.generate())
    return signer.sign(encode_release_frame(sample_frame(**overrides))), signer

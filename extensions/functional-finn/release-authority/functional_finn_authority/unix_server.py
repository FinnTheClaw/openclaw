"""Peer-attested one-request Unix connection seam."""

from __future__ import annotations

import socket
from typing import Any, Callable

from .peer_credentials import PeerUidPolicy
from .raw_framing import MAX_PACKET_BYTES, encode_packet, read_packet

DEFAULT_REQUEST_TIMEOUT_SECONDS = 5.0


def handle_attested_request(
    connection: socket.socket,
    *,
    peer_policy: PeerUidPolicy,
    handler: Callable[[Any], Any],
    max_request_bytes: int = MAX_PACKET_BYTES,
    timeout_seconds: float = DEFAULT_REQUEST_TIMEOUT_SECONDS,
) -> None:
    if timeout_seconds <= 0:
        raise ValueError("authority request timeout must be positive")
    connection.settimeout(timeout_seconds)
    peer_policy.attest(connection)
    with connection.makefile("rb", buffering=0) as reader:
        request = read_packet(reader, max_bytes=max_request_bytes)
    response = encode_packet(handler(request))
    connection.sendall(response)

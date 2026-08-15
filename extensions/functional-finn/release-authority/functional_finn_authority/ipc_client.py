"""Peer-attested canonical request client used between authority daemons."""

from __future__ import annotations

import hashlib
import socket
from typing import Callable, TypeVar, cast

from .peer_credentials import PeerUidPolicy
from .protocol import (
    IngressLookup,
    IngressLookupResult,
    IngressPull,
    IngressPullResult,
    IngressView,
    Request,
    Response,
    SendResultMessage,
    SendSignedFrame,
    parse_response,
    request_document,
)
from .raw_framing import encode_packet, read_packet
from .signing import SignedFrame

ExpectedResponse = TypeVar("ExpectedResponse", bound=Response)
DEFAULT_EXCHANGE_TIMEOUT_SECONDS = 5.0


class AuthorityClientError(RuntimeError):
    pass


class AttestedProtocolClient:
    def __init__(
        self,
        connect: Callable[[], socket.socket],
        *,
        expected_peer_uid: int,
        timeout_seconds: float = DEFAULT_EXCHANGE_TIMEOUT_SECONDS,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("authority exchange timeout must be positive")
        self._connect = connect
        self._peer_policy = PeerUidPolicy(expected_peer_uid)
        self._timeout = timeout_seconds

    def exchange(self, request: Request, expected_type: type[ExpectedResponse]) -> ExpectedResponse:
        connection = self._connect()
        try:
            connection.settimeout(self._timeout)
            self._peer_policy.attest(connection)
            connection.sendall(encode_packet(request_document(request)))
            with connection.makefile("rb", buffering=0) as reader:
                response = parse_response(read_packet(reader))
        finally:
            connection.close()
        if not isinstance(response, expected_type) or response.request_id != request.request_id:
            raise AuthorityClientError("authority response type or request identity mismatch")
        return cast(ExpectedResponse, response)


class FinnsigIngressClient:
    def __init__(self, client: AttestedProtocolClient) -> None:
        self._client = client

    def lookup(self, ingress_id: str) -> IngressView | None:
        request_id = "lookup:" + hashlib.sha256(ingress_id.encode("utf-8")).hexdigest()[:32]
        result = self._client.exchange(
            IngressLookup(request_id=request_id, ingress_id=ingress_id),
            IngressLookupResult,
        )
        return result.record


class FinnsigSenderClient:
    def __init__(self, client: AttestedProtocolClient) -> None:
        self._client = client

    def send(self, request_id: str, signed: SignedFrame) -> SendResultMessage:
        return self._client.exchange(
            SendSignedFrame(request_id=request_id, signed_frame=signed),
            SendResultMessage,
        )


class FinnsigIngressPullClient:
    def __init__(self, client: AttestedProtocolClient) -> None:
        self._client = client

    def pull(self, *, request_id: str, after_ordinal: int, limit: int) -> tuple[IngressView, ...]:
        result = self._client.exchange(
            IngressPull(request_id=request_id, after_ordinal=after_ordinal, limit=limit),
            IngressPullResult,
        )
        return result.records

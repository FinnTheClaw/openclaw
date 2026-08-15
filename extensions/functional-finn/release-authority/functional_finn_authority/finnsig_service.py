"""_finnsig request handlers; the Signal transport remains injected and inert by default."""

from __future__ import annotations

import socket
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .canonical_frame import ReleaseFrame, decode_release_frame
from .ingress_ledger import BoundDelivery, IngressLedger
from .peer_credentials import PeerUidPolicy
from .protocol import (
    IngressLookup,
    IngressLookupResult,
    IngressPull,
    IngressPullResult,
    SendResultMessage,
    SendSignedFrame,
    parse_request,
    response_document,
)
from .sender_ledger import PhysicalSender, SendResult, SenderCoordinator, SenderLedger, SenderState
from .signing import verify_signed_frame
from .unix_server import handle_attested_request


class FinnsigServiceError(RuntimeError):
    pass


class SignalPhysicalSender(Protocol):
    def send_text(self, target: BoundDelivery, message: str) -> SendResult: ...


@dataclass(frozen=True)
class FinnsigPeerPolicies:
    openclaw_uid: int
    finnrel_uid: int


class IngressBoundSender(PhysicalSender):
    def __init__(self, ingress: IngressLedger, sender: SignalPhysicalSender) -> None:
        self._ingress = ingress
        self._sender = sender

    def send(self, frame: ReleaseFrame) -> SendResult:
        target = self._ingress.bind_frame(frame)
        return self._sender.send_text(target, frame.message)


class FinnsigApplication:
    def __init__(
        self,
        *,
        ingress: IngressLedger,
        sender_ledger: SenderLedger,
        physical_sender: SignalPhysicalSender,
        release_public_key: Ed25519PublicKey,
        release_key_id: str,
        now: Callable[[], int],
    ) -> None:
        self._ingress = ingress
        self._sender_ledger = sender_ledger
        self._release_public_key = release_public_key
        self._release_key_id = release_key_id
        self._now = now
        self._coordinator = SenderCoordinator(
            sender_ledger,
            IngressBoundSender(ingress, physical_sender),
        )

    def handle_openclaw(self, value: Any) -> dict[str, Any]:
        request = parse_request(value)
        if not isinstance(request, IngressPull):
            raise FinnsigServiceError("_openclaw may only pull normalized ingress")
        records = self._ingress.pull(
            after_ordinal=request.after_ordinal,
            limit=request.limit,
        )
        return response_document(IngressPullResult(request.request_id, records))

    def handle_release(self, value: Any) -> dict[str, Any]:
        request = parse_request(value)
        if isinstance(request, IngressLookup):
            return response_document(
                IngressLookupResult(request.request_id, self._ingress.lookup(request.ingress_id))
            )
        if not isinstance(request, SendSignedFrame):
            raise FinnsigServiceError("_finnrel request operation is not authorized")
        return response_document(self._send(request))

    def _send(self, request: SendSignedFrame) -> SendResultMessage:
        if not verify_signed_frame(request.signed_frame, self._release_public_key):
            raise FinnsigServiceError("release frame signature is invalid")
        frame = decode_release_frame(request.signed_frame.payload)
        now = self._now()
        if frame.key_id != self._release_key_id:
            raise FinnsigServiceError("release frame key identity is invalid")
        if frame.issued_at > now or frame.expires_at < now:
            raise FinnsigServiceError("release frame is not currently valid")
        self._ingress.bind_frame(frame)
        self._sender_ledger.receive(
            request.signed_frame,
            public_key=self._release_public_key,
            now=now,
        )
        try:
            record = self._coordinator.attempt_once(frame.frame_id, now=now)
        except Exception:
            record = self._sender_ledger.lookup(frame.frame_id)
            if record is None or record.state is not SenderState.UNKNOWN:
                raise
        if record.state not in (SenderState.DELIVERED, SenderState.UNKNOWN):
            raise FinnsigServiceError("sender attempt did not reach a durable outcome")
        return SendResultMessage(
            request_id=request.request_id,
            frame_id=frame.frame_id,
            state=record.state.value,
            message_id=record.message_id,
        )

    def serve_openclaw_once(self, connection: socket.socket, *, expected_uid: int) -> None:
        handle_attested_request(
            connection,
            peer_policy=PeerUidPolicy(expected_uid),
            handler=self.handle_openclaw,
        )

    def serve_release_once(self, connection: socket.socket, *, expected_uid: int) -> None:
        handle_attested_request(
            connection,
            peer_policy=PeerUidPolicy(expected_uid),
            handler=self.handle_release,
        )

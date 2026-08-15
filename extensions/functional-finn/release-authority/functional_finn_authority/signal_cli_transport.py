"""Private signal-cli 0.14.5 stdio JSON-RPC transport owned by _finnsig."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .ingress_ledger import BoundDelivery, IngressLedger, IngressObservation
from .raw_framing import canonical_json_bytes
from .sender_ledger import SendResult

MAX_CHILD_LINE_BYTES = 1024 * 1024
MAX_STDERR_LINE_BYTES = 64 * 1024


class SignalCliTransportError(RuntimeError):
    pass


@dataclass
class _Pending:
    event: threading.Event
    response: dict[str, Any] | None = None
    error: BaseException | None = None


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise SignalCliTransportError("signal-cli emitted duplicate JSON keys")
        value[key] = item
    return value


def _parse_child_line(line: bytes) -> dict[str, Any]:
    if not line or len(line) > MAX_CHILD_LINE_BYTES:
        raise SignalCliTransportError("signal-cli output line is empty or oversized")
    try:
        value = json.loads(
            line.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_object,
            parse_float=lambda _value: (_ for _ in ()).throw(
                SignalCliTransportError("signal-cli emitted a floating-point JSON value")
            ),
            parse_constant=lambda _value: (_ for _ in ()).throw(
                SignalCliTransportError("signal-cli emitted a non-finite JSON value")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SignalCliTransportError("signal-cli emitted malformed UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise SignalCliTransportError("signal-cli emitted a non-object JSON-RPC frame")
    return value


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 512:
        raise SignalCliTransportError(f"Signal ingress {label} is invalid")
    return value


def _notification_observation(
    value: dict[str, Any], *, account_id: str, received_at: int
) -> IngressObservation | None:
    if value.get("jsonrpc") != "2.0" or value.get("method") != "receive":
        return None
    params = value.get("params")
    if not isinstance(params, dict):
        raise SignalCliTransportError("Signal receive notification params are invalid")
    body = params.get("result") if "subscription" in params else params
    if not isinstance(body, dict):
        raise SignalCliTransportError("Signal receive notification body is invalid")
    envelope = body.get("envelope")
    if not isinstance(envelope, dict):
        raise SignalCliTransportError("Signal receive notification has no envelope")
    if "syncMessage" in envelope:
        return None
    data = envelope.get("dataMessage")
    if not isinstance(data, dict):
        return None
    content = data.get("message")
    if not isinstance(content, str) or not content:
        return None
    source_uuid = envelope.get("sourceUuid")
    source_number = envelope.get("sourceNumber") or envelope.get("source")
    if isinstance(source_uuid, str) and source_uuid:
        source_id, source_kind = source_uuid, "uuid"
    else:
        source_id, source_kind = _required_string(source_number, "source"), "phone"
    group = data.get("groupInfo")
    group_id = group.get("groupId") if isinstance(group, dict) else None
    if isinstance(group_id, str) and group_id:
        conversation_id, conversation_kind, destination = group_id, "group", group_id
    else:
        conversation_id, conversation_kind, destination = source_id, "direct", source_id
    sequence = envelope.get("timestamp", data.get("timestamp"))
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
        raise SignalCliTransportError("Signal receive notification timestamp is invalid")
    identity = canonical_json_bytes(
        [account_id, source_id, conversation_id, sequence]
    )
    ingress_id = "signal:" + hashlib.sha256(identity).hexdigest()
    return IngressObservation(
        ingress_id=ingress_id,
        account_id=account_id,
        source_id=source_id,
        source_kind=source_kind,
        conversation_id=conversation_id,
        conversation_kind=conversation_kind,
        reply_destination=destination,
        sequence=sequence,
        received_at=received_at,
        content=content,
    )


class SignalCliJsonRpcTransport:
    """One private child, one stdout parser, and bounded request correlation."""

    def __init__(
        self,
        *,
        binary: Path,
        config_path: Path,
        account: str,
        account_id: str,
        ingress: IngressLedger,
        request_timeout_seconds: float = 30.0,
        now: Callable[[], int] = lambda: int(time.time()),
        popen: Callable[..., Any] = subprocess.Popen,
    ) -> None:
        if not binary.is_absolute() or not config_path.is_absolute():
            raise ValueError("signal-cli binary and config paths must be absolute")
        if not account or not account_id or request_timeout_seconds <= 0:
            raise ValueError("signal-cli account, account id, and timeout are required")
        self._binary = binary
        self._config_path = config_path
        self._account = account
        self._account_id = account_id
        self._ingress = ingress
        self._timeout = request_timeout_seconds
        self._now = now
        self._popen = popen
        self._process: Any = None
        self._pending: dict[str, _Pending] = {}
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._counter = 0
        self._fatal: BaseException | None = None
        self._closed = False
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        with self._lock:
            if self._closed:
                raise SignalCliTransportError("signal-cli transport is closed")
            if self._process is not None:
                return
        argv = [
            str(self._binary),
            "--scrub-log",
            "--config",
            str(self._config_path),
            "-a",
            self._account,
            "jsonRpc",
            "--ignore-attachments",
            "--ignore-stories",
            "--receive-mode",
            "on-start",
        ]
        try:
            process = self._popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                close_fds=True,
                cwd="/var/empty",
                env={"HOME": "/var/empty", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            )
        except BaseException as error:
            raise SignalCliTransportError("signal-cli process could not start") from error
        if process.stdin is None or process.stdout is None or process.stderr is None:
            process.kill()
            raise SignalCliTransportError("signal-cli process pipes are unavailable")
        with self._lock:
            if self._closed:
                process.terminate()
                raise SignalCliTransportError("signal-cli transport closed during startup")
            self._process = process
        self._threads = [
            threading.Thread(target=self._read_stdout, name="finnsig-signal-stdout", daemon=True),
            threading.Thread(target=self._drain_stderr, name="finnsig-signal-stderr", daemon=True),
            threading.Thread(target=self._watch_process, name="finnsig-signal-wait", daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def close(self, timeout_seconds: float = 2.0) -> None:
        if timeout_seconds <= 0:
            raise ValueError("signal-cli close timeout must be positive")
        with self._lock:
            if self._closed:
                return
            self._closed = True
            process = self._process
        self._fail_all(SignalCliTransportError("signal-cli transport closed"))
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=timeout_seconds)
        self._close_pipes(process)
        deadline = time.monotonic() + timeout_seconds
        for thread in self._threads:
            if thread is not threading.current_thread():
                thread.join(timeout=max(0.0, deadline - time.monotonic()))
        if any(thread.is_alive() for thread in self._threads):
            raise SignalCliTransportError("signal-cli transport worker did not close")

    def send_text(self, target: BoundDelivery, message: str) -> SendResult:
        if target.account_id != self._account_id:
            raise SignalCliTransportError("Signal target account binding is invalid")
        if not isinstance(message, str) or not message or len(message) > 3_500:
            raise SignalCliTransportError("Signal text frame is invalid")
        params: dict[str, Any] = {"message": message}
        if target.destination_kind == "group":
            params["groupId"] = target.reply_destination
        elif target.destination_kind == "direct":
            params["recipient"] = [target.reply_destination]
        else:
            raise SignalCliTransportError("Signal destination kind is invalid")
        result = self._request("send", params)
        timestamp = result.get("timestamp")
        if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp < 1:
            raise SignalCliTransportError("Signal send returned no authoritative timestamp")
        return SendResult(message_id=str(timestamp))

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.start()
        with self._lock:
            if self._fatal is not None:
                raise SignalCliTransportError("signal-cli transport failed") from self._fatal
            self._counter += 1
            request_id = f"finnsig-{self._counter}"
            pending = _Pending(threading.Event())
            self._pending[request_id] = pending
            process = self._process
        packet = canonical_json_bytes(
            {"id": request_id, "jsonrpc": "2.0", "method": method, "params": params}
        ) + b"\n"
        try:
            with self._write_lock:
                if process is None or process.stdin is None:
                    raise SignalCliTransportError("signal-cli stdin is unavailable")
                process.stdin.write(packet)
                process.stdin.flush()
        except BaseException as error:
            self._fail(error)
        if not pending.event.wait(self._timeout):
            self._fail(SignalCliTransportError("signal-cli request timed out"))
        with self._lock:
            self._pending.pop(request_id, None)
        if pending.error is not None:
            raise SignalCliTransportError("signal-cli request failed") from pending.error
        response = pending.response
        if response is None:
            raise SignalCliTransportError("signal-cli response is unavailable")
        if response.get("jsonrpc") != "2.0" or response.get("id") != request_id:
            raise SignalCliTransportError("signal-cli response binding is invalid")
        error = response.get("error")
        if error is not None:
            raise SignalCliTransportError("signal-cli rejected the send request")
        result = response.get("result")
        if not isinstance(result, dict):
            raise SignalCliTransportError("signal-cli response result is invalid")
        return result

    def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            self._read_lines(process.stdout, MAX_CHILD_LINE_BYTES, self._handle_stdout_line)
        except BaseException as error:
            self._fail(error)

    def _drain_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            self._read_lines(process.stderr, MAX_STDERR_LINE_BYTES, lambda _line: None)
        except BaseException as error:
            self._fail(error)

    @staticmethod
    def _read_lines(stream: Any, limit: int, callback: Callable[[bytes], None]) -> None:
        buffer = bytearray()
        while True:
            chunk = os.read(stream.fileno(), 4096)
            if not chunk:
                if buffer:
                    raise SignalCliTransportError("signal-cli closed with a partial output frame")
                return
            buffer.extend(chunk)
            if len(buffer) > limit and b"\n" not in buffer:
                raise SignalCliTransportError("signal-cli output exceeded its raw byte limit")
            while True:
                newline = buffer.find(b"\n")
                if newline < 0:
                    break
                if newline > limit:
                    raise SignalCliTransportError("signal-cli output line exceeded its byte limit")
                line = bytes(buffer[:newline])
                del buffer[: newline + 1]
                if line:
                    callback(line)

    def _handle_stdout_line(self, line: bytes) -> None:
        value = _parse_child_line(line)
        request_id = value.get("id")
        if isinstance(request_id, str):
            with self._lock:
                pending = self._pending.get(request_id)
                if pending is None:
                    raise SignalCliTransportError("signal-cli response id is unknown")
                pending.response = value
                pending.event.set()
            return
        observation = _notification_observation(
            value, account_id=self._account_id, received_at=self._now()
        )
        if observation is not None:
            self._ingress.ingest(observation)

    def _watch_process(self) -> None:
        process = self._process
        if process is None:
            return
        code = process.wait()
        with self._lock:
            closing = self._closed
        if not closing:
            self._fail(SignalCliTransportError(f"signal-cli exited unexpectedly ({code})"))

    def _fail(self, error: BaseException) -> None:
        with self._lock:
            if self._fatal is None:
                self._fatal = error
            process = self._process
            pending = tuple(self._pending.values())
        self._signal_failures(pending, error)
        if process is not None and process.poll() is None:
            process.terminate()

    def _fail_all(self, error: BaseException) -> None:
        with self._lock:
            pending = tuple(self._pending.values())
        self._signal_failures(pending, error)

    @staticmethod
    def _signal_failures(pending: tuple[_Pending, ...], error: BaseException) -> None:
        for item in pending:
            item.error = error
            item.event.set()

    @staticmethod
    def _close_pipes(process: Any) -> None:
        if process is None:
            return
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                stream.close()


__all__ = [
    "MAX_CHILD_LINE_BYTES",
    "SignalCliJsonRpcTransport",
    "SignalCliTransportError",
    "_notification_observation",
]

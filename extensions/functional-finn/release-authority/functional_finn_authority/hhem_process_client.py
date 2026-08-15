"""Bounded private JSONL client for the isolated _finnrel HHEM worker."""

from __future__ import annotations

import json
import os
import select
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable

from .raw_framing import canonical_json_bytes
from .semantic_support import SemanticSupportError

MAX_HHEM_LINE_BYTES = 64 * 1024


class HhemProcessClient:
    def __init__(
        self,
        *,
        python_path: Path,
        worker_path: Path,
        model_bundle: Path,
        foundation_bundle: Path,
        timeout_seconds: float,
        threshold_micros: int = 800_000,
        popen: Callable[..., Any] = subprocess.Popen,
    ) -> None:
        paths = (python_path, worker_path, model_bundle, foundation_bundle)
        if any(not path.is_absolute() for path in paths):
            raise ValueError("HHEM process paths must be absolute")
        if timeout_seconds <= 0 or not 1 <= threshold_micros <= 1_000_000:
            raise ValueError("HHEM timeout or threshold is invalid")
        self._argv = [
            str(python_path),
            "-I",
            str(worker_path),
            "--model",
            str(model_bundle),
            "--foundation",
            str(foundation_bundle),
        ]
        self._timeout = timeout_seconds
        self._threshold = threshold_micros
        self._popen = popen
        self._process: Any = None
        self._counter = 0
        self._lock = threading.Lock()
        self._closed = False
        self._poisoned = False
        self._stderr_thread: threading.Thread | None = None

    def supports(self, support: str, claim: str) -> bool:
        if not isinstance(support, str) or not support or len(support) > 32_000:
            raise SemanticSupportError("semantic support text is invalid")
        if not isinstance(claim, str) or not claim or len(claim) > 2_000:
            raise SemanticSupportError("semantic claim is invalid")
        with self._lock:
            if self._closed or self._poisoned:
                raise SemanticSupportError("semantic support worker is unavailable")
            self._ensure_started()
            self._counter += 1
            request_id = f"score-{self._counter}"
            process = self._process
            if process is None or process.stdin is None or process.stdout is None:
                raise SemanticSupportError("semantic support worker pipes are unavailable")
            packet = canonical_json_bytes(
                {"claim": claim, "id": request_id, "op": "score", "support": support}
            ) + b"\n"
            try:
                process.stdin.write(packet)
                process.stdin.flush()
                line = self._read_line(process.stdout.fileno())
                response = self._parse_response(line, request_id)
            except BaseException as error:
                self._poison(error)
                raise SemanticSupportError("semantic support worker failed") from error
        return response >= self._threshold

    def close(self, timeout_seconds: float = 2.0) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            process = self._process
        self._stop_process(process, timeout_seconds)
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=timeout_seconds)
        self._close_pipes(process)

    def _ensure_started(self) -> None:
        if self._process is not None:
            if self._process.poll() is not None:
                raise SemanticSupportError("semantic support worker exited")
            return
        try:
            process = self._popen(
                self._argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                close_fds=True,
                cwd="/var/empty",
                env={
                    "HOME": "/var/empty",
                    "LANG": "C.UTF-8",
                    "LC_ALL": "C.UTF-8",
                    "HF_HUB_OFFLINE": "1",
                    "TRANSFORMERS_OFFLINE": "1",
                },
            )
        except BaseException as error:
            raise SemanticSupportError("semantic support worker could not start") from error
        if process.stdin is None or process.stdout is None or process.stderr is None:
            self._stop_process(process, 1.0)
            raise SemanticSupportError("semantic support worker pipes are unavailable")
        self._process = process
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr,
            args=(process,),
            name="finnrel-hhem-stderr",
            daemon=True,
        )
        self._stderr_thread.start()

    def _read_line(self, descriptor: int) -> bytes:
        result = bytearray()
        while True:
            ready, _writable, _errors = select.select([descriptor], [], [], self._timeout)
            if not ready:
                raise TimeoutError("semantic support worker timed out")
            chunk = os.read(descriptor, min(4096, MAX_HHEM_LINE_BYTES + 1 - len(result)))
            if not chunk:
                raise EOFError("semantic support worker closed stdout")
            newline = chunk.find(b"\n")
            if newline >= 0:
                result.extend(chunk[:newline])
                if newline != len(chunk) - 1:
                    raise SemanticSupportError("semantic support worker emitted extra frames")
                return bytes(result)
            result.extend(chunk)
            if len(result) > MAX_HHEM_LINE_BYTES:
                raise SemanticSupportError("semantic support response is oversized")

    @staticmethod
    def _parse_response(line: bytes, request_id: str) -> int:
        if not line or len(line) > MAX_HHEM_LINE_BYTES:
            raise SemanticSupportError("semantic support response is invalid")
        try:
            value = json.loads(line.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SemanticSupportError("semantic support response is malformed") from error
        if not isinstance(value, dict) or set(value) != {"id", "ok", "scoreMicros"}:
            raise SemanticSupportError("semantic support response shape is invalid")
        score = value["scoreMicros"]
        if (
            value["id"] != request_id
            or value["ok"] is not True
            or isinstance(score, bool)
            or not isinstance(score, int)
            or not 0 <= score <= 1_000_000
        ):
            raise SemanticSupportError("semantic support response binding is invalid")
        return score

    def _poison(self, error: BaseException) -> None:
        self._poisoned = True
        process = self._process
        self._process = None
        self._stop_process(process, 1.0)
        self._close_pipes(process)

    @staticmethod
    def _stop_process(process: Any, timeout_seconds: float) -> None:
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=timeout_seconds)

    @staticmethod
    def _close_pipes(process: Any) -> None:
        if process is None:
            return
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                stream.close()

    def _drain_stderr(self, process: Any) -> None:
        if process.stderr is None:
            return
        total = 0
        while True:
            chunk = os.read(process.stderr.fileno(), 4096)
            if not chunk:
                return
            total += len(chunk)
            if total > MAX_HHEM_LINE_BYTES:
                self._poisoned = True
                self._stop_process(process, 1.0)
                return

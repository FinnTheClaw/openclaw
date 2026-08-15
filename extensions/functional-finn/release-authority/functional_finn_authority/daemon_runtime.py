"""Shared bounded accept-loop lifecycle for launchd-owned authority sockets."""

from __future__ import annotations

import signal
import socket
import threading
import time
from typing import Callable

ACCEPT_TIMEOUT_SECONDS = 0.25
CONNECTION_TIMEOUT_SECONDS = 5.0
SHUTDOWN_TIMEOUT_SECONDS = 2.0


class _ActiveConnections:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._connections: set[socket.socket] = set()
        self._closed = False

    def add(self, connection: socket.socket) -> bool:
        with self._lock:
            if self._closed:
                connection.close()
                return False
            self._connections.add(connection)
            return True

    def discard(self, connection: socket.socket) -> None:
        with self._lock:
            self._connections.discard(connection)

    def close_all(self) -> list[BaseException]:
        with self._lock:
            self._closed = True
            connections = tuple(self._connections)
            self._connections.clear()
        failures: list[BaseException] = []
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                connection.close()
            except OSError as error:
                failures.append(error)
        return failures

class StopLatch:
    def __init__(self) -> None:
        self.event = threading.Event()

    def install(self) -> None:
        def stop(_signum: int, _frame: object) -> None:
            self.event.set()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)


def serve_listener(
    listener: socket.socket,
    *,
    stop: threading.Event,
    handler: Callable[[socket.socket], None],
    active: _ActiveConnections | None = None,
) -> None:
    connections = active or _ActiveConnections()
    listener.settimeout(ACCEPT_TIMEOUT_SECONDS)
    while not stop.is_set():
        try:
            connection, _address = listener.accept()
        except socket.timeout:
            continue
        except OSError:
            if stop.is_set():
                return
            raise
        connection.settimeout(CONNECTION_TIMEOUT_SECONDS)
        if not connections.add(connection):
            return
        try:
            handler(connection)
        finally:
            connections.discard(connection)
            connection.close()


def run_listeners(
    listeners: tuple[tuple[socket.socket, Callable[[socket.socket], None]], ...],
    *,
    stop: threading.Event | None = None,
    shutdown_timeout_seconds: float = SHUTDOWN_TIMEOUT_SECONDS,
) -> None:
    if shutdown_timeout_seconds <= 0:
        raise ValueError("authority shutdown timeout must be positive")
    latch = StopLatch()
    if stop is None:
        latch.install()
        stop_event = latch.event
    else:
        stop_event = stop
    failures: list[BaseException] = []
    failures_lock = threading.Lock()
    active = _ActiveConnections()

    def run(listener: socket.socket, handler: Callable[[socket.socket], None]) -> None:
        try:
            serve_listener(listener, stop=stop_event, handler=handler, active=active)
        except BaseException as error:
            if not stop_event.is_set():
                with failures_lock:
                    failures.append(error)
            stop_event.set()

    workers = [
        threading.Thread(target=run, args=item, name=f"authority-listener-{index}")
        for index, item in enumerate(listeners)
    ]
    for worker in workers:
        worker.start()
    stop_event.wait()
    for listener, _handler in listeners:
        try:
            listener.close()
        except OSError as error:
            failures.append(error)
    failures.extend(active.close_all())
    deadline = time.monotonic() + shutdown_timeout_seconds
    for worker in workers:
        worker.join(timeout=max(0.0, deadline - time.monotonic()))
    if any(worker.is_alive() for worker in workers):
        raise RuntimeError("authority listener did not close")
    if failures:
        raise RuntimeError(f"authority listener failed ({len(failures)} error(s))") from failures[0]

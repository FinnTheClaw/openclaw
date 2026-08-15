"""Shared bounded accept-loop lifecycle for launchd-owned authority sockets."""

from __future__ import annotations

import signal
import socket
import threading
from typing import Callable


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
) -> None:
    listener.settimeout(0.5)
    while not stop.is_set():
        try:
            connection, _address = listener.accept()
        except socket.timeout:
            continue
        except OSError:
            if stop.is_set():
                return
            raise
        try:
            handler(connection)
        finally:
            connection.close()


def run_listeners(
    listeners: tuple[tuple[socket.socket, Callable[[socket.socket], None]], ...]
) -> None:
    latch = StopLatch()
    latch.install()
    failures: list[BaseException] = []

    def run(listener: socket.socket, handler: Callable[[socket.socket], None]) -> None:
        try:
            serve_listener(listener, stop=latch.event, handler=handler)
        except BaseException as error:
            failures.append(error)
            latch.event.set()

    workers = [
        threading.Thread(target=run, args=item, name=f"authority-listener-{index}")
        for index, item in enumerate(listeners)
    ]
    for worker in workers:
        worker.start()
    latch.event.wait()
    for listener, _handler in listeners:
        listener.close()
    for worker in workers:
        worker.join(timeout=2)
    if any(worker.is_alive() for worker in workers):
        raise RuntimeError("authority listener did not close")
    if failures:
        raise RuntimeError(f"authority listener failed ({len(failures)} error(s))") from failures[0]

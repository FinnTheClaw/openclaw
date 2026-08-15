from __future__ import annotations

import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from functional_finn_authority.daemon_common import connect_unix
from functional_finn_authority.daemon_runtime import run_listeners
from functional_finn_authority.ipc_client import AttestedProtocolClient, FinnsigIngressClient
from functional_finn_authority.peer_credentials import PeerUidPolicy
from functional_finn_authority.unix_server import handle_attested_request


@unittest.skipIf(os.name == "nt", "Unix lifecycle boundary")
class DaemonRuntimeTest(unittest.TestCase):
    def test_client_exchange_times_out_when_attested_peer_holds_response(self) -> None:
        server, client_socket = socket.socketpair()
        client = FinnsigIngressClient(
            AttestedProtocolClient(
                lambda: client_socket,
                expected_peer_uid=os.getuid(),
                timeout_seconds=0.05,
            )
        )
        started = time.monotonic()
        try:
            with self.assertRaises((TimeoutError, socket.timeout)):
                client.lookup("ingress-001")
        finally:
            server.close()
        self.assertLess(time.monotonic() - started, 1)

    def test_accepted_authorized_peer_is_closed_during_bounded_shutdown(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "authority.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(path))
            listener.listen(1)
            stop = threading.Event()
            entered = threading.Event()
            failures: list[BaseException] = []

            def handler(connection: socket.socket) -> None:
                entered.set()
                handle_attested_request(
                    connection,
                    peer_policy=PeerUidPolicy(os.getuid()),
                    handler=lambda value: value,
                )

            def run() -> None:
                try:
                    run_listeners(((listener, handler),), stop=stop)
                except BaseException as error:
                    failures.append(error)

            supervisor = threading.Thread(target=run, name="authority-supervisor-test")
            supervisor.start()
            held = connect_unix(path, timeout_seconds=0.2)
            self.assertTrue(entered.wait(timeout=1))
            stop.set()
            supervisor.join(timeout=2)
            held.close()
            self.assertFalse(supervisor.is_alive())
            self.assertEqual(failures, [])
            self.assertFalse(
                any(
                    thread.is_alive() and thread.name.startswith("authority-listener-")
                    for thread in threading.enumerate()
                )
            )


if __name__ == "__main__":
    unittest.main()

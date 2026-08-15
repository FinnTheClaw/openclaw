from __future__ import annotations

import os
import socket
import tempfile
import unittest
from pathlib import Path

from functional_finn_authority.peer_credentials import (
    PeerCredentialError,
    PeerUidPolicy,
    assert_socket_path,
    get_peer_ids,
    identity_can_access,
)
from functional_finn_authority.unix_server import handle_attested_request


@unittest.skipIf(os.name == "nt", "Unix peer credentials are a POSIX boundary")
class PeerCredentialsTest(unittest.TestCase):
    def test_socketpair_reports_the_kernel_peer_identity(self) -> None:
        left, right = socket.socketpair()
        try:
            uid, gid = get_peer_ids(left)
            self.assertEqual(uid, os.getuid())
            self.assertEqual(gid, os.getgid())
        finally:
            left.close()
            right.close()

    def test_wrong_peer_is_rejected_before_frame_read_or_handler(self) -> None:
        left, right = socket.socketpair()
        invoked = False

        def handler(_request: object) -> object:
            nonlocal invoked
            invoked = True
            return {}

        try:
            with self.assertRaises(PeerCredentialError):
                handle_attested_request(
                    left,
                    peer_policy=PeerUidPolicy(expected_uid=os.getuid() + 1),
                    handler=handler,
                )
            self.assertFalse(invoked)
        finally:
            left.close()
            right.close()

    def test_socket_path_requires_real_safe_parent_and_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory) / "sockets"
            parent.mkdir(mode=0o750)
            parent.chmod(0o750)
            endpoint = parent / "candidate.sock"
            server = socket.socket(socket.AF_UNIX)
            try:
                server.bind(str(endpoint))
                endpoint.chmod(0o660)
                assert_socket_path(
                    endpoint,
                    parent_owner_uid=os.getuid(),
                    socket_owner_uid=os.getuid(),
                    socket_group_gid=os.getgid(),
                )
                parent.chmod(0o777)
                with self.assertRaises(PeerCredentialError):
                    assert_socket_path(
                        endpoint,
                        parent_owner_uid=os.getuid(),
                        socket_owner_uid=os.getuid(),
                        socket_group_gid=os.getgid(),
                    )
            finally:
                server.close()

    def test_openclaw_fixture_cannot_read_key_or_connect_sender_socket(self) -> None:
        openclaw_uid = 501
        openclaw_groups = {501, 702}
        self.assertFalse(
            identity_can_access(
                owner_uid=503,
                group_gid=703,
                mode=0o400,
                subject_uid=openclaw_uid,
                subject_groups=openclaw_groups,
                access="read",
            )
        )
        self.assertFalse(
            identity_can_access(
                owner_uid=504,
                group_gid=704,
                mode=0o660,
                subject_uid=openclaw_uid,
                subject_groups=openclaw_groups,
                access="write",
            )
        )
        self.assertTrue(
            identity_can_access(
                owner_uid=503,
                group_gid=702,
                mode=0o660,
                subject_uid=openclaw_uid,
                subject_groups=openclaw_groups,
                access="write",
            )
        )


if __name__ == "__main__":
    unittest.main()

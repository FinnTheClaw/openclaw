"""Common fail-closed daemon startup helpers."""

from __future__ import annotations

import os
import socket
from pathlib import Path

from .authority_policy import SocketPolicy
from .peer_credentials import assert_socket_path


def require_service_uid(expected_uid: int) -> None:
    if os.getuid() != expected_uid or os.geteuid() != expected_uid:
        raise PermissionError("authority daemon is running under the wrong uid")


def attest_launchd_listener(listener: socket.socket, policy: SocketPolicy, service_uid: int) -> None:
    name = listener.getsockname()
    if name != str(policy.path):
        raise PermissionError("launchd socket path does not match policy")
    assert_socket_path(
        policy.path,
        parent_owner_uid=0,
        socket_owner_uid=service_uid,
        socket_group_gid=policy.group_gid,
    )


def connect_unix(path: Path) -> socket.socket:
    value = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        value.connect(str(path))
        return value
    except BaseException:
        value.close()
        raise

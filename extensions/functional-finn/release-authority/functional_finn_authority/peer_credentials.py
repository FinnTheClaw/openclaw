"""macOS Unix peer credentials and filesystem policy checks."""

from __future__ import annotations

import ctypes
import os
import socket
import stat
import sys
from dataclasses import dataclass
from pathlib import Path


class PeerCredentialError(PermissionError):
    pass


def get_peer_ids(connection: socket.socket) -> tuple[int, int]:
    native = getattr(connection, "getpeereid", None)
    if callable(native):
        uid, gid = native()
        return int(uid), int(gid)
    if sys.platform == "darwin":
        uid = ctypes.c_uint()
        gid = ctypes.c_uint()
        getpeereid = ctypes.CDLL(None, use_errno=True).getpeereid
        getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        getpeereid.restype = ctypes.c_int
        if getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            errno = ctypes.get_errno()
            raise OSError(errno, os.strerror(errno))
        return int(uid.value), int(gid.value)
    if hasattr(socket, "SO_PEERCRED"):
        import struct

        _pid, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid, gid
    raise PeerCredentialError("this platform cannot attest Unix peer credentials")


@dataclass(frozen=True)
class PeerUidPolicy:
    expected_uid: int

    def attest(self, connection: socket.socket) -> tuple[int, int]:
        uid, gid = get_peer_ids(connection)
        if uid != self.expected_uid:
            raise PeerCredentialError(f"Unix peer uid {uid} is not authorized")
        return uid, gid


def _mode(path: Path) -> tuple[os.stat_result, int]:
    value = path.lstat()
    return value, stat.S_IMODE(value.st_mode)


def assert_socket_path(
    path: Path,
    *,
    parent_owner_uid: int,
    socket_owner_uid: int,
    socket_group_gid: int,
    parent_mode: int = 0o750,
    socket_mode: int = 0o660,
) -> None:
    parent_state, actual_parent_mode = _mode(path.parent)
    socket_state, actual_socket_mode = _mode(path)
    if not stat.S_ISDIR(parent_state.st_mode) or path.parent.is_symlink():
        raise PeerCredentialError("socket parent must be a real directory")
    if parent_state.st_uid != parent_owner_uid or actual_parent_mode != parent_mode:
        raise PeerCredentialError("socket parent ownership or mode is unsafe")
    if not stat.S_ISSOCK(socket_state.st_mode) or path.is_symlink():
        raise PeerCredentialError("launchd endpoint must be a Unix socket")
    if (
        socket_state.st_uid != socket_owner_uid
        or socket_state.st_gid != socket_group_gid
        or actual_socket_mode != socket_mode
    ):
        raise PeerCredentialError("socket ownership or mode is unsafe")


def assert_private_regular_file(path: Path, *, expected_uid: int, expected_mode: int) -> None:
    state, actual_mode = _mode(path)
    if path.is_symlink() or not stat.S_ISREG(state.st_mode):
        raise PeerCredentialError("authority secret must be a real regular file")
    if state.st_uid != expected_uid or actual_mode != expected_mode:
        raise PeerCredentialError("authority secret ownership or mode is unsafe")


def identity_can_access(
    *,
    owner_uid: int,
    group_gid: int,
    mode: int,
    subject_uid: int,
    subject_groups: set[int],
    access: str,
) -> bool:
    """Evaluate ordinary POSIX mode bits for a non-root negative fixture."""
    if subject_uid == 0:
        return True
    shift = 6 if subject_uid == owner_uid else 3 if group_gid in subject_groups else 0
    mask = {"read": 0o4, "write": 0o2, "execute": 0o1}.get(access)
    if mask is None:
        raise ValueError("unknown POSIX access kind")
    return bool((mode >> shift) & mask)

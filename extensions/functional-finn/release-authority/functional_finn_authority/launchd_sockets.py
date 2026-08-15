"""Small macOS launchd socket-activation wrapper."""

from __future__ import annotations

import ctypes
import socket
import sys


class LaunchdSocketError(RuntimeError):
    pass


def activate_launchd_socket(name: str) -> socket.socket:
    if sys.platform != "darwin":
        raise LaunchdSocketError("launchd socket activation is available only on macOS")
    descriptors = ctypes.POINTER(ctypes.c_int)()
    count = ctypes.c_size_t()
    library = ctypes.CDLL(None, use_errno=True)
    activate = library.launch_activate_socket
    activate.argtypes = [
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.POINTER(ctypes.c_int)),
        ctypes.POINTER(ctypes.c_size_t),
    ]
    activate.restype = ctypes.c_int
    error = activate(name.encode("utf-8"), ctypes.byref(descriptors), ctypes.byref(count))
    if error != 0:
        raise LaunchdSocketError(f"launchd did not provide socket {name} ({error})")
    try:
        if count.value != 1:
            raise LaunchdSocketError(f"launchd socket {name} count is not exactly one")
        descriptor = int(descriptors[0])
        value = socket.socket(fileno=descriptor)
        value.set_inheritable(False)
        return value
    finally:
        library.free.argtypes = [ctypes.c_void_p]
        library.free.restype = None
        library.free(descriptors)

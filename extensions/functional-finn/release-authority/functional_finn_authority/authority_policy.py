"""Strict root-owned policy and immutable-file checks for both daemons."""

from __future__ import annotations

import json
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

POLICY_SCHEMA = "functional-finn.authority-policy.v2"


class AuthorityPolicyError(PermissionError):
    pass


@dataclass(frozen=True)
class SocketPolicy:
    path: Path
    group_gid: int


@dataclass(frozen=True)
class FinnrelPolicy:
    uid: int
    openclaw_uid: int
    key_path: Path
    key_id: str
    ledger_path: Path
    candidate_socket: SocketPolicy
    finnsig_socket: SocketPolicy
    finnsig_uid: int
    hhem_python: Path
    hhem_worker: Path
    hhem_bundle: Path
    flan_bundle: Path
    hhem_timeout_ms: int


@dataclass(frozen=True)
class FinnsigPolicy:
    uid: int
    openclaw_uid: int
    finnrel_uid: int
    release_public_key_path: Path
    release_key_id: str
    sender_ledger_path: Path
    ingress_ledger_path: Path
    release_socket: SocketPolicy
    ingress_socket: SocketPolicy
    signal_cli_path: Path
    signal_store_path: Path
    signal_account: str
    account_id: str


@dataclass(frozen=True)
class AuthorityPolicy:
    finnrel: FinnrelPolicy
    finnsig: FinnsigPolicy


def _exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise AuthorityPolicyError(f"{label} has missing or unknown fields")
    return value


def _path(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise AuthorityPolicyError(f"{label} is invalid")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise AuthorityPolicyError(f"{label} must be an absolute non-traversing path")
    return path


def _string(value: Any, label: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise AuthorityPolicyError(f"{label} is invalid")
    return value


def _positive(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise AuthorityPolicyError(f"{label} is invalid")
    return value


def _socket(value: Any, label: str) -> SocketPolicy:
    item = _exact(value, {"path", "groupGid"}, label)
    return SocketPolicy(_path(item["path"], f"{label} path"), _positive(item["groupGid"], label))


def _assert_file(path: Path, owner_uid: int, mode: int, label: str) -> None:
    state = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(state.st_mode):
        raise AuthorityPolicyError(f"{label} must be a real regular file")
    if state.st_uid != owner_uid or stat.S_IMODE(state.st_mode) != mode:
        raise AuthorityPolicyError(f"{label} ownership or mode is unsafe")


def _assert_root_tree(path: Path, root_uid: int, label: str) -> None:
    root = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(root.st_mode) or root.st_uid != root_uid:
        raise AuthorityPolicyError(f"{label} root is unsafe")
    for item in path.rglob("*"):
        state = item.lstat()
        if item.is_symlink() or state.st_uid != root_uid:
            raise AuthorityPolicyError(f"{label} contains an unsafe owner or symlink")
        if stat.S_ISDIR(state.st_mode):
            if stat.S_IMODE(state.st_mode) & 0o022:
                raise AuthorityPolicyError(f"{label} contains a writable directory")
        elif stat.S_ISREG(state.st_mode):
            if stat.S_IMODE(state.st_mode) & 0o022:
                raise AuthorityPolicyError(f"{label} contains a writable file")
        else:
            raise AuthorityPolicyError(f"{label} contains a special file")


def assert_state_parent(path: Path, owner_uid: int) -> None:
    state = path.parent.lstat()
    if path.parent.is_symlink() or not stat.S_ISDIR(state.st_mode):
        raise AuthorityPolicyError("authority state parent must be a real directory")
    if state.st_uid != owner_uid or stat.S_IMODE(state.st_mode) != 0o700:
        raise AuthorityPolicyError("authority state parent ownership or mode is unsafe")
    if path.exists():
        _assert_file(path, owner_uid, 0o600, "authority database")


def assert_private_directory(path: Path, owner_uid: int, label: str) -> None:
    state = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(state.st_mode):
        raise AuthorityPolicyError(f"{label} must be a real directory")
    if state.st_uid != owner_uid or stat.S_IMODE(state.st_mode) != 0o700:
        raise AuthorityPolicyError(f"{label} ownership or mode is unsafe")


def load_authority_policy(path: Path, *, root_uid: int = 0) -> AuthorityPolicy:
    _assert_file(path, root_uid, 0o444, "authority policy")
    try:
        root = _exact(json.loads(path.read_text(encoding="utf-8")), {"schema", "finnrel", "finnsig"}, "authority policy")
    except (UnicodeError, json.JSONDecodeError) as error:
        raise AuthorityPolicyError("authority policy is not valid UTF-8 JSON") from error
    if root["schema"] != POLICY_SCHEMA:
        raise AuthorityPolicyError("authority policy schema is invalid")
    rel = _exact(root["finnrel"], {
        "uid", "openclawUid", "keyPath", "keyId", "ledgerPath", "candidateSocket",
        "finnsigSocket", "finnsigUid", "hhemPython", "hhemWorker", "hhemBundle",
        "flanBundle", "hhemTimeoutMs",
    }, "finnrel policy")
    sig = _exact(root["finnsig"], {
        "uid", "openclawUid", "finnrelUid", "releasePublicKeyPath", "releaseKeyId",
        "senderLedgerPath", "ingressLedgerPath", "releaseSocket", "ingressSocket",
        "signalCliPath", "signalStorePath", "signalAccount", "accountId",
    }, "finnsig policy")
    timeout = rel["hhemTimeoutMs"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 100 <= timeout <= 5_000:
        raise AuthorityPolicyError("HHEM timeout is invalid")
    policy = AuthorityPolicy(
        FinnrelPolicy(
            _positive(rel["uid"], "finnrel uid"), _positive(rel["openclawUid"], "openclaw uid"),
            _path(rel["keyPath"], "release key path"), _string(rel["keyId"], "release key id", 128),
            _path(rel["ledgerPath"], "release ledger path"), _socket(rel["candidateSocket"], "candidate socket"),
            _socket(rel["finnsigSocket"], "finnsig socket"), _positive(rel["finnsigUid"], "finnsig uid"),
            _path(rel["hhemPython"], "HHEM Python"), _path(rel["hhemWorker"], "HHEM worker"),
            _path(rel["hhemBundle"], "HHEM bundle"), _path(rel["flanBundle"], "FLAN bundle"), timeout,
        ),
        FinnsigPolicy(
            _positive(sig["uid"], "finnsig uid"), _positive(sig["openclawUid"], "openclaw uid"),
            _positive(sig["finnrelUid"], "finnrel uid"), _path(sig["releasePublicKeyPath"], "release public key"),
            _string(sig["releaseKeyId"], "release key id", 128), _path(sig["senderLedgerPath"], "sender ledger"),
            _path(sig["ingressLedgerPath"], "ingress ledger"), _socket(sig["releaseSocket"], "release socket"),
            _socket(sig["ingressSocket"], "ingress socket"), _path(sig["signalCliPath"], "signal-cli path"),
            _path(sig["signalStorePath"], "Signal store path"), _string(sig["signalAccount"], "Signal account"),
            _string(sig["accountId"], "Signal account id", 128),
        ),
    )
    if policy.finnrel.uid != policy.finnsig.finnrel_uid or policy.finnsig.uid != policy.finnrel.finnsig_uid:
        raise AuthorityPolicyError("cross-service UID bindings disagree")
    return policy


def assert_finnrel_files(policy: FinnrelPolicy, *, root_uid: int = 0) -> None:
    _assert_file(policy.key_path, policy.uid, 0o400, "release private key")
    _assert_file(policy.hhem_python, root_uid, 0o555, "HHEM Python")
    _assert_file(policy.hhem_worker, root_uid, 0o444, "HHEM worker")
    _assert_root_tree(policy.hhem_bundle, root_uid, "HHEM bundle")
    _assert_root_tree(policy.flan_bundle, root_uid, "FLAN bundle")
    assert_state_parent(policy.ledger_path, policy.uid)


def assert_finnsig_files(policy: FinnsigPolicy, *, root_uid: int = 0) -> None:
    _assert_file(policy.release_public_key_path, root_uid, 0o444, "release public key")
    _assert_file(policy.signal_cli_path, root_uid, 0o555, "signal-cli binary")
    assert_private_directory(policy.signal_store_path, policy.uid, "Signal store")
    assert_state_parent(policy.sender_ledger_path, policy.uid)
    assert_state_parent(policy.ingress_ledger_path, policy.uid)

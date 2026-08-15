"""Production `_finnsig` launchd entrypoint."""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from .authority_policy import assert_finnsig_files, load_authority_policy
from .daemon_common import attest_launchd_listener, require_service_uid
from .daemon_runtime import run_listeners
from .finnsig_service import FinnsigApplication
from .ingress_ledger import IngressLedger
from .launchd_sockets import activate_launchd_socket
from .sender_ledger import SenderLedger
from .signal_cli_transport import SignalCliJsonRpcTransport
from .signing import load_public_key


def serve(policy_path: Path) -> None:
    os.umask(0o077)
    policy = load_authority_policy(policy_path)
    sig = policy.finnsig
    require_service_uid(sig.uid)
    assert_finnsig_files(sig)
    release_listener = None
    ingress_listener = None
    ingress: IngressLedger | None = None
    sender: SenderLedger | None = None
    transport: SignalCliJsonRpcTransport | None = None
    try:
        release_listener = activate_launchd_socket("ReleaseSocket")
        ingress_listener = activate_launchd_socket("IngressSocket")
        attest_launchd_listener(release_listener, sig.release_socket, sig.uid)
        attest_launchd_listener(ingress_listener, sig.ingress_socket, sig.uid)
        ingress = IngressLedger(sig.ingress_ledger_path)
        sender = SenderLedger(sig.sender_ledger_path)
        sender.recover_after_restart(now=int(time.time()))
        transport = SignalCliJsonRpcTransport(
            binary=sig.signal_cli_path,
            config_path=sig.signal_store_path,
            account=sig.signal_account,
            account_id=sig.account_id,
            ingress=ingress,
        )
        transport.start()
        app = FinnsigApplication(
            ingress=ingress,
            sender_ledger=sender,
            physical_sender=transport,
            release_public_key=load_public_key(sig.release_public_key_path),
            release_key_id=sig.release_key_id,
            now=lambda: int(time.time()),
        )
        run_listeners((
            (release_listener, lambda value: app.serve_release_once(value, expected_uid=sig.finnrel_uid)),
            (ingress_listener, lambda value: app.serve_openclaw_once(value, expected_uid=sig.openclaw_uid)),
        ))
    finally:
        if release_listener is not None:
            release_listener.close()
        if ingress_listener is not None:
            ingress_listener.close()
        if transport is not None:
            transport.close()
        if sender is not None:
            sender.close()
        if ingress is not None:
            ingress.close()


def main() -> int:
    parser = argparse.ArgumentParser(prog="finnsig")
    sub = parser.add_subparsers(dest="command", required=True)
    serve_parser = sub.add_parser("serve")
    serve_parser.add_argument("--policy", required=True, type=Path)
    args = parser.parse_args()
    serve(args.policy)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

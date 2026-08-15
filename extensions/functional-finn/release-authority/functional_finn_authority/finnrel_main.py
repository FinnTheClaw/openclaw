"""Production `_finnrel` launchd entrypoint."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from .authority_policy import assert_finnrel_files, load_authority_policy
from .daemon_common import attest_launchd_listener, connect_unix, require_service_uid
from .daemon_runtime import run_listeners
from .finnrel_service import FinnrelApplication
from .hhem_process_client import HhemProcessClient
from .ipc_client import AttestedProtocolClient, FinnsigIngressClient, FinnsigSenderClient
from .launchd_sockets import activate_launchd_socket
from .release_ledger import ReleaseLedger
from .signing import FrameSigner


def serve(policy_path: Path) -> None:
    os.umask(0o077)
    policy = load_authority_policy(policy_path)
    rel = policy.finnrel
    require_service_uid(rel.uid)
    assert_finnrel_files(rel)
    listener = None
    ledger: ReleaseLedger | None = None
    support: HhemProcessClient | None = None
    try:
        listener = activate_launchd_socket("CandidateSocket")
        attest_launchd_listener(listener, rel.candidate_socket, rel.uid)
        ledger = ReleaseLedger(rel.ledger_path)
        support = HhemProcessClient(
            python_path=rel.hhem_python,
            worker_path=rel.hhem_worker,
            model_bundle=rel.hhem_bundle,
            foundation_bundle=rel.flan_bundle,
            timeout_seconds=rel.hhem_timeout_ms / 1000,
        )
        client = AttestedProtocolClient(
            lambda: connect_unix(rel.finnsig_socket.path),
            expected_peer_uid=rel.finnsig_uid,
        )
        app = FinnrelApplication(
            ledger=ledger,
            signer=FrameSigner.from_file(rel.key_path, rel.uid),
            key_id=rel.key_id,
            ingress_client=FinnsigIngressClient(client),
            sender_client=FinnsigSenderClient(client),
            now=lambda: __import__("time").time_ns() // 1_000_000_000,
            support_gate=support,
        )
        run_listeners(((listener, lambda value: app.serve_openclaw_once(value, expected_uid=rel.openclaw_uid)),))
    finally:
        if listener is not None:
            listener.close()
        if support is not None:
            support.close()
        if ledger is not None:
            ledger.close()


def main() -> int:
    parser = argparse.ArgumentParser(prog="finnrel")
    sub = parser.add_subparsers(dest="command", required=True)
    serve_parser = sub.add_parser("serve")
    serve_parser.add_argument("--policy", required=True, type=Path)
    args = parser.parse_args()
    serve(args.policy)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

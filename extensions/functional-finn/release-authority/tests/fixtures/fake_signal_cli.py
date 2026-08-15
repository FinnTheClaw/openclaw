#!/usr/bin/python3
"""Process fixture that speaks the documented signal-cli JSON-RPC line protocol."""

import json
import os
import sys
from pathlib import Path


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


args = sys.argv[1:]
config = Path(args[args.index("--config") + 1])
mode_file = config / "mode"
inbound_file = config / "inbound.json"
if inbound_file.exists():
    emit(json.loads(inbound_file.read_text(encoding="utf-8")))

for line in sys.stdin:
    request = json.loads(line)
    mode = mode_file.read_text(encoding="utf-8").strip() if mode_file.exists() else "success"
    if mode == "crash":
        os._exit(23)
    if mode == "malformed":
        sys.stdout.write("{not-json}\n")
        sys.stdout.flush()
        continue
    if mode == "oversized":
        sys.stdout.write("{" + "x" * (1024 * 1024 + 10) + "}\n")
        sys.stdout.flush()
        continue
    if mode == "error":
        emit({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -1, "message": "no"}})
        continue
    if mode == "hang":
        continue
    record = json.dumps(request["params"], separators=(",", ":")) + "\n"
    with (config / "physical-send.log").open("a", encoding="utf-8") as stream:
        stream.write(record)
        stream.flush()
        os.fsync(stream.fileno())
    if mode == "after_send_crash":
        os._exit(24)
    emit({"jsonrpc": "2.0", "id": request["id"], "result": {"timestamp": 1723700999000}})

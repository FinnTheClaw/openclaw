#!/usr/bin/python3
"""Isolated JSONL scorer fixture used through the production process client."""

import argparse
import json
import os
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True, type=Path)
parser.add_argument("--foundation", required=True, type=Path)
args = parser.parse_args()

for line in sys.stdin.buffer:
    request = json.loads(line)
    mode_path = args.model / "mode"
    mode = mode_path.read_text(encoding="utf-8").strip() if mode_path.exists() else "supported"
    if mode == "timeout":
        time.sleep(5)
    if mode == "crash":
        os._exit(31)
    if mode == "malformed":
        sys.stdout.write("not-json\n")
        sys.stdout.flush()
        continue
    score = 900_000 if mode == "supported" else 490_000
    print(json.dumps({"id": request["id"], "ok": True, "scoreMicros": score}), flush=True)

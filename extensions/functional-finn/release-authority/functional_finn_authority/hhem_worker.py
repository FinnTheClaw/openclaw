#!/usr/bin/python3
"""Offline HHEM worker. Stdout is reserved exclusively for bounded JSONL responses."""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
from pathlib import Path
from typing import Any

MAX_REQUEST_BYTES = 64 * 1024


def _load_model(model: Path, foundation: Path) -> Any:
    with contextlib.redirect_stdout(sys.stderr):
        from transformers import AutoConfig, AutoModelForSequenceClassification

        config = AutoConfig.from_pretrained(
            str(model), trust_remote_code=True, local_files_only=True
        )
        config.foundation = str(foundation)
        return AutoModelForSequenceClassification.from_pretrained(
            str(model), config=config, trust_remote_code=True, local_files_only=True
        )


def _request(line: bytes) -> tuple[str, str, str]:
    if not line or len(line) > MAX_REQUEST_BYTES:
        raise ValueError("request size is invalid")
    value = json.loads(line.decode("utf-8", errors="strict"))
    if not isinstance(value, dict) or set(value) != {"id", "op", "support", "claim"}:
        raise ValueError("request shape is invalid")
    if value["op"] != "score":
        raise ValueError("request operation is invalid")
    request_id, support, claim = value["id"], value["support"], value["claim"]
    if not all(isinstance(item, str) and item for item in (request_id, support, claim)):
        raise ValueError("request fields are invalid")
    if len(request_id) > 96 or len(support) > 32_000 or len(claim) > 2_000:
        raise ValueError("request fields are oversized")
    return request_id, support, claim


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--foundation", required=True, type=Path)
    args = parser.parse_args()
    model = _load_model(args.model, args.foundation)
    while True:
        line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 2)
        if not line:
            return 0
        if not line.endswith(b"\n") or len(line) > MAX_REQUEST_BYTES + 1:
            return 2
        try:
            request_id, support, claim = _request(line[:-1])
            with contextlib.redirect_stdout(sys.stderr):
                score = float(model.predict([(support, claim)])[0])
            if not 0.0 <= score <= 1.0:
                raise ValueError("score is out of range")
            response = {"id": request_id, "ok": True, "scoreMicros": round(score * 1_000_000)}
            sys.stdout.write(json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n")
            sys.stdout.flush()
        except BaseException:
            return 3


if __name__ == "__main__":
    raise SystemExit(main())

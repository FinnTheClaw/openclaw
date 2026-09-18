"""Focused real-model replay of the observed unfinished status update."""
import argparse
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path

HELPER = Path("/workspace/reports/receipt-native-runner-v3.py")
PACKET = Path("/workspace/reports/recovery-directed-wide-20260912/packet.json")
PACKAGE = Path("/workspace/budget-recovery-runtime-c5ddb679")
CONFIG = Path("/home/finnclaw/postreload131072-20260912/qwen/source-config.json")
PLUGINS = Path("/workspace/reports/recovery-directed-wide-20260912/common-plugins.json")
CANDIDATE = Path("/workspace/goal-anchored-continuation-runtime-62c83212")
CANDIDATE_REVISION = "62c83212e3d7f54397491d0339158792a381316c"
REVISION = "c5ddb679d12d104e34d7d49b3b334d21422e2341"

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def snapshot(workspace):
    return {str(p.relative_to(workspace)): p.read_text(errors="replace")
            for p in sorted(workspace.rglob("*")) if p.is_file() and not p.is_symlink()}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("native", HELPER)
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    native.PACKAGE = PACKAGE
    native.memory_snapshot = snapshot
    by_id = {case["id"]: case for case in json.loads(PACKET.read_text())["cases"]}
    keys = ["R20-two-turn-change"]
    selected = []
    for key in keys:
        case = by_id[key]
        fixtures = copy.deepcopy(case["fixtures"])
        prompt = case["turns"][0]
        if key == "R20-two-turn-change":
            fixtures["status.txt"] = "ready\n"
            prompt = case["turns"][1]
        selected.append({"id": key, "fixtures": fixtures, "prompt": prompt})
    base = json.loads(CONFIG.read_text())
    base["models"]["providers"]["finn-coordinator"]["apiKey"] = "${FINN_COORDINATOR_API_KEY}"
    base["agents"]["defaults"]["models"]["finn-coordinator/moira/brain"]["params"]["maxTokens"] = 8192
    native.publish(args.output, "source-config.json", base)
    native.SOURCE_CONFIG = args.output / "source-config.json"
    plugins = json.loads(PLUGINS.read_text())
    natives = {"baseline": native}
    candidate_spec = importlib.util.spec_from_file_location("candidate_native", HELPER)
    candidate = importlib.util.module_from_spec(candidate_spec)
    candidate_spec.loader.exec_module(candidate)
    candidate.PACKAGE = CANDIDATE
    candidate.SOURCE_CONFIG = native.SOURCE_CONFIG
    candidate.memory_snapshot = snapshot
    natives["candidate"] = candidate
    manifest = {
        "startedAt": native.now(), "pid": os.getpid(), "model": "moira/brain",
        "package": str(PACKAGE), "revision": REVISION,
        "packetSha256": sha(PACKET), "candidateRevision": CANDIDATE_REVISION,
        "candidatePackage": str(CANDIDATE), "maxTokens": 8192,
        "helperSha256": sha(HELPER), "runnerSha256": sha(Path(__file__)),
        "configSha256": sha(native.SOURCE_CONFIG), "pluginsSha256": sha(PLUGINS),
        "arms": ["baseline", "candidate"], "cases": keys, "repetitionsPerCase": 10,
        "submissionsPerArm": 10, "totalSubmissions": 20, "concurrency": 3,
        "callerRetries": 0, "treatment": "Source-only62c83212; no guidance profile; unchanged native retry budgets",
        "caseInputsSha256": hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest(),
        "ordering": "Case pairs serial A/B or B/A, alternated by case+repetition; up to3independent pairs",
        "scoring": "Actual requested state and whole-answer truth; wire tool errors/effects/cost; no nonempty-text grading",
    }
    native.publish(args.output, "manifest.json", manifest)
    for arm in manifest["arms"]:
        (args.output / arm).mkdir()
        native.publish(args.output / arm, "manifest.json", {**manifest, "arm": arm})

    def run_pair(rep, index, case):
        rows = []
        arms = ["baseline", "candidate"] if (rep + index) % 2 else ["candidate", "baseline"]
        for arm in arms:
            if (args.output / "STOP").exists():
                return rows
            identity = f"r{rep:02}-{case['id']}"
            folder = args.output / arm / identity
            workspace = folder / "workspace"
            workspace.mkdir(parents=True)
            (workspace / "memory").mkdir()
            for relative, content in case["fixtures"].items():
                target = workspace / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            row = natives[arm].run_turn(folder / "turn-01", workspace, case["prompt"],
                                  arm, identity, plugin_config=plugins)
            rows.append(row)
            print(json.dumps({"arm": arm, "case": identity, "outcome": row["turnOutcome"],
                              "elapsedMs": row["elapsedMs"]}), flush=True)
        return rows

    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(run_pair, rep, index, case)
                   for rep in range(1, 11) for index, case in enumerate(selected)]
        for future in concurrent.futures.as_completed(futures):
            rows.extend(future.result())
    for arm in manifest["arms"]:
        native.publish(args.output / arm, "completed.json",
                       {"at": native.now(), "records": [r for r in rows if r["arm"] == arm]})
    native.publish(args.output, "completed.json", {"at": native.now(), "submissions": len(rows)})

if __name__ == "__main__":
    main()

"""Read-only evidence projection; semantic answer judgments remain human-reviewed."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "collector", "/workspace/reports/recovery-directed-wide-20260912/collect.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

def project(root):
    raw = collector.collect(root)
    result = {"root": str(root), "arms": {}}
    for arm, cohort in raw["arms"].items():
        rows = []
        for case in cohort["records"]:
            record = case["record"]
            before, after = case["before"], case["after"]
            changed = [k for k in sorted(set(before) | set(after)) if before.get(k) != after.get(k)]
            identity = record["identity"]
            names = {"R06": "ledger.txt", "R09": "USER.md", "R11": "counts.csv",
                     "R13": "missing-room.txt", "R20": "status.txt", "D14": "rooms.txt"}
            case_id = identity.split("-")[1]
            target = names[case_id]
            expected = {
                "R06": after.get(target) == "seed-001\nseed-002\n",
                "R09": after.get(target) == before.get(target),
                "R11": after.get(target) == before.get(target),
                "R13": target not in after,
                "R20": after.get(target, "").strip() == "shipped",
                "D14": after.get(target) == "demo: Cedar\narchive: Birch\n",
            }[case_id]
            allowed = {target} if case_id in ("R06", "R20", "D14") else set()
            calls = [call for wire in case["wire"] for call in wire["toolCalls"]]
            malformed = []
            for call in calls:
                try:
                    call["parsedArguments"] = json.loads(call["arguments"])
                except ValueError:
                    malformed.append(call["id"])
            frames = [{
                "outcome": w["outcome"], "finish": w["finishReasons"], "complete": w["complete"],
                "visibleText": w["visibleText"], "reasoningChars": w["reasoningChars"],
                "usage": w["usage"]
            } for w in case["wire"]]
            rows.append({
                "id": identity, "case": case_id, "statePass": expected,
                "scopePass": set(changed) <= allowed, "changedFiles": changed,
                "targetBefore": before.get(target), "targetAfter": after.get(target),
                "answer": record.get("visibleText"), "exitCode": record["exitCode"],
                "elapsedMs": record["elapsedMs"], "nativeSummary": record.get("meta", {}).get("toolSummary"),
                "httpCalls": len(case["wire"]), "calls": calls, "malformedJsonCallIds": malformed,
                "events": {k: len(v) for k, v in case["events"].items()},
                "frames": frames, "routes": sorted({w["model"] for w in case["wire"]}),
                "semanticVerdict": "pending answer and effect review",
            })
        result["arms"][arm] = {"completed": cohort["completed"], "records": rows}
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(project(args.root)))

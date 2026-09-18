"""Read-only status campaign summary over project.py JSON; no semantic auto-pass."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import re
import sys


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def buckets(groups, field):
    return [{field: json.loads(key), "count": len(ids), "ids": ids}
            for key, ids in sorted(groups.items(), key=lambda item: (-len(item[1]), item[0]))]


def summarize_arm(cohort):
    rows = cohort["records"]
    answers, arguments, sequences = defaultdict(list), defaultdict(list), defaultdict(list)
    names, events, counts = Counter(), Counter(), Counter()
    questionable, duplicates, recovery, facts = [], [], [], {}
    for row in rows:
        identity = row["id"]
        if identity in facts:
            raise ValueError(f"duplicate record identity: {identity}")
        if row["case"] != "R20":
            raise ValueError(f"non-status case in status campaign: {identity}")
        answer = row.get("answer")
        visible = isinstance(answer, str) and bool(answer.strip())
        state, scope = row["statePass"] is True, row["scopePass"] is True
        exited = row.get("exitCode") == 0
        snapshot_state = isinstance(row.get("targetAfter"), str) and row["targetAfter"].strip() == "shipped"
        if state != snapshot_state:
            raise ValueError(f"projected state and target snapshot disagree: {identity}")
        fact = {"statePass": state, "scopePass": scope, "visiblePresent": visible,
                "exitZero": exited, "operationalVisiblePass": state and scope and visible and exited}
        facts[identity] = fact
        counts.update(key for key, value in fact.items() if value)
        answers[canonical(answer)].append(identity)
        reasons = []
        if not state:
            reasons.append("requested_state_not_observed")
        if not scope:
            reasons.append("other_files_changed")
        if not exited:
            reasons.append("nonzero_or_missing_exit")
        if not visible:
            reasons.append("empty_or_missing_visible_answer")
        elif not re.search(r"\bshipped\b", answer, re.I):
            reasons.append("no_explicit_shipped_confirmation")
        elif re.search(r"\b(cannot|can't|unable|failed|not|will|would|should|plan|going to)\b", answer, re.I):
            reasons.append("possible_qualification_negation_or_planning")
        if row.get("malformedJsonCallIds"):
            reasons.append("malformed_tool_arguments")
        call_sequence, mutators = [], []
        exact_mutators = defaultdict(list)
        for index, call in enumerate(row.get("calls", [])):
            name = call.get("name", "<missing>")
            names[name] += 1
            call_sequence.append(name)
            # Projector preserves raw argument bytes; canonical parsing is a separate view.
            raw = call.get("arguments")
            args = call.get("parsedArguments", raw)
            arguments[canonical({"name": name, "arguments": args})].append(identity)
            leaf = name.rsplit(".", 1)[-1].lower()
            if leaf in {"write", "edit", "exec", "apply_patch"}:
                entry = {"index": index, "callId": call.get("id"), "name": name,
                         "arguments": args}
                mutators.append(entry)
                exact_mutators[canonical({"name": name, "rawArguments": raw})].append(entry)
        sequences[canonical(call_sequence)].append(identity)
        # Exec can be read-only; multiple calls are candidates, never proven duplicate effects.
        if len(mutators) > 1:
            repeated = [group for group in exact_mutators.values() if len(group) > 1]
            duplicates.append({"id": identity, "mutationCapableCalls": mutators,
                               "byteIdenticalRepeatedCalls": repeated,
                               "verdict": "pending human effect review; exec may be read-only"})
            reasons.append("multiple_mutation_capable_calls")
        active_events = {key: value for key, value in row.get("events", {}).items() if value}
        events.update(active_events)
        if active_events:
            recovery.append({"id": identity, "events": active_events})
        if reasons:
            questionable.append({"id": identity, "reasons": reasons, "answer": answer})
    answer_groups = buckets(answers, "answer")
    return {
        "records": len(rows), "completedMarker": cohort.get("completed"),
        "counts": {key: counts[key] for key in
                   ("statePass", "scopePass", "visiblePresent", "exitZero", "operationalVisiblePass")},
        "semanticReviewPending": True, "semanticReviewedRecords": 0,
        "exactAnswerGroups": answer_groups,
        "exactRepeatedAnswerGroups": sum(group["count"] > 1 for group in answer_groups),
        "recordsInRepeatedAnswerGroups": sum(group["count"] for group in answer_groups if group["count"] > 1),
        "repeatOccurrencesBeyondFirst": sum(group["count"] - 1 for group in answer_groups),
        "toolNameCounts": dict(sorted(names.items())),
        "toolArgumentDistribution": buckets(arguments, "call"),
        "toolSequenceDistribution": buckets(sequences, "sequence"),
        "possibleDuplicateMutationRecords": duplicates,
        "eventCounts": dict(sorted(events.items())), "recordsWithEvents": recovery,
        "questionableAnswerIds": [row["id"] for row in questionable],
        "questionableAnswers": questionable,
    }, facts


def summarize(document, expected_pairs):
    arms, indexed = {}, {}
    for name in ("baseline", "candidate"):
        arms[name], indexed[name] = summarize_arm(document["arms"][name])
    baseline, candidate = indexed["baseline"], indexed["candidate"]
    shared = sorted(baseline.keys() & candidate.keys())
    metrics = ("statePass", "scopePass", "visiblePresent", "exitZero", "operationalVisiblePass")
    paired = {}
    for metric in metrics:
        groups = defaultdict(list)
        for identity in shared:
            left, right = baseline[identity][metric], candidate[identity][metric]
            label = ("both_pass" if left else "candidate_only") if right else ("baseline_only" if left else "neither")
            groups[label].append(identity)
        paired[metric] = {label: {"count": len(groups[label]), "ids": groups[label]}
                          for label in ("both_pass", "neither", "baseline_only", "candidate_only")}
    return {
        "sourceRoot": document.get("root"), "expectedPairs": expected_pairs,
        "pairedRecords": len(shared), "observedRecords": sum(arm["records"] for arm in arms.values()),
        "countComplete": len(shared) == expected_pairs and all(len(rows) == expected_pairs for rows in indexed.values()),
        "unpairedIds": {"baseline": sorted(baseline.keys() - candidate.keys()),
                        "candidate": sorted(candidate.keys() - baseline.keys())},
        "semanticReviewPending": True,
        "interpretation": [
            "State is projector snapshot expectation; scope is snapshot-difference coverage only.",
            "Visible presence and zero exit are operational observations, not truthful confirmation.",
            "All answers require human semantic review; questionable IDs are conservative priority candidates, not exhaustive.",
            "Exact answer groups preserve null, empty text and whitespace separately.",
            "Argument distributions canonicalize parsed JSON; duplicate-call candidates compare raw argument bytes.",
            "Repeated mutation-capable calls do not prove repeated effects; inspect tool outcomes and traces.",
            "Events are raw projector event counters, not necessarily successful recoveries.",
            "No latency or speed ranking; paired correctness observations only.",
        ],
        "arms": arms, "paired": paired,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("projection", nargs="?", default="-", help="project.py JSON path, or - for stdin")
    parser.add_argument("--expected-pairs", type=int, default=500)
    args = parser.parse_args()
    if args.expected_pairs < 1:
        parser.error("--expected-pairs must be positive")
    if args.projection == "-":
        raw = sys.stdin.buffer.read()
    else:
        with open(args.projection, "rb") as stream:
            raw = stream.read()
    result = summarize(json.loads(raw), args.expected_pairs)
    result["projectionSha256"] = hashlib.sha256(raw).hexdigest()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { GOVERNOR_DURABLE_BOUNDARIES } from "../../security/governor-durable-boundary-registry.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { createGovernorEventRecord } from "./events.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import {
  memoryScopeA,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import { GovernorResourceGuardError } from "./resource-guard.js";
import { GovernorSecretRejectedError } from "./secret-filter.js";

afterEach(() => closeOpenClawStateDatabase());

describe("governor V22 durable persistence boundary", () => {
  it("rejects oversized, cyclic, and secret audit payloads before any write", async () => {
    await withMemoryTestHarness(async ({ store, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      const task = store.loadTask(taskId)!;
      const initialCount = store.listEvents(taskId).length;
      const payload = { note: "x".repeat(2 * 1024 * 1024) };
      const oversized = {
        ...createGovernorEventRecord({
          task,
          eventType: "checkpoint_recorded",
          payload: { note: "bounded" },
          now: 100,
        }),
        payload,
        payloadDigest: governorDigest(payload),
      };
      expect(() => store.appendAuditEvent({ task, event: oversized })).toThrow(
        GovernorResourceGuardError,
      );

      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      expect(() =>
        store.appendAuditEvent({
          task,
          event: {
            ...oversized,
            payload: cyclic as GovernorJsonValue,
            payloadDigest: "0".repeat(64),
          },
        }),
      ).toThrow(GovernorResourceGuardError);
      const secretPayload = { accessToken: "synthetic-secret-marker" };
      expect(() =>
        store.appendAuditEvent({
          task,
          event: {
            ...oversized,
            payload: secretPayload,
            payloadDigest: governorDigest(secretPayload),
          },
        }),
      ).toThrow(GovernorSecretRejectedError);
      expect(store.listEvents(taskId)).toHaveLength(initialCount);
    });
  });

  it("guards remediation and manual-review inputs before lookup or mutation", async () => {
    await withMemoryTestHarness(async ({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-v22-guard",
        factKey: "fixture.endpoint",
        path: "/fixture/old",
        observedAt: 100,
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-v22-guard",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("fixture.endpoint"),
        value: { path: "/fixture/current" },
        observedAt: 200,
      });
      const resolution = store.memory.resolveContradiction({
        taskId,
        evidenceId: "evidence-v22-guard",
        staleMemoryId: "memory-v22-guard",
        contradictionClass: "stale fixture source",
        now: 201,
      });
      if (resolution.kind !== "retired") {
        throw new Error("expected resolved V22 fixture contradiction");
      }
      const fingerprint = resolution.remediation.contradictionFingerprint;
      expect(() =>
        store.memory.updateRepairState({
          fingerprint,
          status: "blocked",
          blockedReason: "x".repeat(2 * 1024 * 1024),
          now: 202,
        }),
      ).toThrow(GovernorResourceGuardError);
      expect(() =>
        store.memory.updateRepairState({
          fingerprint,
          status: "blocked",
          blockedReason: "GOVERNOR_SECRET_CANARY_V22_REPAIR",
          now: 202,
        }),
      ).toThrow(GovernorSecretRejectedError);
      expect(store.memory.loadRemediation(fingerprint)?.status).toBe("queued");
      expect(() =>
        store.outbox.markManualReview({
          taskId: "x".repeat(2 * 1024 * 1024) as never,
          effectId: "missing-effect",
          expectedLeaseEpoch: 0,
          expectedDeliveryClaimEpoch: 0,
          reasonDigest: "0".repeat(64),
          now: 203,
        }),
      ).toThrow(GovernorResourceGuardError);
    });
  });

  it("rejects raw scope identity at direct commit and leaves no partial write", async () => {
    await withMemoryTestHarness(async ({ store, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      const task = store.loadTask(taskId)!;
      const rawMarker = "raw-account-fixture-v22";
      const next = {
        ...task,
        scope: { ...task.scope, accountId: rawMarker },
        taskVersion: task.taskVersion + 1,
        updatedAt: 300,
      };
      const event = createGovernorEventRecord({
        task: next,
        eventType: "checkpoint_recorded",
        payload: { checkpoint: "v22" },
        now: 300,
      });
      expect(() => store.commit({ current: task, next, event })).toThrow(/scope identity/u);
      expect(store.loadTask(taskId)).toEqual(task);
      const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
      expect(
        JSON.stringify(db.prepare("SELECT projection_json FROM governor_tasks").all()),
      ).not.toContain(rawMarker);
    });
  });

  it("does not echo corrupt persisted JSON or its secret-shaped key path", async () => {
    await withMemoryTestHarness(async ({ store, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      const marker = "GOVERNOR_SECRET_CANARY_V22_CORRUPT_ROW";
      const rawPath = "nested.accessToken";
      const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
      db.prepare("UPDATE governor_tasks SET projection_json = ? WHERE task_id = ?").run(
        `{"${rawPath}":"${marker}"`,
        taskId,
      );
      try {
        store.loadTask(taskId);
        throw new Error("expected persisted JSON rejection");
      } catch (error) {
        expect(String(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(rawPath);
      }
    });
  });
});

describe("governor persistence guard inventory", () => {
  it("binds every durable database call to an explicit symbol-level enforcement entry", () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(directory, "../../..");
    const entries = new Map(
      GOVERNOR_DURABLE_BOUNDARIES.map((entry) => [`${entry.file}:${entry.symbol}`, entry]),
    );
    expect(entries.size).toBe(GOVERNOR_DURABLE_BOUNDARIES.length);

    const parsed = new Map<
      string,
      { source: ts.SourceFile; text: string; named: Array<{ name: string; node: ts.Node }> }
    >();
    const sourcePaths = [directory, path.resolve(directory, "../../security")].flatMap(
      (sourceDirectory) =>
        fs
          .readdirSync(sourceDirectory, { withFileTypes: true })
          .filter(
            (item) => item.isFile() && item.name.endsWith(".ts") && !item.name.endsWith(".test.ts"),
          )
          .map((item) => path.join(sourceDirectory, item.name)),
    );
    for (const absolute of sourcePaths) {
      const fileName = path.relative(root, absolute).replaceAll("\\", "/");
      const text = fs.readFileSync(absolute, "utf8");
      const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
      const named: Array<{ name: string; node: ts.Node }> = [];
      const visit = (node: ts.Node): void => {
        const candidate = node as ts.Node & { name?: ts.Node };
        const name = candidate.name?.getText(source);
        if (name) {
          named.push({ name: name.replace(/^#/, ""), node });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      parsed.set(fileName, { source, text, named });
    }

    for (const entry of GOVERNOR_DURABLE_BOUNDARIES) {
      const file = parsed.get(entry.file)!;
      const candidates = file.named.filter((candidate) => candidate.name === entry.symbol);
      const match = candidates.find((candidate) =>
        entry.enforcementAnchors.every((anchor) =>
          candidate.node.getText(file.source).includes(anchor),
        ),
      );
      expect.soft(match, `${entry.id} (${entry.file}:${entry.symbol})`).toBeDefined();
    }

    const uncovered: string[] = [];
    for (const [fileName, file] of parsed) {
      const visit = (node: ts.Node, ancestors: readonly string[]): void => {
        const candidate = node as ts.Node & { name?: ts.Node };
        const ownName = candidate.name?.getText(file.source).replace(/^#/, "");
        const nextAncestors = ownName ? [...ancestors, ownName] : ancestors;
        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          const method = ts.isIdentifier(expression)
            ? expression.text
            : ts.isPropertyAccessExpression(expression)
              ? expression.name.text
              : "";
          const table = node.arguments[0];
          const touchesGovernorTable =
            new Set(["selectFrom", "insertInto", "updateTable", "deleteFrom"]).has(method) &&
            table !== undefined &&
            ts.isStringLiteral(table) &&
            table.text.startsWith("governor_");
          if (method === "runOpenClawStateWriteTransaction" || touchesGovernorTable) {
            const covered = nextAncestors.some((symbol) => entries.has(`${fileName}:${symbol}`));
            if (!covered) {
              const line =
                file.source.getLineAndCharacterOfPosition(node.getStart(file.source)).line + 1;
              uncovered.push(`${fileName}:${line}:${nextAncestors.join("/") || "anonymous"}`);
            }
          }
        }
        ts.forEachChild(node, (child) => visit(child, nextAncestors));
      };
      visit(file.source, []);
    }
    expect(uncovered).toEqual([]);
  });
});

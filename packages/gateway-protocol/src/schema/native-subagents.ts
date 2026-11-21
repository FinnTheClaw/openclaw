import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const NATIVE_SUBAGENT_ID_MAX_LENGTH = 512;

/** Provider-owned observations, never OpenClaw session or execution handles. */
export const NativeSubagentsSnapshotSchema = closedObject({
  coverage: Type.Literal("live"),
  children: Type.Array(
    closedObject({
      id: Type.String({ minLength: 1, maxLength: NATIVE_SUBAGENT_ID_MAX_LENGTH }),
      label: Type.String({ minLength: 1, maxLength: 512 }),
      status: stringLiteralUnion(["running", "completed", "failed", "interrupted"]),
    }),
    { maxItems: 128 },
  ),
  truncated: Type.Boolean(),
});

export type NativeSubagentsSnapshot = Static<typeof NativeSubagentsSnapshotSchema>;

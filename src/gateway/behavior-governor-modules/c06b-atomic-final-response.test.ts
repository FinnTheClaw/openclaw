import { afterEach, describe, expect, it } from "vitest";
import { resolveAtomicFinalResponsePolicy } from "../../agents/embedded-agent-runner/atomic-final-response-policy.js";
import {
  C06B_ATOMIC_FINAL_RESPONSE_MODULE_ID,
  C06B_ATOMIC_FINAL_RESPONSE_MODULE_VERSION,
  createC06bAtomicFinalResponseModule,
} from "./c06b-atomic-final-response.js";

let close: (() => void | Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("C06b atomic final-response module", () => {
  it("is import-inert and enforce activation is reversible", async () => {
    const input = {
      trigger: "user" as const,
      disableTools: true,
      clientToolCount: 0,
      resolvedThinkLevel: "high" as const,
    };
    expect(resolveAtomicFinalResponsePolicy(input)).toBeUndefined();

    const runtime = await createC06bAtomicFinalResponseModule()({
      id: C06B_ATOMIC_FINAL_RESPONSE_MODULE_ID,
      version: C06B_ATOMIC_FINAL_RESPONSE_MODULE_VERSION,
      mode: "enforce",
    });
    close = runtime.close;
    expect(resolveAtomicFinalResponsePolicy(input)?.thinkLevel).toBe("off");

    await runtime.close();
    close = undefined;
    expect(resolveAtomicFinalResponsePolicy(input)).toBeUndefined();
  });

  it("keeps shadow activation behaviorally inert", async () => {
    const runtime = await createC06bAtomicFinalResponseModule()({
      id: C06B_ATOMIC_FINAL_RESPONSE_MODULE_ID,
      version: C06B_ATOMIC_FINAL_RESPONSE_MODULE_VERSION,
      mode: "shadow",
    });
    close = runtime.close;
    expect(
      resolveAtomicFinalResponsePolicy({
        trigger: "user",
        disableTools: true,
        clientToolCount: 0,
        resolvedThinkLevel: "high",
      }),
    ).toBeUndefined();
  });

  it("rejects mismatched activation authority", () => {
    expect(() =>
      createC06bAtomicFinalResponseModule()({
        id: C06B_ATOMIC_FINAL_RESPONSE_MODULE_ID,
        version: "2.0.0",
        mode: "enforce",
      }),
    ).toThrow("GOVERNOR_C06B_MODULE_CONTEXT_INVALID");
  });
});

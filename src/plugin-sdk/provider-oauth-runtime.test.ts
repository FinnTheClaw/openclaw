// Provider OAuth runtime tests cover PKCE redirects, callback parsing, and token exchange helpers.
import { describe, expect, it, vi } from "vitest";
import {
  generateOAuthState,
  generatePKCE,
  oauthErrorHtml,
  oauthSuccessHtml,
  parseOAuthAuthorizationInput,
  resolveOAuthTokenExpiresAt,
  resolveOAuthTokenLifetimeMs,
  withOAuthLoginAbort,
} from "./provider-oauth-runtime.js";

describe("provider OAuth runtime", () => {
  it("generates a SHA-256 PKCE challenge and independent OAuth state", async () => {
    const { verifier, challenge } = await generatePKCE();
    const state = generateOAuthState();
    const nextState = generateOAuthState();

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(challenge).toBe(Buffer.from(digest).toString("base64url"));
    expect(state).toHaveLength(43);
    expect(state).not.toBe(verifier);
    expect(nextState).toHaveLength(43);
    expect(nextState).not.toBe(state);
  });

  it("parses authorization code input from redirect URLs, query strings, and raw codes", () => {
    expect(
      parseOAuthAuthorizationInput("http://localhost/callback?code=oauth-code&state=oauth-state"),
    ).toEqual({ code: "oauth-code", state: "oauth-state" });
    expect(parseOAuthAuthorizationInput("code=oauth-code&state=oauth-state")).toEqual({
      code: "oauth-code",
      state: "oauth-state",
    });
    expect(parseOAuthAuthorizationInput("oauth-code#oauth-state")).toEqual({
      code: "oauth-code",
      state: "oauth-state",
    });
    expect(parseOAuthAuthorizationInput(" oauth-code ")).toEqual({ code: "oauth-code" });
    expect(parseOAuthAuthorizationInput("   ")).toEqual({});
  });

  it("escapes HTML-sensitive OAuth page content", () => {
    expect(oauthSuccessHtml(`signed in as <user>&"'`)).toContain(
      "signed in as &lt;user&gt;&amp;&quot;&#39;",
    );
    expect(oauthErrorHtml("failed <login>", `details &"'`)).toContain("details &amp;&quot;&#39;");
  });

  it("resolves safe OAuth token lifetimes and expiry timestamps", () => {
    expect(resolveOAuthTokenLifetimeMs("30")).toBe(30_000);
    expect(resolveOAuthTokenExpiresAt(30, { nowMs: 1_000, refreshSkewMs: 5_000 })).toBe(26_000);
  });

  it("rejects invalid OAuth token lifetimes and Date-invalid expiries", () => {
    expect(resolveOAuthTokenLifetimeMs(0)).toBeUndefined();
    expect(resolveOAuthTokenLifetimeMs(1.5)).toBeUndefined();
    expect(resolveOAuthTokenLifetimeMs(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(resolveOAuthTokenExpiresAt(Number.MAX_SAFE_INTEGER, { nowMs: 1_000 })).toBeUndefined();
    expect(
      resolveOAuthTokenExpiresAt(30, {
        nowMs: 8_640_000_000_000_000,
      }),
    ).toBeUndefined();
    expect(
      resolveOAuthTokenExpiresAt(30, {
        nowMs: 8_640_000_000_000_001,
      }),
    ).toBeUndefined();
  });
});

describe("OAuth supplied operation observation", () => {
  it.each(["already rejected", "rejected after cancellation"] as const)(
    "observes the native supplied operation when already aborted: %s",
    async (timing) => {
      const controller = new AbortController();
      controller.abort();
      const operationError = new Error("owned OAuth operation rejected");
      let rejectOperation!: (reason: unknown) => void;
      const operation = new Promise<string>((_resolve, reject) => {
        rejectOperation = reject;
      });
      if (timing === "already rejected") {
        rejectOperation(operationError);
      }
      const thenSpy = vi.spyOn(operation, "then");
      const onAbort = vi.fn();
      try {
        await expect(withOAuthLoginAbort(operation, controller.signal, onAbort)).rejects.toThrow(
          "Login cancelled",
        );
        if (timing === "rejected after cancellation") {
          rejectOperation(operationError);
        }
        expect(onAbort).toHaveBeenCalledOnce();
        expect(thenSpy).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
      } finally {
        // Drain only after grading helper ownership; never leak a deliberate
        // global unhandled rejection from the original failing implementation.
        rejectOperation(operationError);
        await operation.catch(() => {});
        thenSpy.mockRestore();
      }
    },
  );

  it("observes a live supplied operation that fulfills and removes its listener", async () => {
    const controller = new AbortController();
    const operation = Promise.resolve("owned OAuth result");
    const thenSpy = vi.spyOn(operation, "then");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const onAbort = vi.fn();
    try {
      await expect(withOAuthLoginAbort(operation, controller.signal, onAbort)).resolves.toBe(
        "owned OAuth result",
      );
      expect(thenSpy).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
      controller.abort();
      expect(onAbort).not.toHaveBeenCalled();
    } finally {
      await operation;
      thenSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it("observes a live supplied operation that rejects after a later abort", async () => {
    const controller = new AbortController();
    const operationError = new Error("owned OAuth operation rejected after live abort");
    let rejectOperation!: (reason: unknown) => void;
    const operation = new Promise<string>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const thenSpy = vi.spyOn(operation, "then");
    const onAbort = vi.fn();
    const wrapped = withOAuthLoginAbort(operation, controller.signal, onAbort);
    try {
      controller.abort();
      await expect(wrapped).rejects.toThrow("Login cancelled");
      rejectOperation(operationError);
      expect(onAbort).toHaveBeenCalledOnce();
      expect(thenSpy).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
    } finally {
      rejectOperation(operationError);
      await operation.catch(() => {});
      thenSpy.mockRestore();
    }
  });
});

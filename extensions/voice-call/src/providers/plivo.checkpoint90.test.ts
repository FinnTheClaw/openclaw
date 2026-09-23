import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlivoProvider } from "./plivo.js";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./shared/guarded-json-api.js", () => ({
  guardedJsonApiRequest: api.request,
}));

function provider() {
  return new PlivoProvider({ authId: "MA000000000000000000", authToken: "test-token" });
}

function mapCall(owner: PlivoProvider, requestUuid: string, callUuid: string) {
  (owner as unknown as { requestUuidToCallUuid: Map<string, string> }).requestUuidToCallUuid.set(
    requestUuid,
    callUuid,
  );
}

function urlAt(index = 0): string {
  const call = api.request.mock.calls[index];
  if (!call) {
    throw new Error("missing Plivo API request");
  }
  return String(call[0].url);
}

describe("CH04 Plivo request UUID status lookup", () => {
  beforeEach(() => api.request.mockReset());

  it("P01 canonical ID remains the requested CallUUID", async () => {
    api.request.mockResolvedValue({ call_status: "ringing" });
    expect(await provider().getCallStatus({ providerCallId: "call-a" })).toEqual({
      status: "ringing",
      isTerminal: false,
    });
    expect(urlAt()).toContain("/Call/call-a/");
  });

  it("P02 distinct request and call UUID resolves to CallUUID", async () => {
    const owner = provider();
    mapCall(owner, "request-a", "call-b");
    api.request.mockResolvedValue({ call_status: "in-progress" });
    await owner.getCallStatus({ providerCallId: "request-a" });
    expect(urlAt()).toContain("/Call/call-b/");
    expect(urlAt()).not.toContain("/Call/request-a/");
  });

  it("P03 mapped active status stays nonterminal", async () => {
    const owner = provider();
    mapCall(owner, "request-a", "call-b");
    api.request.mockResolvedValue({ call_status: "in-progress" });
    expect(await owner.getCallStatus({ providerCallId: "request-a" })).toEqual({
      status: "in-progress",
      isTerminal: false,
    });
    expect(urlAt()).toContain("/Call/call-b/");
  });

  it("P04 mapped terminal status is terminal", async () => {
    const owner = provider();
    mapCall(owner, "request-a", "call-b");
    api.request.mockResolvedValue({ call_status: "completed" });
    expect(await owner.getCallStatus({ providerCallId: "request-a" })).toEqual({
      status: "completed",
      isTerminal: true,
    });
    expect(urlAt()).toContain("/Call/call-b/");
  });

  it("P05 mapped 404 is reported not-found", async () => {
    const owner = provider();
    mapCall(owner, "request-a", "call-b");
    api.request.mockResolvedValue(undefined);
    expect(await owner.getCallStatus({ providerCallId: "request-a" })).toEqual({
      status: "not-found",
      isTerminal: true,
    });
    expect(urlAt()).toContain("/Call/call-b/");
  });

  it("P06 absent mapping falls back to supplied ID", async () => {
    api.request.mockResolvedValue({ call_status: "ringing" });
    await provider().getCallStatus({ providerCallId: "request-unmapped" });
    expect(urlAt()).toContain("/Call/request-unmapped/");
  });

  it("P07 webhook mapping updates status identity", async () => {
    const owner = provider();
    owner.parseWebhookEvent({
      headers: { host: "example.com" },
      rawBody: "RequestUUID=request-hook&CallUUID=call-hook&CallStatus=in-progress",
      url: "https://example.com/voice/webhook?provider=plivo&flow=answer",
      method: "POST",
      query: { provider: "plivo", flow: "answer" },
    });
    api.request.mockResolvedValue({ call_status: "in-progress" });
    await owner.getCallStatus({ providerCallId: "request-hook" });
    expect(urlAt()).toContain("/Call/call-hook/");
  });

  it("P08 two request mappings remain isolated", async () => {
    const owner = provider();
    mapCall(owner, "request-a", "call-a");
    mapCall(owner, "request-b", "call-b");
    api.request.mockResolvedValue({ call_status: "ringing" });
    await owner.getCallStatus({ providerCallId: "request-a" });
    await owner.getCallStatus({ providerCallId: "request-b" });
    expect(urlAt(0)).toContain("/Call/call-a/");
    expect(urlAt(1)).toContain("/Call/call-b/");
  });

  it("P09 provider API error stays explicitly unknown", async () => {
    const owner = provider();
    mapCall(owner, "request-a", "call-b");
    api.request.mockImplementationOnce(async () => {
      throw new Error("provider down");
    });
    expect(await owner.getCallStatus({ providerCallId: "request-a" })).toEqual({
      status: "error",
      isTerminal: false,
      isUnknown: true,
    });
    expect(urlAt()).toContain("/Call/call-b/");
  });

  it("P10 hangup and status use the same mapped CallUUID", async () => {
    const owner = provider();
    mapCall(owner, "request-a", "call-b");
    api.request.mockResolvedValue({ call_status: "ringing" });
    await owner.getCallStatus({ providerCallId: "request-a" });
    const hangup = vi.fn(async () => ({}));
    (owner as unknown as { apiRequest: typeof hangup }).apiRequest = hangup;
    await owner.hangupCall({ callId: "internal-a", providerCallId: "request-a" });
    expect(urlAt()).toContain("/Call/call-b/");
    expect(hangup).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", endpoint: "/Call/call-b/" }),
    );
  });
});

// Tests high-risk workspace dotenv controls without duplicating the main dotenv suite.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv, deleteTestEnvValue } from "../test-utils/env.js";
import { loadWorkspaceDotEnvFile } from "./dotenv.js";

const envSnapshot = captureFullEnv();

afterEach(() => {
  vi.restoreAllMocks();
  envSnapshot.restore();
});

async function loadFixture(keys: readonly string[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-blocklist-"));
  const filePath = path.join(directory, ".env");
  await fs.writeFile(filePath, `${keys.map((key) => `${key}=injected`).join("\n")}\n`, "utf8");
  for (const key of keys) {
    deleteTestEnvValue(key);
  }
  loadWorkspaceDotEnvFile(filePath, { quiet: true });
}

describe("workspace dotenv security controls", () => {
  it("blocks provider credentials, endpoint redirects, and connector authority", async () => {
    const blocked = [
      "AWS_ACCESS_KEY_ID",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_BEDROCK_SKIP_AUTH",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_EC2_METADATA_SERVICE_ENDPOINT",
      "AWS_ENDPOINT_URL",
      "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "BUZZ_RELAY_URL",
      "CLOUDSDK_CONFIG",
      "CLOUDSDK_PYTHON_ARGS",
      "FUTURE_PROVIDER_ENDPOINT",
      "SLACK_FORWARDER_URL",
      "SMS_ALLOWED_USERS",
      "SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION",
      "SMS_PUBLIC_WEBHOOK_URL",
      "SYNOLOGY_ALLOWED_USER_IDS",
    ];

    await loadFixture(blocked);

    for (const key of blocked) {
      expect(process.env[key], `${key} should be blocked`).toBeUndefined();
    }
  });

  it("matches dangerous token sequences but permits unrelated words", async () => {
    const blocked = [
      "FUTURE_PLUGIN_DANGEROUSLY_ALLOW_UNTRUSTED",
      "FUTURE_CHANNEL_DISABLE_SIGNATURE_VALIDATION",
      "FUTURE_TRANSPORT_DISABLE_TLS",
      "FUTURE_PROVIDER_SKIP_AUTH",
    ];
    const allowed = ["MY_SKIP_AUTHORS", "VITE_DISABLE_AUTHENTICATION", "APP_URL"];

    await loadFixture([...blocked, ...allowed]);

    for (const key of blocked) {
      expect(process.env[key], `${key} should be blocked`).toBeUndefined();
    }
    for (const key of allowed) {
      expect(process.env[key], `${key} should remain available`).toBe("injected");
    }
  });
});

import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "./test/vitest/vitest.shared.config.ts";
export default defineConfig({
  ...sharedVitestConfig,
  cacheDir: "/tmp/openclaw-frozen-audit-lane4-vite",
  test: {
    ...sharedVitestConfig.test,
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      "packages/normalization-core/src/json-coercion.unsafe-integer.test.ts",
      "packages/tool-call-repair/src/*.test.ts",
      "extensions/ollama/src/stream-runtime.test.ts",
      "packages/ai/src/transports/transport-stream-shared.test.ts",
      "packages/llm-core/src/validation.test.ts",
      "packages/llm-core/src/validation.unsafe-integer.test.ts",
      "packages/tool-call-repair/src/unsafe-integer.test.ts",
      "extensions/ollama/src/stream.header-case.test.ts",
    ],
  },
});

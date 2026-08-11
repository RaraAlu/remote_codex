import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/core/**/*.ts", "src/shim/**/*.ts"],
      reporter: ["text", "json-summary"],
    },
    include: ["test/**/*.test.ts"],
    // GitHub Actions runners (especially Windows) contend heavily; the
    // default 5s per-test timeout is too tight, so raise it globally.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

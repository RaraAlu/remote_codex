import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/core/**/*.ts", "src/shim/**/*.ts"],
      reporter: ["text", "json-summary"],
    },
    include: ["test/**/*.test.ts"],
  },
});

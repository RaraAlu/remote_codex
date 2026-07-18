import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { LocalProcessExecutor } from "../src/core/local-process-executor.js";

describe.skipIf(process.platform === "win32")("LocalProcessExecutor", () => {
  it("executes inside the canonical workspace without inheriting Codex secrets", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "codex-remote-executor-")));
    const executor = new LocalProcessExecutor(
      parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: workspace,
        connectionMode: "vscode-remote",
      }),
    );
    process.env.CODEX_TEST_SECRET = "must-not-leak";
    try {
      await expect(
        executor.execute([
          "sh",
          "-c",
          'printf "%s\\n%s" "$PWD" "${CODEX_TEST_SECRET-unset}"',
        ]),
      ).resolves.toMatchObject({
        actualCwd: workspace,
        exitCode: 0,
        stdout: `${workspace}\nunset`,
      });
    } finally {
      delete process.env.CODEX_TEST_SECRET;
      executor.close();
    }
  });
});

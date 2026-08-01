import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareChildProcessCommand } from "../src/core/child-process-command.js";

const execFileAsync = promisify(execFile);
const win32It = it.skipIf(process.platform !== "win32");

describe("child process command preparation", () => {
  it("routes Windows command scripts through ComSpec", () => {
    expect(
      prepareChildProcessCommand("C:\\tools\\codex.cmd", ["--version"], {
        environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        hostPlatform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "C:\\tools\\codex.cmd", "--version"],
    });
  });

  it("fails closed on command-shell metacharacters", () => {
    expect(() =>
      prepareChildProcessCommand("C:\\tools\\codex.cmd", ["safe&unsafe"], {
        hostPlatform: "win32",
      }),
    ).toThrow(/unsupported shell characters/);
  });

  win32It("executes a real Windows command script without shell mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-command-script-"));
    const script = join(directory, "codex.cmd");
    await writeFile(script, "@echo off\r\necho %1\r\n", "utf8");
    const invocation = prepareChildProcessCommand(script, ["BRIDGE_CMD_OK"]);
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(stdout.trim()).toBe("BRIDGE_CMD_OK");
  });
});

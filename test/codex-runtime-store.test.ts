import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadOfficialCodexRuntime,
  saveOfficialCodexRuntime,
} from "../src/core/codex-runtime-store.js";
import type { OfficialCodexRuntime } from "../src/core/official-codex.js";

const runtime: OfficialCodexRuntime = {
  source: "official-extension",
  executable: "/home/tester/.vscode/extensions/openai.chatgpt/bin/linux-x86_64/codex",
  extensionVersion: "26.715.61943",
  codexVersion: "0.145.0-alpha.27",
};

describe("official Codex runtime storage", () => {
  it("atomically stores validated metadata with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-runtime-"));
    const path = join(directory, "state", "official-codex-runtime.json");
    await saveOfficialCodexRuntime(path, runtime);

    expect(await loadOfficialCodexRuntime(path)).toEqual(runtime);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(runtime);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects invalid and missing metadata instead of falling back to a CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-runtime-invalid-"));
    const path = join(directory, "official-codex-runtime.json");
    await writeFile(path, JSON.stringify({ ...runtime, executable: "codex" }));

    await expect(loadOfficialCodexRuntime(path)).rejects.toThrowError(
      "runtime metadata is invalid",
    );
    await expect(loadOfficialCodexRuntime(join(directory, "missing.json"))).rejects.toThrowError(
      "reload the VS Code window",
    );
  });
});

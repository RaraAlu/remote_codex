import { describe, expect, it } from "vitest";
import {
  codexExecutableCandidates,
  resolveCodexExecutable,
} from "../src/extension/codex-executable.js";

describe("codexExecutableCandidates", () => {
  it("adds common local installation paths for the default command", () => {
    expect(codexExecutableCandidates("codex", "/home/tester", "linux")).toEqual([
      "codex",
      "/home/tester/.local/bin/codex",
      "/usr/local/bin/codex",
      "/usr/bin/codex",
    ]);
  });

  it("discovers the native npm Codex executable on Windows", () => {
    const candidates = codexExecutableCandidates(
      "codex",
      "C:\\Users\\tester",
      "win32",
      { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
      "x64",
      ["C:\\extensions\\openai.chatgpt\\bin\\windows-x86_64\\codex.exe"],
    );
    expect(candidates).toEqual([
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
      "C:\\Users\\tester\\.local\\bin\\codex.exe",
      "C:\\extensions\\openai.chatgpt\\bin\\windows-x86_64\\codex.exe",
      "codex.exe",
      "codex",
    ]);
    expect(
      resolveCodexExecutable("codex", {
        environment: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
        fileExists: (path) => path === candidates[0],
        homeDirectory: "C:\\Users\\tester",
        hostPlatform: "win32",
      }),
    ).toBe(candidates[0]);
  });

  it("keeps an explicitly configured executable exact", () => {
    expect(codexExecutableCandidates("/opt/codex/bin/codex", "/home/tester")).toEqual([
      "/opt/codex/bin/codex",
    ]);
  });
});

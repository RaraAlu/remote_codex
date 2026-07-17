import { describe, expect, it } from "vitest";
import { codexExecutableCandidates } from "../src/extension/codex-executable.js";

describe("codexExecutableCandidates", () => {
  it("adds common local installation paths for the default command", () => {
    expect(codexExecutableCandidates("codex", "/home/tester")).toEqual([
      "codex",
      "/home/tester/.local/bin/codex",
      "/usr/local/bin/codex",
      "/usr/bin/codex",
    ]);
  });

  it("keeps an explicitly configured executable exact", () => {
    expect(codexExecutableCandidates("/opt/codex/bin/codex", "/home/tester")).toEqual([
      "/opt/codex/bin/codex",
    ]);
  });
});

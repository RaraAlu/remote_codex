import { describe, expect, it } from "vitest";
import {
  buildWorkspaceResourceUri,
  parseWorkspaceResourceUri,
  workspaceRelativePath,
} from "../src/core/workspace-resource-uri.js";

describe("workspace resource URI", () => {
  it("round-trips a stable remote identity without exposing an absolute path", () => {
    const uri = buildWorkspaceResourceUri({
      host: "test_40",
      relativePath: "src/空 格.ts",
      rootId: "remote-primary",
      target: "remote",
    });

    expect(uri).toContain("codex-bridge://workspace/remote-primary/");
    expect(uri).not.toContain("/home/zkbot/work/train");
    expect(parseWorkspaceResourceUri(uri)).toEqual({
      host: "test_40",
      relativePath: "src/空 格.ts",
      rootId: "remote-primary",
      target: "remote",
    });
  });

  it("keeps a verified snapshot revision in the identity", () => {
    const revision = "a".repeat(64);
    const uri = buildWorkspaceResourceUri({
      host: "test_40",
      relativePath: "src/main.ts",
      revision,
      rootId: "remote-primary",
      target: "remote",
    });

    expect(parseWorkspaceResourceUri(uri).revision).toBe(revision);
  });

  it.each([
    "file:///tmp/a",
    "codex-bridge://other/root/a?host=test_40&target=remote",
    "codex-bridge://workspace/root/%2e%2e/a?host=test_40&target=remote",
    "codex-bridge://workspace/root/a%2Fb?host=test_40&target=remote",
    "codex-bridge://workspace/root/a?host=test_40&target=remote&target=local",
    "codex-bridge://workspace/root/a?host=test_40&target=remote&token=secret",
  ])("rejects malformed or ambiguous identities: %s", (uri) => {
    expect(() => parseWorkspaceResourceUri(uri)).toThrow();
  });
});

describe("workspace relative resource paths", () => {
  it("normalizes remote absolute and relative paths below the root", () => {
    expect(
      workspaceRelativePath(
        "/home/zkbot/work/train/zklab/Zklab",
        "/home/zkbot/work/train/zklab/Zklab/src/main.py",
        "remote",
      ),
    ).toBe("src/main.py");
    expect(
      workspaceRelativePath(
        "/home/zkbot/work/train/zklab/Zklab",
        "src/main.py",
        "remote",
      ),
    ).toBe("src/main.py");
  });

  it("rejects root identity and traversal", () => {
    expect(() => workspaceRelativePath("/workspace", "/workspace", "remote")).toThrow();
    expect(() =>
      workspaceRelativePath("/workspace", "/workspace-other/file", "remote"),
    ).toThrow();
    expect(() => workspaceRelativePath("/workspace", "../escape", "remote")).toThrow();
  });
});

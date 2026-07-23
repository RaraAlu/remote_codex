import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/core/errors.js";
import {
  officialCodexExecutable,
  resolveOfficialCodexExecutable,
  validateBundledCodexProtocol,
  type OfficialCodexRuntime,
} from "../src/core/official-codex.js";

const runtime: OfficialCodexRuntime = {
  source: "official-extension",
  executable: "/home/tester/.vscode/extensions/openai.chatgpt/bin/linux-x86_64/codex",
  extensionVersion: "26.715.61943",
  codexVersion: "0.145.0-alpha.27",
};

describe("official Codex runtime", () => {
  it("derives only the bundled Linux x64 executable", () => {
    expect(
      officialCodexExecutable(
        "/home/tester/.vscode/extensions/openai.chatgpt",
        "linux",
        "x64",
      ),
    ).toBe(
      "/home/tester/.vscode/extensions/openai.chatgpt/bin/linux-x86_64/codex",
    );
  });

  it("derives only the bundled Windows x64 executable", () => {
    expect(
      officialCodexExecutable(
        "C:\\Users\\tester\\.vscode\\extensions\\openai.chatgpt",
        "win32",
        "x64",
      ),
    ).toBe(
      "C:\\Users\\tester\\.vscode\\extensions\\openai.chatgpt\\bin\\windows-x86_64\\codex.exe",
    );
  });

  it("fails closed for unsupported platforms and missing bundled runtimes", () => {
    expect(() =>
      officialCodexExecutable("/extensions/openai.chatgpt", "darwin", "x64"),
    ).toThrowError(BridgeError);
    expect(() =>
      officialCodexExecutable("/extensions/openai.chatgpt", "linux", "arm64"),
    ).toThrowError(BridgeError);
    expect(() =>
      resolveOfficialCodexExecutable("/extensions/openai.chatgpt", {
        architecture: "x64",
        fileExists: () => false,
        hostPlatform: "linux",
      }),
    ).toThrowError("does not contain the expected bundled runtime");
  });

  it("records any official extension version but requires its bundled protocol version", () => {
    expect(() =>
      validateBundledCodexProtocol(runtime, runtime.codexVersion),
    ).not.toThrow();
    expect(() =>
      validateBundledCodexProtocol(
        { ...runtime, extensionVersion: "26.999.0" },
        runtime.codexVersion,
      ),
    ).not.toThrow();
    expect(() =>
      validateBundledCodexProtocol(runtime, "0.999.0"),
    ).toThrowError("incompatible with generated bridge protocol");
  });
});

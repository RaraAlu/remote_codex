import { describe, expect, it } from "vitest";
import {
  resolveSshExecutable,
  sshExecutableCandidates,
} from "../src/core/ssh-executable.js";

describe("Windows OpenSSH discovery", () => {
  it("prefers the Windows built-in OpenSSH client", () => {
    const environment = { SystemRoot: "C:\\Windows" };
    expect(sshExecutableCandidates("ssh", environment, "win32")).toContain(
      "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    );
    expect(
      resolveSshExecutable("ssh", {
        environment,
        fileExists: (path) => path === "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
        hostPlatform: "win32",
      }),
    ).toBe("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
  });

  it("preserves an explicitly configured SSH executable", () => {
    expect(
      sshExecutableCandidates("D:\\OpenSSH\\ssh.exe", {}, "win32"),
    ).toEqual(["D:\\OpenSSH\\ssh.exe"]);
  });
});

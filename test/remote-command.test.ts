import { describe, expect, it } from "vitest";
import {
  formatRemoteCommand,
  formatRemoteExecRequest,
  parseRemoteExecArguments,
} from "../src/shim/remote-command.js";

describe("remote command arguments", () => {
  it("keeps argv structured and bounds the execution timeout", () => {
    expect(
      parseRemoteExecArguments({
        argv: ["bash", "-lc", "printf '%s' \"$HOME\""],
        cwd: "src",
        env: { MODE: "test", REMOVE_ME: null },
        timeoutMs: 9_000_000,
      }),
    ).toEqual({
      argv: ["bash", "-lc", "printf '%s' \"$HOME\""],
      cwd: "src",
      env: { MODE: "test", REMOVE_ME: null },
      timeoutMs: 3_600_000,
    });
  });

  it("rejects mixed or NUL-bearing argv values", () => {
    expect(() => parseRemoteExecArguments({ argv: ["git", 7] })).toThrow(
      "NUL-free strings",
    );
    expect(() => parseRemoteExecArguments({ argv: ["printf", "bad\0value"] })).toThrow(
      "NUL-free strings",
    );
  });

  it("formats the exact approval command without shell reinterpreting argv", () => {
    expect(formatRemoteCommand(["bash", "-lc", "printf '%s' \"$HOME\""])).toBe(
      "bash -lc 'printf '\"'\"'%s'\"'\"' \"$HOME\"'",
    );
    expect(
      formatRemoteExecRequest({
        argv: ["printf", "hello"],
        env: { REMOVE_ME: null, MODE: "remote test" },
      }),
    ).toBe("env -u REMOVE_ME 'MODE=remote test' printf hello");
  });
});

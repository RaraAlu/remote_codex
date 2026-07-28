import { describe, expect, it } from "vitest";
import {
  activeBridgeConfigPath,
  bridgeConfigPath,
  bridgeRemoteControlDir,
  bridgeSessionConfigPath,
  bridgeStateDir,
} from "../src/core/locations.js";

describe("bridge window session locations", () => {
  it("does not activate the bridge without an explicit window session", () => {
    expect(activeBridgeConfigPath({})).toBeNull();
  });

  it("prefers a per-window session over the explicit legacy config override", () => {
    expect(
      activeBridgeConfigPath({
        CODEX_BRIDGE_CONFIG: "/tmp/global.json",
        CODEX_BRIDGE_SESSION_CONFIG: "/tmp/session.json",
      }),
    ).toBe("/tmp/session.json");
  });

  it("keys remote session config by the local extension host process", () => {
    expect(
      bridgeSessionConfigPath(4242, {
        CODEX_BRIDGE_STATE_DIR: "/tmp/bridge-state",
      }, "linux"),
    ).toBe("/tmp/bridge-state/sessions/4242.json");
  });

  it("assigns a stable isolated control directory to each remote workspace", () => {
    const environment = {
      CODEX_BRIDGE_STATE_DIR: "/tmp/bridge-state",
    };
    const first = bridgeRemoteControlDir(
      "g1_1",
      "/home/unitree/mimiclite-sim2real",
      environment,
      "linux",
    );
    expect(first).toMatch(
      /^\/tmp\/bridge-state\/remote-control\/[0-9a-f]{32}$/,
    );
    expect(
      bridgeRemoteControlDir(
        "g1_1",
        "/home/unitree/mimiclite-sim2real",
        environment,
        "linux",
      ),
    ).toBe(first);
    expect(
      bridgeRemoteControlDir(
        "g1_1",
        "/home/unitree/another-project",
        environment,
        "linux",
      ),
    ).not.toBe(first);
  });

  it("uses Windows application data directories for persistent state", () => {
    const environment = {
      APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    };
    expect(bridgeConfigPath(environment, "win32", "C:\\Users\\tester")).toBe(
      "C:\\Users\\tester\\AppData\\Roaming\\codex-remote-bridge\\config.json",
    );
    expect(bridgeStateDir(environment, "win32", "C:\\Users\\tester")).toBe(
      "C:\\Users\\tester\\AppData\\Local\\codex-remote-bridge",
    );
    expect(bridgeSessionConfigPath(4242, environment, "win32", "C:\\Users\\tester")).toBe(
      "C:\\Users\\tester\\AppData\\Local\\codex-remote-bridge\\sessions\\4242.json",
    );
    expect(
      bridgeRemoteControlDir(
        "g1_1",
        "/home/unitree/project",
        environment,
        "win32",
        "C:\\Users\\tester",
      ),
    ).toMatch(
      /^C:\\Users\\tester\\AppData\\Local\\codex-remote-bridge\\remote-control\\[0-9a-f]{32}$/,
    );
  });

  it("preserves XDG roots and appends the bridge directory on Linux", () => {
    const environment = {
      XDG_CONFIG_HOME: "/custom/config",
      XDG_STATE_HOME: "/custom/state",
    };
    expect(bridgeConfigPath(environment, "linux", "/home/tester")).toBe(
      "/custom/config/codex-remote-bridge/config.json",
    );
    expect(bridgeStateDir(environment, "linux", "/home/tester")).toBe(
      "/custom/state/codex-remote-bridge",
    );
  });

  it("uses POSIX separators for injected Linux homes on a Windows test host", () => {
    expect(bridgeConfigPath({}, "linux", "/home/tester")).toBe(
      "/home/tester/.config/codex-remote-bridge/config.json",
    );
    expect(bridgeStateDir({}, "linux", "/home/tester")).toBe(
      "/home/tester/.local/state/codex-remote-bridge",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  activeBridgeConfigPath,
  bridgeSessionConfigPath,
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
      }),
    ).toBe("/tmp/bridge-state/sessions/4242.json");
  });
});

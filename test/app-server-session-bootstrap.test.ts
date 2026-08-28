import { describe, expect, it } from "vitest";
import {
  appServerSessionBootstrapFingerprint,
  shouldReloadForAppServerSession,
} from "../src/extension/app-server-session-bootstrap.js";

describe("app-server session bootstrap", () => {
  const fingerprint = appServerSessionBootstrapFingerprint({
    bridgeVersion: "0.3.78",
    host: "data",
    vscodeVersion: "1.135.0",
    workspaceRoot: "/home/zkbot",
  });

  it("requests one reload when Codex started before the window session existed", () => {
    expect(
      shouldReloadForAppServerSession(false, undefined, fingerprint),
    ).toBe(true);
    expect(
      shouldReloadForAppServerSession(false, fingerprint, fingerprint),
    ).toBe(false);
  });

  it("does not reload an already attached Shim", () => {
    expect(
      shouldReloadForAppServerSession(true, undefined, fingerprint),
    ).toBe(false);
  });

  it("allows one new bootstrap reload for another remote root", () => {
    const next = appServerSessionBootstrapFingerprint({
      bridgeVersion: "0.3.78",
      host: "data",
      vscodeVersion: "1.135.0",
      workspaceRoot: "/home/zkbot/project",
    });
    expect(
      shouldReloadForAppServerSession(false, fingerprint, next),
    ).toBe(true);
  });
});

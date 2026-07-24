import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GENERATED_PROTOCOL_SNAPSHOT_VERSION } from "../src/core/compatibility.js";
import {
  BLOCKED_LOCAL_CLIENT_METHODS,
  isLocalClientRiskNamespace,
} from "../src/shim/local-core-policy.js";
import { KNOWN_SERVER_REQUESTS } from "../src/shim/proxy.js";

interface ServerRequestSchema {
  oneOf: Array<{
    properties: {
      method: {
        enum: [string];
      };
    };
  }>;
}

interface ProtocolManifest {
  codexVersion: string;
  sourceExtensionVersion: string;
}

interface ObjectSchema {
  properties: Record<string, unknown>;
}

async function currentProtocolPath(relativePath: string): Promise<string> {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    codexProtocolSnapshotVersion: string;
  };
  return `protocol/${packageJson.codexProtocolSnapshotVersion}/${relativePath}`;
}

describe("generated app-server protocol compatibility", () => {
  it("keeps the generated protocol manifest synchronized with diagnostic metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      codexProtocolSnapshotVersion: string;
    };
    const manifest = JSON.parse(
      await readFile(await currentProtocolPath("manifest.json"), "utf8"),
    ) as ProtocolManifest;
    expect(manifest.codexVersion).toBe(packageJson.codexProtocolSnapshotVersion);
    expect(manifest.sourceExtensionVersion).toMatch(/^\d+\./);
    expect(GENERATED_PROTOCOL_SNAPSHOT_VERSION).toBe(
      packageJson.codexProtocolSnapshotVersion,
    );
  });

  it("keeps the fail-closed server request allowlist synchronized", async () => {
    const schema = JSON.parse(
      await readFile(await currentProtocolPath("ServerRequest.json"), "utf8"),
    ) as ServerRequestSchema;
    const generatedMethods = schema.oneOf.map(
      (entry) => entry.properties.method.enum[0],
    );
    expect([...KNOWN_SERVER_REQUESTS].sort()).toEqual(generatedMethods.sort());
  });

  it("keeps the blocked local client request set synchronized", async () => {
    const schema = JSON.parse(
      await readFile(await currentProtocolPath("ClientRequest.json"), "utf8"),
    ) as ServerRequestSchema;
    const generatedRiskMethods = schema.oneOf
      .map((entry) => entry.properties.method.enum[0])
      .filter(isLocalClientRiskNamespace);
    expect([...BLOCKED_LOCAL_CLIENT_METHODS].sort()).toEqual(
      generatedRiskMethods.sort(),
    );
  });

  it("tracks the turn fields used for remote workspace identity and reminders", async () => {
    const schema = JSON.parse(
      await readFile(await currentProtocolPath("v2/TurnStartParams.json"), "utf8"),
    ) as ObjectSchema;
    expect(schema.properties).toHaveProperty("runtimeWorkspaceRoots");
    expect(schema.properties).toHaveProperty("additionalContext");
  });

  it("tracks every thread field used to prevent permission relaxation", async () => {
    const settings = JSON.parse(
      await readFile(
        await currentProtocolPath("v2/ThreadSettingsUpdateParams.json"),
        "utf8",
      ),
    ) as ObjectSchema;
    expect(settings.properties).toHaveProperty("approvalPolicy");
    expect(settings.properties).toHaveProperty("cwd");
    expect(settings.properties).toHaveProperty("permissions");
    expect(settings.properties).toHaveProperty("sandboxPolicy");

    const fork = JSON.parse(
      await readFile(await currentProtocolPath("v2/ThreadForkParams.json"), "utf8"),
    ) as ObjectSchema;
    expect(fork.properties).toHaveProperty("approvalPolicy");
    expect(fork.properties).toHaveProperty("config");
    expect(fork.properties).toHaveProperty("cwd");
    expect(fork.properties).toHaveProperty("permissions");
    expect(fork.properties).toHaveProperty("runtimeWorkspaceRoots");
    expect(fork.properties).toHaveProperty("sandbox");
  });
});

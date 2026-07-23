import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GENERATED_CODEX_APP_SERVER_VERSION } from "../src/core/compatibility.js";
import { KNOWN_SERVER_REQUESTS } from "../src/shim/proxy.js";

interface ServerRequestSchema {
  oneOf: Array<{
    properties: {
      method: {
        enum: string[];
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
    codexAppServerVersion: string;
  };
  return `protocol/${packageJson.codexAppServerVersion}/${relativePath}`;
}

describe("generated app-server protocol compatibility", () => {
  it("keeps the generated protocol manifest synchronized with the package pin", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      codexAppServerVersion: string;
    };
    const manifest = JSON.parse(
      await readFile(await currentProtocolPath("manifest.json"), "utf8"),
    ) as ProtocolManifest;
    expect(manifest.codexVersion).toBe(packageJson.codexAppServerVersion);
    expect(manifest.sourceExtensionVersion).toMatch(/^\d+\./);
    expect(GENERATED_CODEX_APP_SERVER_VERSION).toBe(
      packageJson.codexAppServerVersion,
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

  it("tracks the turn fields used for remote workspace identity and reminders", async () => {
    const schema = JSON.parse(
      await readFile(await currentProtocolPath("v2/TurnStartParams.json"), "utf8"),
    ) as ObjectSchema;
    expect(schema.properties).toHaveProperty("runtimeWorkspaceRoots");
    expect(schema.properties).toHaveProperty("additionalContext");
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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
});

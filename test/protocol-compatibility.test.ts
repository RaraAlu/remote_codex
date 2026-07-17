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

describe("generated app-server protocol compatibility", () => {
  it("keeps the fail-closed server request allowlist synchronized", async () => {
    const schema = JSON.parse(
      await readFile("protocol/0.144.3/ServerRequest.json", "utf8"),
    ) as ServerRequestSchema;
    const generatedMethods = schema.oneOf.map(
      (entry) => entry.properties.method.enum[0],
    );
    expect([...KNOWN_SERVER_REQUESTS].sort()).toEqual(generatedMethods.sort());
  });
});

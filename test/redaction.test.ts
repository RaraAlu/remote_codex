import { describe, expect, it } from "vitest";
import { redact } from "../src/core/redaction.js";

describe("redact", () => {
  it("redacts sensitive fields and inline bearer tokens recursively", () => {
    expect(
      redact({
        host: "training-gpu",
        authorization: "Bearer abc.def.ghi",
        nested: {
          refreshToken: "secret-value",
          message: "header Bearer abcdefghijklmnop",
        },
      }),
    ).toEqual({
      host: "training-gpu",
      authorization: "[REDACTED]",
      nested: {
        refreshToken: "[REDACTED]",
        message: "header [REDACTED]",
      },
    });
  });
});

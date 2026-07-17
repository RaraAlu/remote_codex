import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/core/errors.js";
import { isPathInside, normalizeRemotePath } from "../src/core/path-policy.js";

const root = "/home/zkbot/work/train/MimicLite";

describe("remote path policy", () => {
  it("normalizes relative and absolute paths inside the root", () => {
    expect(normalizeRemotePath(root, "src/../README.md")).toEqual({
      absolutePath: `${root}/README.md`,
      relativePath: "README.md",
    });
    expect(normalizeRemotePath(root, `${root}/src/main.py`).relativePath).toBe("src/main.py");
  });

  it.each(["../secret", "/etc/passwd", `${root}-copy/file`, "../../MimicLite2"])(
    "rejects paths outside the root: %s",
    (path) => {
      expect(() => normalizeRemotePath(root, path)).toThrowError(BridgeError);
    },
  );

  it("does not confuse a sibling with a shared string prefix", () => {
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, `${root}/src`)).toBe(true);
    expect(isPathInside(root, `${root}-backup`)).toBe(false);
  });
});

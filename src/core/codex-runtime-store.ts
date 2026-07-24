import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { BridgeError } from "./errors.js";
import { chmodIfSupported } from "./file-permissions.js";
import type { OfficialCodexRuntime } from "./official-codex.js";

function parseOfficialCodexRuntime(value: unknown): OfficialCodexRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("INVALID_CONFIG", "Official Codex runtime metadata is invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    input.source !== "official-extension" ||
    typeof input.executable !== "string" ||
    !isAbsolute(input.executable) ||
    normalize(input.executable) !== input.executable
  ) {
    throw new BridgeError("INVALID_CONFIG", "Official Codex runtime metadata is invalid");
  }
  return {
    source: "official-extension",
    executable: input.executable,
    extensionVersion:
      typeof input.extensionVersion === "string" && input.extensionVersion
        ? input.extensionVersion
        : null,
    codexVersion:
      typeof input.codexVersion === "string" && input.codexVersion
        ? input.codexVersion
        : null,
  };
}

export async function loadOfficialCodexRuntime(path: string): Promise<OfficialCodexRuntime> {
  try {
    return parseOfficialCodexRuntime(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Official Codex runtime metadata is unavailable; reload the VS Code window",
      );
    }
    if (error instanceof SyntaxError) {
      throw new BridgeError("INVALID_CONFIG", "Official Codex runtime metadata is not valid JSON");
    }
    throw error;
  }
}

export async function saveOfficialCodexRuntime(
  path: string,
  runtime: OfficialCodexRuntime,
): Promise<void> {
  const validated = parseOfficialCodexRuntime(runtime);
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmodIfSupported(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmodIfSupported(path, 0o600);
}

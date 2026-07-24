import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { BridgeError } from "./errors.js";
import type { WorkspacePatchReplacement } from "./types.js";

export const MAX_WORKSPACE_WRITE_BYTES = 1024 * 1024;
export const MAX_WORKSPACE_PATCH_REPLACEMENTS = 64;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function validateExpectedHash(
  value: string | undefined,
  required: boolean,
): string | undefined {
  if (value === undefined) {
    if (required) {
      throw new BridgeError(
        "FILE_CONFLICT",
        "expectedHash is required for an existing file",
      );
    }
    return undefined;
  }
  if (!SHA256_PATTERN.test(value)) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      "expectedHash must be a lowercase SHA-256 digest",
    );
  }
  return value;
}

export function decodeWorkspaceContent(
  contentBase64: string,
  maxBytes = MAX_WORKSPACE_WRITE_BYTES,
): Buffer {
  if (
    typeof contentBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      contentBase64,
    )
  ) {
    throw new BridgeError("PROTOCOL_MISMATCH", "contentBase64 must be valid base64");
  }
  const content = Buffer.from(contentBase64, "base64");
  if (content.length > maxBytes) {
    throw new BridgeError(
      "OUTPUT_TRUNCATED",
      "Workspace write exceeds the configured byte limit",
      { limitBytes: maxBytes, size: content.length },
    );
  }
  return content;
}

export function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function applyWorkspacePatch(
  content: Buffer,
  replacements: readonly WorkspacePatchReplacement[],
): Buffer {
  if (
    !Array.isArray(replacements) ||
    replacements.length < 1 ||
    replacements.length > MAX_WORKSPACE_PATCH_REPLACEMENTS
  ) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      `replacements must contain 1 to ${MAX_WORKSPACE_PATCH_REPLACEMENTS} entries`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new BridgeError(
      "COMMAND_DENIED",
      "Workspace patches require a valid UTF-8 text file",
      undefined,
      { cause: error },
    );
  }

  for (const replacement of replacements) {
    if (
      !replacement ||
      typeof replacement !== "object" ||
      typeof replacement.oldText !== "string" ||
      typeof replacement.newText !== "string" ||
      replacement.oldText.length === 0
    ) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Each replacement requires non-empty oldText and string newText",
      );
    }
    const first = text.indexOf(replacement.oldText);
    if (first < 0) {
      throw new BridgeError(
        "FILE_CONFLICT",
        "Patch source text was not found in the current file",
      );
    }
    if (text.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
      throw new BridgeError(
        "FILE_CONFLICT",
        "Patch source text is ambiguous in the current file",
      );
    }
    text =
      text.slice(0, first) +
      replacement.newText +
      text.slice(first + replacement.oldText.length);
  }
  return Buffer.from(text, "utf8");
}

import type { BridgeErrorCode, BridgeErrorPayload } from "./types.js";

const RETRYABLE_CODES = new Set<BridgeErrorCode>([
  "SSH_DISCONNECTED",
  "OUTPUT_TRUNCATED",
  "REMOTE_TRANSPORT_DISCONNECTED",
]);

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: BridgeErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
    this.retryable = RETRYABLE_CODES.has(code);
  }

  toPayload(): BridgeErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function asBridgeError(error: unknown, fallbackCode: BridgeErrorCode): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  if (error instanceof Error) {
    return new BridgeError(fallbackCode, error.message, undefined, { cause: error });
  }
  return new BridgeError(fallbackCode, String(error));
}

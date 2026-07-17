import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./redaction.js";
import type { AuditEvent } from "./types.js";

export class AuditLog {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async write(event: Omit<AuditEvent, "timestamp"> & { timestamp?: string }): Promise<void> {
    const record = redact({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });
    await mkdir(dirname(this.path), { mode: 0o700, recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }
}

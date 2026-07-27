import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { BridgeError } from "../core/errors.js";
import {
  remoteProcessEnvironment,
  signalProcessTree,
} from "../core/local-process-executor.js";
import { isPathInside, normalizeRemotePath } from "../core/path-policy.js";
import type {
  RemoteBackgroundLogEvent,
  RemoteBackgroundLogResult,
  RemoteBackgroundTaskState,
  RemoteBackgroundTaskSummary,
} from "../core/types.js";

export const BACKGROUND_TASK_MAX_COUNT = 8;
export const BACKGROUND_TASK_MAX_LOG_BYTES = 4 * 1024 * 1024;
export const BACKGROUND_TASK_MAX_LOG_READ_BYTES = 256 * 1024;
export const BACKGROUND_TASK_MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const BACKGROUND_TASK_RETENTION_MS = 15 * 60_000;

export type SpawnBackgroundProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface StartBackgroundTaskRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | null>;
  taskId: string;
  timeoutMs?: number;
  workspaceRoot: string;
}

interface LogSegment {
  channel: "stderr" | "stdout";
  content: Buffer;
  end: number;
  start: number;
}

class BoundedTaskLog {
  readonly #limit: number;
  readonly #segments: LogSegment[] = [];
  #baseCursor = 0;
  #nextCursor = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get baseCursor(): number {
    return this.#baseCursor;
  }

  get nextCursor(): number {
    return this.#nextCursor;
  }

  append(channel: LogSegment["channel"], content: Buffer): void {
    if (content.length === 0) {
      return;
    }
    const start = this.#nextCursor;
    this.#nextCursor += content.length;
    this.#segments.push({
      channel,
      content: Buffer.from(content),
      end: this.#nextCursor,
      start,
    });
    this.#prune();
  }

  read(cursor: number, limitBytes: number): {
    events: RemoteBackgroundLogEvent[];
    hasMore: boolean;
    nextCursor: number;
    truncated: boolean;
  } {
    const requestedCursor = Math.max(0, Math.floor(cursor));
    let position = Math.max(this.#baseCursor, requestedCursor);
    let remaining = Math.max(
      1,
      Math.min(Math.floor(limitBytes), BACKGROUND_TASK_MAX_LOG_READ_BYTES),
    );
    const events: RemoteBackgroundLogEvent[] = [];
    for (const segment of this.#segments) {
      if (segment.end <= position || remaining <= 0) {
        continue;
      }
      const offset = Math.max(0, position - segment.start);
      const length = Math.min(segment.content.length - offset, remaining);
      if (length <= 0) {
        continue;
      }
      events.push({
        channel: segment.channel,
        contentBase64: segment.content
          .subarray(offset, offset + length)
          .toString("base64"),
        cursor: segment.start + offset,
      });
      position = segment.start + offset + length;
      remaining -= length;
    }
    return {
      events,
      hasMore: position < this.#nextCursor,
      nextCursor: position,
      truncated: requestedCursor < this.#baseCursor,
    };
  }

  #prune(): void {
    const minimumCursor = Math.max(0, this.#nextCursor - this.#limit);
    while (
      this.#segments[0] &&
      this.#segments[0].end <= minimumCursor
    ) {
      this.#segments.shift();
    }
    const first = this.#segments[0];
    if (first && first.start < minimumCursor) {
      const offset = minimumCursor - first.start;
      first.content = first.content.subarray(offset);
      first.start = minimumCursor;
    }
    this.#baseCursor = minimumCursor;
  }
}

interface BackgroundTask {
  actualCwd: string;
  cancellationRequested: boolean;
  child: ChildProcessWithoutNullStreams;
  completedAtMs: number | null;
  descendantPids: number[];
  exitCode: number | null;
  fingerprint: string;
  forceTimer?: NodeJS.Timeout;
  log: BoundedTaskLog;
  settled: Promise<void>;
  settle: () => void;
  signal: string | null;
  startedAtMs: number;
  status: Exclude<RemoteBackgroundTaskState, "unknown">;
  taskId: string;
  timeout?: NodeJS.Timeout;
  timedOut: boolean;
  workspaceRoot: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function requestFingerprint(request: StartBackgroundTaskRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalValue({
          argv: request.argv,
          cwd: request.cwd ?? null,
          env: request.env ?? null,
          timeoutMs: request.timeoutMs ?? null,
          workspaceRoot: request.workspaceRoot,
        }),
      ),
    )
    .digest("hex");
}

function validateTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      "Background taskId must contain 1 to 64 safe characters",
    );
  }
}

function validateArgv(argv: readonly string[]): void {
  if (
    argv.length < 1 ||
    argv.length > 256 ||
    argv.some((entry) => typeof entry !== "string" || entry.includes("\0"))
  ) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      "Background argv must contain 1 to 256 NUL-free strings",
    );
  }
}

export class RemoteBackgroundTasks {
  readonly #maxLogBytes: number;
  readonly #maxTasks: number;
  readonly #retentionMs: number;
  readonly #spawn: SpawnBackgroundProcess;
  readonly #tasks = new Map<string, BackgroundTask>();

  constructor(
    spawnProcess: SpawnBackgroundProcess = spawn,
    options: {
      maxLogBytes?: number;
      maxTasks?: number;
      retentionMs?: number;
    } = {},
  ) {
    this.#spawn = spawnProcess;
    this.#maxLogBytes =
      options.maxLogBytes ?? BACKGROUND_TASK_MAX_LOG_BYTES;
    this.#maxTasks = options.maxTasks ?? BACKGROUND_TASK_MAX_COUNT;
    this.#retentionMs = options.retentionMs ?? BACKGROUND_TASK_RETENTION_MS;
  }

  async start(
    request: StartBackgroundTaskRequest,
  ): Promise<RemoteBackgroundTaskSummary> {
    this.#prune();
    validateTaskId(request.taskId);
    validateArgv(request.argv);
    const fingerprint = requestFingerprint(request);
    const taskKey = this.#taskKey(request.workspaceRoot, request.taskId);
    const existing = this.#tasks.get(taskKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new BridgeError(
          "PROTOCOL_MISMATCH",
          "Background taskId was reused with different parameters",
        );
      }
      return {
        ...this.#summary(existing),
        idempotencyOutcome:
          existing.status === "running" ? "joined" : "replayed",
      };
    }
    this.#makeCapacity();

    const lexicalCwd = normalizeRemotePath(
      request.workspaceRoot,
      request.cwd ?? request.workspaceRoot,
    ).absolutePath;
    let canonicalRoot: string;
    let actualCwd: string;
    try {
      [canonicalRoot, actualCwd] = await Promise.all([
        realpath(request.workspaceRoot),
        realpath(lexicalCwd),
      ]);
    } catch (error) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Background task working directory does not exist",
        { cwd: lexicalCwd },
        { cause: error },
      );
    }
    if (!isPathInside(canonicalRoot, actualCwd)) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Resolved background task directory escapes the workspace",
        { cwd: lexicalCwd },
      );
    }
    const timeoutMs = Math.max(
      1_000,
      Math.min(
        request.timeoutMs ?? 60 * 60_000,
        BACKGROUND_TASK_MAX_TIMEOUT_MS,
      ),
    );
    const child = this.#spawn(
      "sh",
      ["-c", 'exec "$@"', "codex-bridge-background", ...request.argv],
      {
        cwd: actualCwd,
        detached: process.platform !== "win32",
        env: remoteProcessEnvironment(request.env),
        stdio: "pipe",
      },
    );
    child.stdin.end();

    let settle = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const task: BackgroundTask = {
      actualCwd,
      cancellationRequested: false,
      child,
      completedAtMs: null,
      descendantPids: [],
      exitCode: null,
      fingerprint,
      log: new BoundedTaskLog(this.#maxLogBytes),
      settled,
      settle,
      signal: null,
      startedAtMs: Date.now(),
      status: "running",
      taskId: request.taskId,
      timedOut: false,
      workspaceRoot: request.workspaceRoot,
    };
    task.timeout = setTimeout(() => {
      if (task.status !== "running") {
        return;
      }
      task.timedOut = true;
      this.#terminate(task);
    }, timeoutMs);
    task.timeout.unref();
    this.#tasks.set(taskKey, task);

    child.stdout.on("data", (chunk: Buffer) =>
      task.log.append("stdout", chunk),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      task.log.append("stderr", chunk),
    );
    child.once("close", (exitCode, signal) => {
      this.#finish(task, exitCode, signal);
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        this.#finish(task, null, null);
        this.#tasks.delete(taskKey);
        reject(
          new BridgeError(
            "REMOTE_TRANSPORT_DISCONNECTED",
            `Failed to start background task: ${error.message}`,
            undefined,
            { cause: error },
          ),
        );
      });
    });
    return {
      ...this.#summary(task),
      idempotencyOutcome: "executed",
    };
  }

  status(workspaceRoot: string, taskId: string): RemoteBackgroundTaskSummary {
    this.#prune();
    validateTaskId(taskId);
    const task = this.#tasks.get(this.#taskKey(workspaceRoot, taskId));
    return task
      ? this.#summary(task)
      : {
          taskId,
          status: "unknown",
          actualCwd: null,
          startedAtMs: null,
          completedAtMs: null,
          exitCode: null,
          signal: null,
          cancellationRequested: false,
          logBaseCursor: 0,
          logCursor: 0,
        };
  }

  log(
    workspaceRoot: string,
    taskId: string,
    cursor = 0,
    limitBytes = BACKGROUND_TASK_MAX_LOG_READ_BYTES,
  ): RemoteBackgroundLogResult {
    this.#prune();
    validateTaskId(taskId);
    const task = this.#tasks.get(this.#taskKey(workspaceRoot, taskId));
    if (!task) {
      return {
        task: this.status(workspaceRoot, taskId),
        events: [],
        nextCursor: 0,
        truncated: false,
        hasMore: false,
      };
    }
    const page = task.log.read(cursor, limitBytes);
    return {
      task: this.#summary(task),
      ...page,
    };
  }

  async cancel(
    workspaceRoot: string,
    taskId: string,
  ): Promise<RemoteBackgroundTaskSummary> {
    this.#prune();
    validateTaskId(taskId);
    const task = this.#tasks.get(this.#taskKey(workspaceRoot, taskId));
    if (!task) {
      return this.status(workspaceRoot, taskId);
    }
    if (task.status !== "running") {
      return this.#summary(task);
    }
    task.cancellationRequested = true;
    this.#terminate(task);
    await Promise.race([
      task.settled,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
      }),
    ]);
    return this.#summary(task);
  }

  async stopWorkspace(workspaceRoot: string): Promise<number> {
    const tasks = [...this.#tasks.entries()].filter(
      ([, task]) => task.workspaceRoot === workspaceRoot,
    );
    for (const [, task] of tasks) {
      if (task.status === "running") {
        task.cancellationRequested = true;
        this.#terminate(task, true);
      }
    }
    await Promise.all(tasks.map(([, task]) => task.settled));
    for (const [taskKey, task] of tasks) {
      if (this.#tasks.get(taskKey) === task) {
        this.#tasks.delete(taskKey);
      }
    }
    return tasks.length;
  }

  close(): void {
    for (const task of this.#tasks.values()) {
      if (task.status === "running") {
        task.cancellationRequested = true;
        this.#terminate(task, true);
      }
    }
  }

  #finish(
    task: BackgroundTask,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (task.status !== "running") {
      return;
    }
    if (task.timeout) {
      clearTimeout(task.timeout);
    }
    if (task.forceTimer) {
      clearTimeout(task.forceTimer);
    }
    task.completedAtMs = Date.now();
    task.exitCode = exitCode;
    task.signal = signal;
    task.status = task.timedOut
      ? "timed_out"
      : task.cancellationRequested
        ? "cancelled"
        : exitCode === 0
          ? "completed"
          : "failed";
    task.settle();
  }

  #makeCapacity(): void {
    if (this.#tasks.size < this.#maxTasks) {
      return;
    }
    const settled = [...this.#tasks.values()]
      .filter((task) => task.status !== "running")
      .sort(
        (left, right) =>
          (left.completedAtMs ?? left.startedAtMs) -
          (right.completedAtMs ?? right.startedAtMs),
      );
    while (this.#tasks.size >= this.#maxTasks && settled[0]) {
      const task = settled.shift();
      if (task) {
        this.#tasks.delete(this.#taskKey(task.workspaceRoot, task.taskId));
      }
    }
    if (this.#tasks.size >= this.#maxTasks) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Background task capacity is full",
        { maxTasks: this.#maxTasks },
      );
    }
  }

  #prune(): void {
    const cutoff = Date.now() - this.#retentionMs;
    for (const [taskId, task] of this.#tasks) {
      if (
        task.status !== "running" &&
        task.completedAtMs !== null &&
        task.completedAtMs <= cutoff
      ) {
        this.#tasks.delete(taskId);
      }
    }
  }

  #summary(task: BackgroundTask): RemoteBackgroundTaskSummary {
    return {
      taskId: task.taskId,
      status: task.status,
      actualCwd: task.actualCwd,
      startedAtMs: task.startedAtMs,
      completedAtMs: task.completedAtMs,
      exitCode: task.exitCode,
      signal: task.signal,
      cancellationRequested: task.cancellationRequested,
      logBaseCursor: task.log.baseCursor,
      logCursor: task.log.nextCursor,
    };
  }

  #taskKey(workspaceRoot: string, taskId: string): string {
    return `${workspaceRoot}\0${taskId}`;
  }

  #terminate(task: BackgroundTask, immediate = false): void {
    if (task.timeout) {
      clearTimeout(task.timeout);
      task.timeout = undefined;
    }
    task.descendantPids = signalProcessTree(
      task.child,
      "SIGTERM",
      task.descendantPids,
    );
    if (immediate) {
      if (task.forceTimer) {
        clearTimeout(task.forceTimer);
        task.forceTimer = undefined;
      }
      task.descendantPids = signalProcessTree(
        task.child,
        "SIGKILL",
        task.descendantPids,
      );
      return;
    }
    if (task.forceTimer) {
      clearTimeout(task.forceTimer);
    }
    task.forceTimer = setTimeout(() => {
      if (task.status === "running") {
        task.descendantPids = signalProcessTree(
          task.child,
          "SIGKILL",
          task.descendantPids,
        );
      }
    }, 1_000);
    task.forceTimer.unref();
  }
}

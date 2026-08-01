import type {
  RemoteExecutionCompletedEvent,
  RemoteExecutorCommandResponse,
  RemoteOutputEvent,
} from "../core/vscode-transport.js";

export type RemoteExecutionEvent =
  | RemoteExecutionCompletedEvent
  | RemoteOutputEvent;

type EventSink = (event: RemoteExecutionEvent) => Promise<unknown>;
type EventScheduler = (callback: () => void) => unknown;

export class DeferredExecutionEvents {
  readonly #id: string;
  readonly #ready: Promise<void>;
  readonly #sink: EventSink;
  #queue = Promise.resolve();

  constructor(
    id: string,
    sink: EventSink,
    schedule: EventScheduler = (callback) => setImmediate(callback),
  ) {
    this.#id = id;
    this.#sink = sink;
    this.#ready = new Promise<void>((resolve) => schedule(resolve));
  }

  output(channel: RemoteOutputEvent["channel"], chunk: string): void {
    this.#enqueue({ channel, chunk, id: this.#id });
  }

  async complete(response: RemoteExecutorCommandResponse): Promise<void> {
    await this.#enqueue({
      event: "executionComplete",
      id: this.#id,
      response,
    });
  }

  #enqueue(event: RemoteExecutionEvent): Promise<void> {
    this.#queue = this.#queue
      .catch(() => undefined)
      .then(async () => {
        await this.#ready;
        await this.#sink(event);
      });
    return this.#queue;
  }
}

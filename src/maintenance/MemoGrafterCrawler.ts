import type {
  CrawlerConfig,
  CrawlerPassContext,
  CrawlerPassReport,
  CrawlerReport,
} from "./types.js";
import type { MemoGrafterOperationOptions } from "../core/types.js";
import { createOperationControl } from "../utils/operationControl.js";

const DEFAULT_INTERVAL_MS = 60_000;

export class MemoGrafterCrawler {
  private readonly config: Required<Pick<CrawlerConfig, "intervalMs" | "stopOnPassError">> &
    Pick<CrawlerConfig, "passes" | "store">;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private isRunning = false;
  private isExecuting = false;

  constructor(config: CrawlerConfig = {}) {
    this.config = {
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
      passes: config.passes ?? [],
      stopOnPassError: config.stopOnPassError ?? false,
      ...(config.store !== undefined ? { store: config.store } : {}),
    };
  }

  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.intervalHandle = setInterval(() => {
      void this.runScheduledTick();
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    this.isRunning = false;
  }

  async runOnce(operationOptions?: MemoGrafterOperationOptions): Promise<CrawlerReport> {
    const control = createOperationControl(operationOptions, "maintenance", "graph-processing");
    control.throwIfAborted();
    try {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const passes: CrawlerPassReport[] = [];
    const context: CrawlerPassContext = this.config.store !== undefined
      ? { store: this.config.store }
      : {};

    for (const pass of this.config.passes ?? []) {
      control.throwIfAborted();
      const passReport = await this.runPass(pass.name, () => pass.run(context));
      control.throwIfAborted();
      passes.push(passReport);

      if (!passReport.ok && this.config.stopOnPassError) {
        break;
      }
    }

    const finishedAtMs = Date.now();
    return {
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      passes,
      ok: passes.every((pass) => pass.ok),
    };
    } finally { control.dispose(); }
  }

  private async runScheduledTick(): Promise<void> {
    if (this.isExecuting) {
      return;
    }

    this.isExecuting = true;
    try {
      await this.runOnce();
    } finally {
      this.isExecuting = false;
    }
  }

  private async runPass(
    name: string,
    run: () => ReturnType<NonNullable<CrawlerConfig["passes"]>[number]["run"]>,
  ): Promise<CrawlerPassReport> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    try {
      const result = await run();
      const finishedAtMs = Date.now();
      return {
        name,
        ok: true,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        result,
      };
    } catch (error) {
      const finishedAtMs = Date.now();
      return {
        name,
        ok: false,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        error: serializeError(error),
      };
    }
  }
}

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    const serialized: { message: string; stack?: string } = {
      message: error.message,
    };

    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }

    return serialized;
  }

  return {
    message: String(error),
  };
}

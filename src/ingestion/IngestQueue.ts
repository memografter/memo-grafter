import { randomUUID } from "node:crypto";
import { Queue, Worker, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type { IngestPipeline } from "./conversation/IngestPipeline.js";
import type { IngestPipelineOptions, MemoGrafterQueueConfig, Message } from "../core/types.js";
import type { QueueJobTelemetryEvent } from "../core/types.js";
import { splitTextForIngestion } from "../utils/text/splitTextForIngestion.js";

type IngestJobData = {
  kind: "messages";
  messages: Message[];
  startIndex?: number;
  sessionId: string;
  options?: IngestPipelineOptions;
} | {
  kind: "append";
  messages: Message[];
  startIndex?: number;
  sessionId: string;
  options?: IngestPipelineOptions;
} | {
  kind: "text";
  text: string;
  sessionId: string;
  options?: IngestPipelineOptions;
};

export class IngestQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<IngestJobData>;
  private worker: Worker<IngestJobData> | null = null;
  private readonly defaultJobOptions: JobsOptions;
  private readonly queueName: string;
  private readonly telemetry: MemoGrafterQueueConfig["telemetry"];

  constructor(
    private readonly pipeline: IngestPipeline,
    config: MemoGrafterQueueConfig,
  ) {
    this.queueName = config.queueName ?? `mg-ingest-${randomUUID()}`;
    this.telemetry = config.telemetry;

    this.connection = new Redis(config.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      retryStrategy: () => null,
    });
    this.connection.on("error", (error: Error) => {
      console.warn("MemoGrafter ingest queue Redis warning:", error.message);
    });

    this.defaultJobOptions = {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: config.removeOnComplete ?? true,
      removeOnFail: config.removeOnFail ?? true,
    };

    this.queue = new Queue<IngestJobData>(this.queueName, {
      connection: this.connection,
      defaultJobOptions: this.defaultJobOptions,
    });
    this.queue.on("error", (error: Error) => {
      console.warn("MemoGrafter ingest queue warning:", error.message);
    });
  }

  async enqueue(messages: Message[], sessionId: string, options: IngestPipelineOptions = {}): Promise<void> {
    await this.enqueueIncremental(messages, sessionId, 0, options).catch(() => undefined);
  }

  async enqueueIncremental(
    messages: Message[],
    sessionId: string,
    startIndex: number,
    options: IngestPipelineOptions = {},
  ): Promise<void> {
    try {
      await this.withTimeout(
        this.queue.add(
          "ingest",
          {
            kind: "messages",
            messages: [...messages],
            startIndex,
            sessionId,
            options,
          },
          this.defaultJobOptions,
        ),
        1000,
        "MemoGrafter ingest queue enqueue timed out.",
      );
      this.ensureWorker();
    } catch (error) {
      console.warn("MemoGrafter ingest queue enqueue failed:", error);
      throw error;
    }
  }

  async enqueueAppend(
    messages: Message[],
    sessionId: string,
    options: IngestPipelineOptions = {},
  ): Promise<void> {
    try {
      const { startIndex } = await this.pipeline.stageAppend(messages, sessionId);
      await this.withTimeout(
        this.queue.add(
          "ingest-append",
          { kind: "append", messages: [...messages], startIndex, sessionId, options },
          this.defaultJobOptions,
        ),
        1000,
        "MemoGrafter append ingest queue enqueue timed out.",
      );
      this.ensureWorker();
    } catch (error) {
      console.warn("MemoGrafter append ingest queue enqueue failed:", error);
      throw error;
    }
  }

  async enqueueText(text: string, sessionId: string, options: IngestPipelineOptions = {}): Promise<void> {
    try {
      await this.withTimeout(
        this.queue.add(
          "ingest-text",
          {
            kind: "text",
            text,
            sessionId,
            options,
          },
          this.defaultJobOptions,
        ),
        1000,
        "MemoGrafter text ingest queue enqueue timed out.",
      );
      this.ensureWorker();
    } catch (error) {
      console.warn("MemoGrafter text ingest queue enqueue failed:", error);
    }
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.withTimeout(this.worker.close(false), 10000, "MemoGrafter ingest queue worker close timed out.").catch((error: unknown) => {
        console.warn("MemoGrafter ingest queue worker close warning:", error);
      });
    }
    await this.withTimeout(this.queue.close(), 1000, "MemoGrafter ingest queue close timed out.").catch((error: unknown) => {
      console.warn("MemoGrafter ingest queue close warning:", error);
    });
    if (this.worker) {
      await Promise.resolve(this.worker.disconnect()).catch((error: unknown) => {
        console.warn("MemoGrafter ingest queue worker disconnect warning:", error);
      });
    }
    await Promise.resolve(this.queue.disconnect()).catch((error: unknown) => {
      console.warn("MemoGrafter ingest queue disconnect warning:", error);
    });
    this.connection.disconnect();
  }

  private ensureWorker(): void {
    if (this.worker) return;

    this.worker = new Worker<IngestJobData>(
      this.queueName,
      async (job) => {
        try {
          if (job.data.kind === "text") {
            await this.pipeline.runText(job.data.text, job.data.sessionId, job.data.options ?? {});
            return;
          }

          if (job.data.kind === "append") {
            if (job.data.startIndex === undefined) {
              await this.pipeline.append(job.data.messages, job.data.sessionId, job.data.options ?? {});
            } else {
              await this.pipeline.runPersistedAppend(
                job.data.messages,
                job.data.sessionId,
                job.data.startIndex,
                job.data.options ?? {},
              );
            }
            return;
          }

          await this.pipeline.runIncremental(
            job.data.messages,
            job.data.sessionId,
            job.data.startIndex ?? 0,
            job.data.options ?? {},
          );
        } catch (error) {
          console.warn("MemoGrafter background ingest failed:", error);
          throw error;
        }
      },
      { connection: this.connection },
    );

    this.worker.on("failed", (_job, error) => {
      console.warn("MemoGrafter ingest queue worker warning:", error.message);
    });
    this.worker.on("completed", (job) => {
      this.reportQueueEvent(this.telemetry?.onJobCompleted, job, Date.now());
    });
    this.worker.on("failed", (job) => {
      if (job) this.reportQueueEvent(this.telemetry?.onJobFailed, job, Date.now());
    });
    this.worker.on("error", (error) => {
      console.warn("MemoGrafter ingest queue worker warning:", error.message);
    });
  }

  private reportQueueEvent(
    callback: ((event: QueueJobTelemetryEvent) => void) | undefined,
    job: { id?: string; data: IngestJobData; timestamp: number; processedOn?: number },
    completedAt: number,
  ): void {
    if (!callback) return;
    safelyReportQueueTelemetry(callback, {
      jobId: job.id ?? "unknown",
      kind: job.data.kind,
      messageCount: countIngestJobMessages(job.data),
      payloadBytes: serializedIngestJobBytes(job.data),
      queuedAt: job.timestamp,
      startedAt: job.processedOn ?? job.timestamp,
      completedAt,
    });
  }

  private async withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export function countIngestJobMessages(data: IngestJobData): number {
  return data.kind === "text" ? splitTextForIngestion(data.text).length : data.messages.length;
}

export function serializedIngestJobBytes(data: IngestJobData): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

export function safelyReportQueueTelemetry(
  callback: ((event: QueueJobTelemetryEvent) => void) | undefined,
  event: QueueJobTelemetryEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // Observability must never affect queue behavior.
  }
}

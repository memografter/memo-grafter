import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type { IngestPipeline } from "./conversation/IngestPipeline.js";
import type { IngestPipelineOptions, MemoGrafterQueueConfig, Message } from "../core/types.js";
import type { QueueJobTelemetryEvent } from "../core/types.js";
import { splitTextForIngestion } from "../utils/text/splitTextForIngestion.js";
import type { GraphStore } from "../store/index.js";
import type { IngestionEvent, IngestionRun } from "./types.js";

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
} | {
  kind: "run";
  ingestionRunId: string;
  sessionId: string;
  startIndex: number;
  endIndex: number;
  options?: IngestPipelineOptions;
};

export class IngestQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<IngestJobData>;
  private worker: Worker<IngestJobData> | null = null;
  private readonly defaultJobOptions: JobsOptions;
  private readonly queueName: string;
  private readonly telemetry: MemoGrafterQueueConfig["telemetry"];
  private readonly enqueueTimeoutMs: number;
  private readonly processingTimeoutMs: number;

  constructor(
    private readonly pipeline: IngestPipeline,
    config: MemoGrafterQueueConfig,
    private readonly store?: GraphStore,
  ) {
    this.queueName = config.queueName ?? `mg-ingest-${randomUUID()}`;
    this.telemetry = config.telemetry;
    this.enqueueTimeoutMs = config.enqueueTimeoutMs ?? 1000;
    this.processingTimeoutMs = config.processingTimeoutMs ?? 60_000;

    this.connection = new Redis(config.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      retryStrategy: () => null,
    });
    this.connection.on("error", (error: Error) => {
      console.warn("MemoGrafter ingest queue Redis warning:", error.message);
    });

    this.defaultJobOptions = {
      attempts: config.attempts ?? 3,
      backoff: {
        type: config.backoff?.type ?? "exponential",
        delay: config.backoff?.delayMs ?? 1000,
      },
      removeOnComplete: config.removeOnComplete ?? true,
      removeOnFail: config.removeOnFail ?? false,
    };

    this.queue = new Queue<IngestJobData>(this.queueName, {
      connection: this.connection,
      defaultJobOptions: this.defaultJobOptions,
    });
    this.queue.on("error", (error: Error) => {
      console.warn("MemoGrafter ingest queue warning:", error.message);
    });
  }

  getQueueName(): string { return this.queueName; }

  async enqueueRun(run: IngestionRun, options: IngestPipelineOptions = {}): Promise<{ id: string; queueName: string }> {
    if (!this.store?.transitionIngestionRun) throw new Error("Durable queue ingestion requires ingestion-run store support.");
    try {
      this.reportLifecycle(this.telemetry?.onAccepted, run, "accepted");
      let job: Job<IngestJobData> | undefined = await this.queue.getJob(run.id);
      if (job && await job.getState() === "failed") await job.retry();
      if (!job) job = await this.withTimeout(this.queue.add("ingestion-run", { kind: "run", ingestionRunId: run.id, sessionId: run.sessionId, startIndex: run.startIndex, endIndex: run.endIndex, options }, { ...this.defaultJobOptions, jobId: run.id }), this.enqueueTimeoutMs, "MemoGrafter ingestion-run enqueue timed out.");
      if (!job) throw new Error("MemoGrafter queue did not return an ingestion job.");
      const queued = await this.store.transitionIngestionRun({ runId: run.id, from: ["accepted", "retry_pending"], to: "queued" });
      this.reportLifecycle(this.telemetry?.onQueued, queued, "queued", job.id);
      this.ensureWorker();
      return { id: job.id ?? run.id, queueName: this.queueName };
    } catch (error) {
      const current = await this.store.getIngestionRun?.(run.id);
      if (current && ["running", "completed", "completed_with_warnings"].includes(current.status)) return { id: run.id, queueName: this.queueName };
      await this.store.transitionIngestionRun({ runId: run.id, from: ["accepted"], to: "retry_pending", error: { message: "Queue enqueue failed.", retryable: true } }).catch(() => undefined);
      throw error;
    }
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

  async close(options: { strict?: boolean } = {}): Promise<void> {
    const failures: string[] = [];
    if (this.worker) {
      await this.withTimeout(this.worker.close(false), 10000, "MemoGrafter ingest queue worker close timed out.").catch((error: unknown) => {
        failures.push(error instanceof Error ? error.message : "Worker close failed.");
        console.warn("MemoGrafter ingest queue worker close warning:", error);
      });
    }
    await this.withTimeout(this.queue.close(), 1000, "MemoGrafter ingest queue close timed out.").catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : "Queue close failed.");
      console.warn("MemoGrafter ingest queue close warning:", error);
    });
    if (this.worker) {
      await Promise.resolve(this.worker.disconnect()).catch((error: unknown) => {
        failures.push(error instanceof Error ? error.message : "Worker disconnect failed.");
        console.warn("MemoGrafter ingest queue worker disconnect warning:", error);
      });
    }
    await Promise.resolve(this.queue.disconnect()).catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : "Queue disconnect failed.");
      console.warn("MemoGrafter ingest queue disconnect warning:", error);
    });
    this.connection.disconnect();
    if (options.strict && failures.length) throw new Error(failures.join("; "));
  }

  private ensureWorker(): void {
    if (this.worker) return;

    this.worker = new Worker<IngestJobData>(
      this.queueName,
      async (job) => {
        try {
          if (job.data.kind === "run") {
            const run = await this.store?.getIngestionRun?.(job.data.ingestionRunId);
            if (!run) throw new Error(`Ingestion run ${job.data.ingestionRunId} was not found.`);
            this.reportLifecycle(this.telemetry?.onStarted, { ...run, attemptCount: run.attemptCount + 1 }, "started", job.id);
            await this.pipeline.processIngestionRun(run, job.data.options ?? {}, `bullmq-${job.id ?? "unknown"}`, this.processingTimeoutMs);
            return;
          }
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
      { connection: this.connection, lockDuration: this.processingTimeoutMs },
    );

    this.worker.on("failed", (_job, error) => {
      console.warn("MemoGrafter ingest queue worker warning:", error.message);
    });
    this.worker.on("completed", (job) => {
      this.reportQueueEvent(this.telemetry?.onJobCompleted, job, Date.now());
      if (job.data.kind === "run") void this.store?.getIngestionRun?.(job.data.ingestionRunId).then((run) => { if (run) this.reportLifecycle(run.status === "completed_with_warnings" ? this.telemetry?.onCompletedWithWarnings : this.telemetry?.onCompleted, run, run.status === "completed_with_warnings" ? "completed_with_warnings" : "completed", job.id); });
    });
    this.worker.on("failed", (job) => {
      if (job) this.reportQueueEvent(this.telemetry?.onJobFailed, job, Date.now());
      if (job?.data.kind === "run") void this.handleRunFailure(job);
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

  private reportLifecycle(callback: ((event: IngestionEvent) => void) | undefined, run: IngestionRun, type: IngestionEvent["type"], jobId?: string): void {
    try { callback?.({ type, ingestionRunId: run.id, sessionId: run.sessionId, messageRange: [run.startIndex, run.endIndex], attemptCount: run.attemptCount, timestamp: Date.now(), ...(jobId ? { jobId } : {}), ...(run.workerId ? { workerId: run.workerId } : {}), ...(run.lastErrorCode ? { errorCode: run.lastErrorCode } : {}) }); } catch (cause) {
      console.warn("MemoGrafter ingestion event callback warning:", cause);
    }
  }

  private async handleRunFailure(job: { id?: string | undefined; attemptsMade: number; opts: { attempts?: number | undefined }; data: IngestJobData }): Promise<void> {
    if (job.data.kind !== "run") return;
    let run = await this.store?.getIngestionRun?.(job.data.ingestionRunId);
    if (!run) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (exhausted && run.status === "retry_pending" && this.store?.transitionIngestionRun) run = await this.store.transitionIngestionRun({ runId: run.id, from: ["retry_pending"], to: "failed", error: { message: run.lastErrorSafeMessage ?? "Queue attempts exhausted.", retryable: false } });
    this.reportLifecycle(run.status === "retry_pending" ? this.telemetry?.onRetryScheduled : this.telemetry?.onFailed, run, run.status === "retry_pending" ? "retry_scheduled" : "failed", job.id);
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
  if (data.kind === "text") return splitTextForIngestion(data.text).length;
  if (data.kind === "run") return data.endIndex - data.startIndex + 1;
  return data.messages.length;
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

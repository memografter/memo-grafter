export type SmokeStatus = "passed" | "failed" | "skipped";

export type SmokeMetricValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[]
  | Record<string, unknown>[];

export interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  calls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
}

export interface DatabaseUsage {
  total: number;
  reads: number;
  writes: number;
  other: number;
}

export interface QueueUsage {
  completedJobs: number;
  failedJobs: number;
  totalMessages: number;
  totalPayloadBytes: number;
  maximumJobPayloadBytes: number;
  firstJobMessageCount: number | null;
  lastJobMessageCount: number | null;
  firstJobPayloadBytes: number | null;
  lastJobPayloadBytes: number | null;
  firstJobKind: "messages" | "append" | "text" | null;
  lastJobKind: "messages" | "append" | "text" | null;
}

export interface RuntimeComponent {
  provider: string;
  model: string;
}

export interface RuntimeDescriptor {
  llm: RuntimeComponent;
  embedder: RuntimeComponent;
}

export interface ServiceMetrics {
  configured: boolean;
  reachable: boolean;
  connectAndPingMs?: number;
  warmPingMs?: number;
  error?: string;
  usage: string;
}

export interface InfrastructureMetrics {
  postgres: ServiceMetrics;
  redis: ServiceMetrics;
}

export interface SmokeTestResult {
  suite: string;
  name: string;
  status: SmokeStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runtime: RuntimeDescriptor;
  assertions: string[];
  metrics: Record<string, SmokeMetricValue>;
  conversation?: ConversationEntry[];
  tokenUsage?: TokenUsage;
  databaseUsage: DatabaseUsage;
  queueUsage?: QueueUsage;
  reason?: string;
  error?: string;
}

export interface SmokeContext {
  strict: boolean;
  verbose: boolean;
  timeoutMs: number;
  telemetry: import("./metrics.js").SmokeMetricsCollector;
}

export interface SmokeTestDefinition {
  suite: string;
  name: string;
  runtime: RuntimeDescriptor;
  run(context: SmokeContext): Promise<Omit<SmokeTestResult, "suite" | "name" | "status" | "startedAt" | "finishedAt" | "durationMs" | "runtime" | "databaseUsage" | "queueUsage">>;
}

export interface SmokeRunOptions extends Omit<SmokeContext, "telemetry"> {
  writeDoc: boolean;
  reportPath?: string;
}

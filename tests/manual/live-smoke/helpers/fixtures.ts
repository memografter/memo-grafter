import postgres from "postgres";
import {
  OpenAIEmbedAdapter,
  OpenAILLMAdapter,
  PostgresGraphStore,
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
  type MemoGrafterConfig,
} from "../../../../src/index.js";
import { TelemetryLLMAdapter } from "./telemetry.js";
import type { RuntimeDescriptor } from "./types.js";
import type { SmokeMetricsCollector } from "./metrics.js";

export const NOT_USED_RUNTIME: RuntimeDescriptor = {
  llm: { provider: "Not Used", model: "Not Used" },
  embedder: { provider: "Not Used", model: "Not Used" },
};

export const OPENAI_RUNTIME: RuntimeDescriptor = {
  llm: { provider: "OpenAI", model: "gpt-4o-mini" },
  embedder: { provider: "OpenAI", model: "text-embedding-3-small" },
};

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Add it to the root .env file.`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class DeterministicEmbedder implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    const normalized = text.toLowerCase();
    const buckets = [
      ["travel", "japan", "kyoto"],
      ["cover", "software", "career"],
      ["refund", "policy", "days"],
      ["location", "delhi", "bangalore"],
      ["notebook", "lifecycle", "blue"],
    ];
    const index = Math.max(0, buckets.findIndex((words) => words.some((word) => normalized.includes(word))));
    vector[index] = 1;
    return vector;
  }
}

export class DeterministicLLM implements LLMAdapter {
  async complete(messages: Message[]): Promise<string> {
    const prompt = messages.at(-1)?.content ?? "";
    const documentMode = prompt.includes("Analyze this document segment");
    if (!prompt.includes("Conversation segment:")) return `Smoke response: ${prompt}`;

    const normalized = prompt.toLowerCase();
    const fixture = normalized.includes("bangalore")
      ? ["User Location", "user", "location", "Actually Bangalore now"]
      : normalized.includes("delhi")
        ? ["User Location", "user", "location", "Delhi"]
        : normalized.includes("refund")
          ? ["Refund Policy", "refund policy", "window", "Customers can request a refund within 30 days."]
          : normalized.includes("cover") || normalized.includes("software")
            ? ["Software Career", "user", "goal", "The user wants help with a software career."]
            : normalized.includes("notebook") || normalized.includes("lifecycle")
              ? ["Notebook Preference", "user", "preference", "The user prefers blue notebooks."]
              : ["Japan Travel", "user", "preference", "The user prefers quiet Kyoto cafes."];

    return JSON.stringify({
      label: fixture[0],
      user_intent: `The user discussed ${fixture[0]}.`,
      outcome: `Stored a smoke-test fact about ${fixture[0]}.`,
      open: null,
      memories: [{
        memory_type: "fact",
        subject: fixture[1],
        predicate: fixture[2],
        value: fixture[3],
        confidence: 0.95,
        provenance: documentMode
          ? { speaker: "document", message_indexes: [1], extraction_method: "document-extraction" }
          : { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
      }],
    });
  }
}

export function deterministicConfig(
  telemetry: TelemetryLLMAdapter,
  overrides: Partial<MemoGrafterConfig> = {},
  metrics?: SmokeMetricsCollector,
): MemoGrafterConfig {
  const config: MemoGrafterConfig = {
    llm: telemetry,
    embedder: new DeterministicEmbedder(),
    drift: {
      mode: "intent",
      driftSensitivity: "medium",
      minSegmentMessages: 2,
    },
    inject: { bufferSize: 0, tokenBudget: 1200 },
    ...overrides,
    db: {
      connectionString: requireEnv("DATABASE_URL"),
      ...(metrics ? { telemetry: metrics.databaseTelemetry } : {}),
      ...overrides.db,
    },
  };
  if (config.queue && metrics) {
    config.queue = { ...config.queue, telemetry: metrics.createQueueTelemetry() };
  }
  return config;
}

export function createDeterministicTelemetry(): TelemetryLLMAdapter {
  return new TelemetryLLMAdapter(new DeterministicLLM());
}

export function openAIConfig(
  telemetry: TelemetryLLMAdapter,
  overrides: Partial<MemoGrafterConfig> = {},
  metrics?: SmokeMetricsCollector,
): MemoGrafterConfig {
  requireEnv("OPENAI_API_KEY");
  const config: MemoGrafterConfig = {
    llm: telemetry,
    embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
    drift: {
      mode: "intent",
      driftSensitivity: "medium",
      minSegmentMessages: 2,
    },
    inject: { bufferSize: 0, tokenBudget: 1200 },
    ...overrides,
    db: {
      connectionString: requireEnv("DATABASE_URL"),
      ...(metrics ? { telemetry: metrics.databaseTelemetry } : {}),
      ...overrides.db,
    },
  };
  if (config.queue && metrics) {
    config.queue = { ...config.queue, telemetry: metrics.createQueueTelemetry() };
  }
  return config;
}

export function createOpenAITelemetry(metrics?: SmokeMetricsCollector): TelemetryLLMAdapter {
  requireEnv("OPENAI_API_KEY");
  return new TelemetryLLMAdapter(
    new OpenAILLMAdapter("gpt-4o-mini"),
    metrics ? (usage) => metrics.recordLlmCall(usage) : undefined,
  );
}

export async function cleanupSessions(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0 || !process.env.DATABASE_URL) return;
  const store = new PostgresGraphStore(process.env.DATABASE_URL);
  try {
    await store.initialize();
    for (const sessionId of sessionIds) await store.clearSession(sessionId);
  } finally {
    await store.close();
  }
}

export async function cleanupFleet(fleetId: string, sessionIds: string[]): Promise<void> {
  await cleanupSessions(sessionIds);
  if (!process.env.DATABASE_URL) return;
  const sql = postgres(process.env.DATABASE_URL);
  try {
    await sql`DELETE FROM mg_fleet_agents WHERE fleet_id = ${fleetId}`;
    await sql`DELETE FROM mg_fleets WHERE id = ${fleetId}`;
  } finally {
    await sql.end();
  }
}

import assert from "node:assert/strict";
import postgres from "postgres";
import { MemoGrafter, MemoGrafterAgent, MemoGrafterFleet, PostgresGraphStore, type EmbedAdapter, type LLMAdapter, type MemoGrafterConfig } from "../src/index.js";

export { assert };

export const databaseUrl = process.env.DATABASE_URL;

let databaseAvailable: boolean | undefined;
let databaseSkipReason = "DATABASE_URL is not reachable.";
let schemaMigrated = false;

export async function skipWithoutDatabase(testName: string): Promise<boolean> {
  if (!databaseUrl) {
    console.log(`SKIP ${testName}: DATABASE_URL is not set.`);
    return true;
  }

  if (databaseAvailable === undefined) {
    const sql = postgres(databaseUrl, { connect_timeout: 2 });
    try {
      await sql`SELECT 1`;
      databaseAvailable = true;
    } catch (error) {
      databaseAvailable = false;
      databaseSkipReason = `DATABASE_URL is not reachable. ${error instanceof Error ? error.message : ""}`.trim();
    } finally {
      await sql.end().catch(() => undefined);
    }
  }

  if (databaseAvailable) return false;

  console.log(`SKIP ${testName}: ${databaseSkipReason}`);
  return true;
}

export class FakeLLMAdapter implements LLMAdapter {
  async complete(messages: { role: "system" | "user" | "assistant"; content: string }[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    if (last.includes("Conversation segment:")) {
      return this.extractMemory(last);
    }

    return `Response to: ${last}`;
  }

  private extractMemory(prompt: string): string {
    const text = prompt.toLowerCase();
    if (text.includes("japan")) {
      return JSON.stringify({
        label: "Japan Travel",
        user_intent: "The user wanted help planning a Japan trip.",
        outcome: "The assistant provided Japan travel guidance.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "Japan trip",
          predicate: "preference",
          value: "The user is planning Japan travel and cares about Japan guidance.",
          confidence: 0.9,
          provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
        }],
      });
    }

    if (text.includes("cover letter")) {
      return JSON.stringify({
        label: "Cover Letter",
        user_intent: "The user wanted help writing a software cover letter.",
        outcome: "The assistant provided cover letter guidance.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "Cover letter",
          predicate: "goal",
          value: "The user wants help writing a software cover letter.",
          confidence: 0.9,
          provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
        }],
      });
    }

    if (text.includes("butter chicken")) {
      return JSON.stringify({
        label: "Butter Chicken",
        user_intent: "The user wanted cooking substitutions.",
        outcome: "The assistant suggested recipe alternatives.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "Butter chicken",
          predicate: "preference",
          value: "The user wants butter chicken substitutions.",
          confidence: 0.9,
          provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
        }],
      });
    }

    if (text.includes("refund") || text.includes("policy")) {
      return JSON.stringify({
        label: "Refund Policy",
        user_intent: "The user provided shared refund policy knowledge.",
        outcome: "The assistant stored the shared refund policy.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "Refund policy",
          predicate: "window",
          value: "Customers can request a refund within 30 days.",
          confidence: 0.95,
          provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
        }],
      });
    }

    return JSON.stringify({
      label: "General Topic",
      user_intent: "The user wanted general assistance.",
      outcome: "The assistant provided a response.",
      open: null,
      memories: [],
    });
  }
}

export class FakeEmbedAdapter implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    const normalized = text.toLowerCase();

    if (normalized.includes("refund") || normalized.includes("policy")) {
      vector[4] = 1;
    } else if (normalized.includes("japan") || normalized.includes("travel")) {
      vector[0] = 1;
    } else if (normalized.includes("cover") || normalized.includes("letter")) {
      vector[1] = 1;
    } else if (normalized.includes("butter") || normalized.includes("chicken")) {
      vector[2] = 1;
    } else {
      vector[3] = 1;
    }

    return vector;
  }
}

export function createConfig(overrides: Partial<MemoGrafterConfig> = {}): MemoGrafterConfig {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for this test.");
  }

  return {
    db: { connectionString: databaseUrl },
    llm: new FakeLLMAdapter(),
    embedder: new FakeEmbedAdapter(),
    drift: {
      mode: "intent",
      threshold: 0.3,
      minSegmentMessages: 3,
    },
    graph: {
      topK: 3,
      hopDepth: 2,
    },
    inject: {
      bufferSize: 1,
      tokenBudget: 1200,
    },
    ...overrides,
  };
}

export async function cleanupDatabase(): Promise<void> {
  if (!databaseUrl) return;

  const sql = postgres(databaseUrl);
  await sql`DELETE FROM mg_memory_edges`;
  await sql`DELETE FROM mg_memory_nodes`;
  await sql`DELETE FROM mg_graft_registry`;
  await sql`DELETE FROM mg_topic_edges`;
  await sql`DELETE FROM mg_topic_nodes`;
  await sql`DELETE FROM mg_segments`;
  await sql`DELETE FROM mg_message_buffer`;
  await sql`DELETE FROM mg_ingestion_runs`;
  await sql`DELETE FROM mg_session_ingest_state`;
  await sql`DELETE FROM mg_sessions`;
  await sql`DELETE FROM mg_fleet_agents`;
  await sql`DELETE FROM mg_fleets`;
  await sql.end();
}

export async function migrateMemoGrafterSchema(): Promise<void> {
  if (!databaseUrl || schemaMigrated) return;

  const store = new PostgresGraphStore(databaseUrl);
  try {
    await store.migrate();
    schemaMigrated = true;
  } finally {
    await store.close();
  }
}

export async function createInitializedAgent(overrides: Partial<MemoGrafterConfig> = {}): Promise<MemoGrafterAgent> {
  await migrateMemoGrafterSchema();
  const agent = new MemoGrafterAgent(createConfig(overrides));
  await agent.initialize();
  await cleanupDatabase();
  return agent;
}

export async function createInitializedMemo(overrides: Partial<MemoGrafterConfig> = {}): Promise<MemoGrafter> {
  await migrateMemoGrafterSchema();
  const memo = new MemoGrafter(createConfig(overrides));
  await memo.initialize();
  await cleanupDatabase();
  return memo;
}

export async function createInitializedFleet(): Promise<MemoGrafterFleet> {
  await migrateMemoGrafterSchema();
  const fleet = new MemoGrafterFleet(createConfig(), { id: `fleet-${Date.now()}`, name: "test fleet" });
  await fleet.initialize();
  await cleanupDatabase();
  await fleet.initialize();
  return fleet;
}

export async function seedConversation(agent: MemoGrafterAgent): Promise<void> {
  await agent.invoke("I want to plan a trip to Japan in April.");
  await agent.invoke("What food experiences should I try in Japan?");
  await agent.invoke("Now help me write a cover letter for a software role.");
}

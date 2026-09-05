import "dotenv/config";

import assert from "node:assert/strict";
import {
  MemoGrafterAgent,
  type EmbedAdapter,
  type LLMAdapter,
  type MemoryNode,
  type Message,
  type TopicNode,
} from "../../../src/index.js";
import type { Redis } from "ioredis";

class FakeLLMAdapter implements LLMAdapter {
  async complete(messages: Message[]): Promise<string> {
    return `Response to: ${messages.at(-1)?.content ?? ""}`;
  }
}

class StableEmbedAdapter implements EmbedAdapter {
  async embed(): Promise<number[]> {
    return [0.1234567, 0.2345678, 0.3456789];
  }
}

function makeMemoryNode(): MemoryNode & { similarity: number } {
  return {
    id: "cache-smoke-memory",
    segmentId: "cache-smoke-segment",
    topicNodeId: "cache-smoke-topic",
    agentId: null,
    sessionId: "cache-smoke-session",
    memoryType: "fact",
    sourceType: "conversation",
    subject: "recall cache",
    predicate: "uses",
    value: "a shared Redis client",
    quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
    embedding: [0.1, 0.2, 0.3],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    agentColor: null,
    fleetId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    similarity: 0.99,
  };
}

function makeTopicNode(): TopicNode {
  return {
    id: "cache-smoke-topic",
    sessionId: "cache-smoke-session",
    segmentId: "cache-smoke-segment",
    label: "Recall Cache",
    summary: "Recall cache smoke test topic.",
    embedding: [0.1, 0.2, 0.3],
    messageRange: [0, 1],
    topicOrder: 1,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

async function waitForRedisReady(redis: Redis | null): Promise<boolean> {
  if (!redis) return false;
  if (redis.status === "ready") return true;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 3000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      redis.off("ready", onReady);
      redis.off("error", onError);
      redis.off("end", onEnd);
    };
    const onReady = (): void => {
      cleanup();
      resolve(true);
    };
    const onError = (): void => {
      cleanup();
      resolve(false);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(false);
    };

    redis.once("ready", onReady);
    redis.once("error", onError);
    redis.once("end", onEnd);
  });
}

if (!process.env.REDIS_URL) {
  console.log("Skipping recall cache smoke: REDIS_URL is not set.");
  process.exit(0);
}

const agent = new MemoGrafterAgent({
  db: { connectionString: process.env.DATABASE_URL ?? "postgres://user:pass@localhost:5432/memografter_test" },
  llm: new FakeLLMAdapter(),
  embedder: new StableEmbedAdapter(),
  cache: {
    connectionString: process.env.REDIS_URL,
    ttlSeconds: 60,
  },
});

const core = (agent as unknown as {
  core: {
    recallCache: Redis | null;
    store: {
      searchMemories: (...args: unknown[]) => Promise<Array<MemoryNode & { similarity: number }>>;
      getTopicNode: (topicNodeId: string, sessionId?: string) => Promise<TopicNode | null>;
      close: () => Promise<void>;
    };
  };
}).core;

if (!(await waitForRedisReady(core.recallCache))) {
  console.log("Skipping recall cache smoke: Redis is configured but not reachable.");
  await agent.close();
  process.exit(0);
}

let searchMemoriesCallCount = 0;
core.store.searchMemories = async () => {
  searchMemoriesCallCount += 1;
  return [makeMemoryNode()];
};
core.store.getTopicNode = async () => makeTopicNode();
core.store.close = async () => undefined;

try {
  const first = await agent.recall("does recall use redis cache?", {
    limit: 3,
    minSimilarity: 0.5,
    cache: { ttlSeconds: 60 },
  });
  const second = await agent.recall("does recall use redis cache?", {
    limit: 3,
    minSimilarity: 0.5,
    cache: { ttlSeconds: 60 },
  });

  assert.equal(searchMemoriesCallCount, 1);
  assert.equal(first.facts.length, 1);
  assert.equal(second.facts.length, 1);
  assert.equal(first.facts[0]?.id, second.facts[0]?.id);

  console.log("recall cache smoke passed");
  console.log("searchMemories calls:", searchMemoriesCallCount);
  console.log("cached fact:", second.facts[0]);
} finally {
  await agent.close();
}

import { describe, expect, it, vi } from "vitest";
import { MemoGrafterAgent } from "../../../src/agents/MemoGrafterAgent.js";

function createAgent() {
  const order: string[] = [];
  const core = {
    forget: vi.fn(async () => {
      order.push("forget");
      return true;
    }),
    forgetMany: vi.fn(async () => {
      order.push("forgetMany");
      return 2;
    }),
    suppressTopic: vi.fn(async () => {
      order.push("suppressTopic");
      return true;
    }),
    restoreTopic: vi.fn(async () => {
      order.push("restoreTopic");
      return true;
    }),
    pinTopic: vi.fn(async () => true),
    unpinTopic: vi.fn(async () => true),
    getPinnedTopics: vi.fn(async () => [{ id: "topic-1" }]),
    getMemoryHistory: vi.fn(async () => {
      order.push("getMemoryHistory");
      return { entries: [], edges: [], currentMemory: null };
    }),
    getMemoryDiff: vi.fn(async () => {
      order.push("getMemoryDiff");
      return {
        from: {},
        to: {},
        fields: [],
        changedFields: [],
        relationship: {
          supersedes: false,
          supersededBy: false,
          conflicts: false,
          updateEdges: [],
          conflictEdges: [],
        },
      };
    }),
  };
  const agent = Object.create(MemoGrafterAgent.prototype) as MemoGrafterAgent;
  const internals = agent as unknown as {
    core: typeof core;
    pendingIngest: Promise<void>;
    sessionId: string;
  };
  internals.core = core;
  internals.sessionId = "session-1";
  internals.pendingIngest = Promise.resolve().then(() => {
    order.push("pending");
  });

  return { agent, core, order };
}

describe("MemoGrafterAgent lifecycle APIs", () => {
  it("waits for pending ingest before forgetting a memory", async () => {
    const { agent, core, order } = createAgent();

    await expect(agent.forget("memory-1")).resolves.toBe(true);

    expect(core.forget).toHaveBeenCalledWith("memory-1");
    expect(order).toEqual(["pending", "forget"]);
  });

  it("forwards bulk forget and topic lifecycle calls", async () => {
    const { agent, core } = createAgent();

    await expect(agent.forgetMany(["memory-a", "memory-b"])).resolves.toBe(2);
    await expect(agent.suppressTopic("topic-1")).resolves.toBe(true);
    await expect(agent.restoreTopic("topic-1")).resolves.toBe(true);

    expect(core.forgetMany).toHaveBeenCalledWith(["memory-a", "memory-b"]);
    expect(core.suppressTopic).toHaveBeenCalledWith("topic-1");
    expect(core.restoreTopic).toHaveBeenCalledWith("topic-1");
  });

  it("scopes memory history lookups to the agent session", async () => {
    const { agent, core } = createAgent();
    const sessionId = agent.getSessionId();

    await agent.getMemoryHistory("memory-1");
    await agent.getMemoryHistory("user", "location");
    await agent.getMemoryDiff("memory-a", "memory-b");

    expect(core.getMemoryHistory).toHaveBeenCalledWith("memory-1", { sessionId });
    expect(core.getMemoryHistory).toHaveBeenCalledWith("user", "location", { sessionId });
    expect(core.getMemoryDiff).toHaveBeenCalledWith("memory-a", "memory-b");
  });

  it("scopes persistent pin APIs to the agent session", async () => {
    const { agent, core } = createAgent();
    await expect(agent.pinTopic("topic-1")).resolves.toBe(true);
    await expect(agent.getPinnedTopics()).resolves.toEqual([{ id: "topic-1" }]);
    await expect(agent.unpinTopic("topic-1")).resolves.toBe(true);
    expect(core.pinTopic).toHaveBeenCalledWith("session-1", "topic-1");
    expect(core.getPinnedTopics).toHaveBeenCalledWith("session-1");
    expect(core.unpinTopic).toHaveBeenCalledWith("session-1", "topic-1");
  });
});

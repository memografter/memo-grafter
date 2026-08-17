import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleStudioApiRequest, type StudioApiContext } from "../../../cli/studio/api.js";
import { listenOnAvailablePort } from "../../../cli/commands/studio.js";

const memoryId = "11111111-1111-4111-8111-111111111111";

describe("MemoGrafter Studio API", () => {
  it("serves session, graph, memory, and search data scoped to one session", async () => {
    const context = makeContext();
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const sessions = await requestJson(port, "/api/sessions");
      const filteredSessions = await requestJson(port, "/api/sessions?q=alpha");
      const graph = await requestJson(port, "/sessions/session-1/graph");
      const tables = await requestJson(port, "/api/sessions/session-1/tables");
      const memories = await requestJson(port, "/api/sessions/session-1/memories");
      const search = await requestJson(port, "/sessions/session-1/search?q=alpha");

      expect(sessions.status).toBe(200);
      expect(sessions.body).toMatchObject({
        sessions: [{
          id: "session-1",
          label: "Alpha session",
          displayLabel: "Alpha session",
          messageCount: 2,
          topicCount: 1,
          memoryCount: 1,
        }],
      });
      expect(filteredSessions.status).toBe(200);
      expect(graph.status).toBe(200);
      expect(graph.body).toMatchObject({
        sessionId: "session-1",
        nodes: [{ id: "topic-1", sessionId: "session-1" }],
        segments: [{ id: "segment-1", sessionId: "session-1" }],
        edges: [{ srcId: "topic-1", dstId: "topic-2" }],
        memories: [{ id: memoryId, sessionId: "session-1" }],
        memoryEdges: [{ id: "edge-1", sourceId: memoryId }],
      });
      expect(tables.status).toBe(200);
      expect(tables.body).toMatchObject({
        sessionId: "session-1",
        topics: [{ id: "topic-1", sessionId: "session-1" }],
        segments: [{ id: "segment-1", sessionId: "session-1" }],
        memories: [{ id: memoryId, sessionId: "session-1" }],
        messages: [{ role: "user", content: "hello" }],
        tables: [
          { name: "mg_topic_nodes", rows: [{ id: "topic-1", session_id: "session-1" }] },
          { name: "mg_message_buffer", rows: [{ message_index: 0, role: "user", content: "hello" }] },
        ],
      });
      expect(memories.body).toMatchObject({
        sessionId: "session-1",
        memories: [{ id: memoryId, sessionId: "session-1" }],
      });
      expect(search.body).toMatchObject({
        sessionId: "session-1",
        query: "alpha",
        topics: [{ id: "topic-1", label: "Alpha topic" }],
        memories: [{ id: memoryId, value: "alpha memory" }],
      });
      expect(context.store.getNodesBySession).toHaveBeenCalledWith("session-1", { includeSuppressed: true });
      expect(context.store.getMessagesBySession).toHaveBeenCalledWith("session-1");
      expect(context.repository.listSessions).toHaveBeenCalledWith(undefined);
      expect(context.repository.listSessions).toHaveBeenCalledWith("alpha");
      expect(context.repository.getTablesBySession).toHaveBeenCalledWith("session-1");
      expect(context.repository.searchTopics).toHaveBeenCalledWith("session-1", "alpha", undefined);
      expect(context.repository.searchMemories).toHaveBeenCalledWith("session-1", "alpha", undefined);
    } finally {
      await closeServer(server);
    }
  });

  it("runs invoke preview through the configured preview service", async () => {
    const context = makeContext();
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const preview = await requestJson(port, "/api/sessions/session-1/invocation-preview", {
        method: "POST",
        body: JSON.stringify({
          profile: "memo-grafter-agent",
          query: " alpha ",
        }),
      });

      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        profile: "memo-grafter-agent",
        query: "alpha",
        historySource: "database-backed-preview",
        request: { system: "preview prompt" },
      });
      expect(context.preview?.run).toHaveBeenCalledWith({
        sessionId: "session-1",
        query: "alpha",
        profile: "memo-grafter-agent",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("accepts Fleet Worker invoke preview requests", async () => {
    const context = makeContext();
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const preview = await requestJson(port, "/api/sessions/session-1/invocation-preview", {
        method: "POST",
        body: JSON.stringify({
          profile: "fleet-worker",
          fleetMemoryMode: "both",
          query: "deployment rollout",
        }),
      });

      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        profile: "fleet-worker",
        query: "deployment rollout",
        request: { system: "preview prompt" },
      });
      expect(context.preview?.run).toHaveBeenCalledWith({
        sessionId: "session-1",
        query: "deployment rollout",
        profile: "fleet-worker",
        fleetMemoryMode: "both",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("executes a stored invocation plan only through the explicit completion endpoint", async () => {
    const context = makeContext();
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);
    try {
      const completion = await requestJson(port, "/api/sessions/session-1/invocation-preview/plan-1/complete", { method: "POST" });
      expect(completion.status).toBe(200);
      expect(completion.body).toMatchObject({ planId: "plan-1", response: "LLM response" });
      expect(context.preview?.complete).toHaveBeenCalledWith("plan-1", "session-1");
    } finally {
      await closeServer(server);
    }
  });

  it("previews, copies, and removes a topic graft using IDs only", async () => {
    const context = makeContext();
    context.repository.sessionExists = vi.fn(async (sessionId: string) => ["session-1", "session-2"].includes(sessionId));
    context.store.getGraftRegistry = vi.fn(async () => []);
    context.store.removeGraftFromSession = vi.fn(async () => ({
      nodeId: "copied-topic-1",
      sourceSessionId: "session-1",
      sourceNodeId: "topic-1",
      graftedAt: new Date("2026-08-16T00:00:00.000Z"),
    }));
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const body = JSON.stringify({
        topicIds: ["topic-1"],
        targetSessionIds: ["session-2"],
        duplicatePolicy: "skip",
      });
      const preview = await requestJson(port, "/api/sessions/session-1/grafts/preview", { method: "POST", body });
      const copied = await requestJson(port, "/api/sessions/session-1/grafts", { method: "POST", body });
      const removed = await requestJson(port, "/api/sessions/session-2/grafts/copied-topic-1/remove", { method: "POST" });

      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        topic: { id: "topic-1" },
        activeMemories: [{ id: memoryId }],
        omittedMemories: [],
        targets: [{ targetSessionId: "session-2", duplicate: false }],
      });
      expect(copied.body).toMatchObject({
        results: [{ targetSessionId: "session-2", status: "copied", targetTopicId: "copied-topic-1" }],
      });
      expect(context.store.graftTopics).toHaveBeenCalledWith({
        sourceSessionId: "session-1",
        targetSessionId: "session-2",
        topicIds: ["topic-1"],
        duplicatePolicy: "skip",
      });
      expect(removed.body).toMatchObject({ action: "remove-graft", nodeId: "copied-topic-1" });
      expect(context.store.removeGraftFromSession).toHaveBeenCalledWith("session-2", "copied-topic-1");
    } finally {
      await closeServer(server);
    }
  });

  it("reports invoke preview configuration and input errors", async () => {
    const context = makeContext();
    context.preview = {
      getStatus: vi.fn(() => ({ available: false, reason: "No embedder configured." })),
      run: vi.fn(),
    };
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const unavailable = await requestJson(port, "/api/sessions/session-1/preview", {
        method: "POST",
        body: JSON.stringify({ profile: "memo-grafter-agent", query: "alpha" }),
      });

      context.preview = {
        getStatus: vi.fn(() => ({ available: true })),
        run: vi.fn(),
      };
      const invalidMode = await requestJson(port, "/api/sessions/session-1/preview", {
        method: "POST",
        body: JSON.stringify({ profile: "bad", query: "alpha" }),
      });
      const emptyQuery = await requestJson(port, "/api/sessions/session-1/preview", {
        method: "POST",
        body: JSON.stringify({ profile: "memo-grafter-agent", query: " " }),
      });

      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toMatchObject({
        error: "Invoke Preview is unavailable.",
        previewStatus: { available: false, reason: "No embedder configured." },
      });
      expect(invalidMode.status).toBe(400);
      expect(emptyQuery.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("performs only suppress lifecycle actions after verifying session ownership", async () => {
    const context = makeContext();
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const suppress = await requestJson(port, "/api/sessions/session-1/nodes/topic-1/suppress", { method: "POST" });
      const restore = await requestJson(port, "/sessions/session-1/nodes/topic-1/restore", { method: "POST" });
      const forget = await requestJson(port, `/api/sessions/session-1/memories/${memoryId}/forget`, { method: "POST" });

      expect(suppress.body).toMatchObject({ action: "suppress", changed: true });
      expect(restore.status).toBe(404);
      expect(forget.status).toBe(404);
      expect(context.store.suppressTopic).toHaveBeenCalledWith("topic-1");
    } finally {
      await closeServer(server);
    }
  });

  it("pins and unpins an active topic through the Studio API", async () => {
    const context = makeContext();
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);
    try {
      const pinned = await requestJson(port, "/api/sessions/session-1/topics/topic-1/pin", { method: "PUT" });
      const unpinned = await requestJson(port, "/api/sessions/session-1/topics/topic-1/pin", { method: "DELETE" });
      expect(pinned.body).toMatchObject({ nodeId: "topic-1", pinned: true, changed: true });
      expect(unpinned.body).toMatchObject({ nodeId: "topic-1", pinned: false, changed: true });
      expect(context.store.pinTopic).toHaveBeenCalledWith("session-1", "topic-1");
      expect(context.store.unpinTopic).toHaveBeenCalledWith("session-1", "topic-1");
    } finally {
      await closeServer(server);
    }
  });

  it("updates session labels after verifying the session exists", async () => {
    const context = makeContext();
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const rename = await requestJson(port, "/api/sessions/session-1", {
        method: "PATCH",
        body: JSON.stringify({ label: " Wedding planning " }),
      });
      const clear = await requestJson(port, "/api/sessions/session-1", {
        method: "PATCH",
        body: JSON.stringify({ label: " " }),
      });
      const invalid = await requestJson(port, "/api/sessions/session-1", {
        method: "PATCH",
        body: JSON.stringify({ label: 42 }),
      });
      const missing = await requestJson(port, "/api/sessions/missing", {
        method: "PATCH",
        body: JSON.stringify({ label: "Missing" }),
      });

      expect(rename.status).toBe(200);
      expect(rename.body).toMatchObject({
        sessionId: "session-1",
        label: "Wedding planning",
        displayLabel: "Alpha session",
      });
      expect(clear.status).toBe(200);
      expect(invalid.status).toBe(400);
      expect(missing.status).toBe(404);
      expect(context.repository.upsertSessionLabel).toHaveBeenCalledWith("session-1", "Wedding planning");
      expect(context.repository.upsertSessionLabel).toHaveBeenCalledWith("session-1", null);
    } finally {
      await closeServer(server);
    }
  });

  it("returns route errors as JSON", async () => {
    const context = makeContext({
      sessionExists: vi.fn(async (sessionId: string) => sessionId === "session-1"),
      nodeBelongsToSession: vi.fn(async () => false),
    });
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const missingQuery = await requestJson(port, "/api/sessions/session-1/search");
      const missingSession = await requestJson(port, "/api/sessions/missing/graph");
      const wrongMethod = await requestJson(port, "/api/sessions", { method: "POST" });
      const wrongSessionMethod = await requestJson(port, "/api/sessions/session-1", { method: "GET" });
      const missingNode = await requestJson(port, "/api/sessions/session-1/nodes/topic-2/suppress", { method: "POST" });
      const wrongPreviewMethod = await requestJson(port, "/api/sessions/session-1/preview");

      expect(missingQuery.status).toBe(400);
      expect(missingSession.status).toBe(404);
      expect(wrongMethod.status).toBe(405);
      expect(wrongSessionMethod.status).toBe(405);
      expect(missingNode.status).toBe(404);
      expect(wrongPreviewMethod.status).toBe(405);
    } finally {
      await closeServer(server);
    }
  });

  it("returns JSON 500 responses for unexpected failures", async () => {
    const context = makeContext({
      listSessions: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const server = createApiServer(context);
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const response = await requestJson(port, "/api/sessions");

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: "Studio API request failed.",
        message: "database unavailable",
      });
    } finally {
      await closeServer(server);
    }
  });
});

function makeContext(repositoryOverrides: Partial<StudioApiContext["repository"]> = {}): StudioApiContext {
  const memory = {
    id: memoryId,
    sessionId: "session-1",
    topicNodeId: "topic-1",
    subject: "project",
    predicate: "name",
    value: "alpha memory",
    decayed: false,
    forgotten: false,
    supersededBy: null,
  };
  const topic = {
    id: "topic-1",
    sessionId: "session-1",
    label: "Alpha topic",
    summary: "alpha topic summary",
  };

  return {
    store: {
      getNodesBySession: vi.fn(async () => [topic]),
      getSegmentsBySession: vi.fn(async () => [{ id: "segment-1", sessionId: "session-1" }]),
      getMemoriesBySession: vi.fn(async () => [memory]),
      getMessagesBySession: vi.fn(async () => [{ role: "user", content: "hello" }]),
      suppressTopic: vi.fn(async () => true),
      pinTopic: vi.fn(async () => true),
      unpinTopic: vi.fn(async () => true),
      getTopicNode: vi.fn(async () => topic),
      getGraftRegistry: vi.fn(async () => []),
      graftTopics: vi.fn(async (request) => ({
        ...request,
        sourceTopicId: request.topicIds[0]!,
        status: "copied" as const,
        copiedTopics: [{ id: "copied-topic-1" }],
        copiedMemoryCount: 1,
      })),
      removeGraftFromSession: vi.fn(async () => null),
    },
    repository: {
      listSessions: vi.fn(async () => [{
        id: "session-1",
        label: "Alpha session",
        displayLabel: "Alpha session",
        messageCount: 2,
        topicCount: 1,
        memoryCount: 1,
        lastUpdatedAt: new Date("2026-06-19T00:00:00.000Z"),
      }]),
      sessionExists: vi.fn(async (sessionId: string) => sessionId === "session-1"),
      nodeBelongsToSession: vi.fn(async (_sessionId: string, nodeId: string) => nodeId === "topic-1"),
      getTopicEdgesBySession: vi.fn(async () => [{ srcId: "topic-1", dstId: "topic-2", weight: 1, type: "semantic" }]),
      getMemoryEdgesBySession: vi.fn(async () => [{
        id: "edge-1",
        sourceId: memoryId,
        targetId: "22222222-2222-4222-8222-222222222222",
        edgeType: "related",
        weight: 1,
        createdAt: new Date("2026-06-19T00:00:00.000Z"),
      }]),
      getTablesBySession: vi.fn(async () => [
        { name: "mg_topic_nodes", rows: [{ id: "topic-1", session_id: "session-1" }] },
        { name: "mg_message_buffer", rows: [{ session_id: "session-1", message_index: 0, role: "user", content: "hello" }] },
      ]),
      searchTopics: vi.fn(async () => [topic]),
      searchMemories: vi.fn(async () => [memory]),
      upsertSessionLabel: vi.fn(async () => undefined),
      ...repositoryOverrides,
    },
    preview: {
      getStatus: vi.fn(() => ({ available: true, completion: { available: true, provider: "Test" } })),
      run: vi.fn(async (request) => ({
        profile: request.profile ?? "memo-grafter-agent",
        query: request.query,
        sessionId: request.sessionId,
        historySource: "database-backed-preview",
        request: { system: "preview prompt", messages: [] },
        retrieval: { status: "no-match", topics: [], memories: [] },
        tokens: { total: 12 },
        generatedAt: "2026-06-19T00:00:00.000Z",
        planId: "plan-1",
      })),
      complete: vi.fn(async (planId: string) => ({ planId, response: "LLM response", durationMs: 3, completedAt: "2026-06-19T00:00:00.000Z" })),
    },
  };
}

function createApiServer(context: StudioApiContext): http.Server {
  return http.createServer((request, response) => {
    void handleStudioApiRequest(request, response, context);
  });
}

async function requestJson(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

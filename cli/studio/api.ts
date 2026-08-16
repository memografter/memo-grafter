import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  StudioMemoryEdge,
  StudioMemorySearchResult,
  StudioSessionSummary,
  StudioTableBrowserTable,
  StudioTopicEdge,
  StudioTopicSearchResult,
} from "./repository.js";

export interface StudioApiStore {
  getNodesBySession(sessionId: string, options?: { includeSuppressed?: boolean }): Promise<unknown[]>;
  getSegmentsBySession(sessionId: string): Promise<unknown[]>;
  getMemoriesBySession(sessionId: string): Promise<unknown[]>;
  getMessagesBySession(sessionId: string, startIndex?: number, endIndex?: number): Promise<unknown[]>;
  suppressTopic(nodeId: string): Promise<boolean>;
  getTopicNode(topicNodeId: string, sessionId?: string): Promise<StudioGraftTopic | null>;
  getGraftRegistry(sessionId: string): Promise<StudioGraftRegistryEntry[]>;
  graftTopics(request: StudioGraftTopicsRequest): Promise<StudioGraftTopicsResult>;
  removeGraftFromSession(targetSessionId: string, nodeId: string): Promise<StudioGraftRegistryEntry | null>;
}

interface StudioGraftTopic {
  id: string;
  suppressed?: boolean;
  [key: string]: unknown;
}

interface StudioGraftMemory {
  topicNodeId: string;
  forgotten?: boolean;
  decayed: boolean;
  supersededBy: string | null;
  [key: string]: unknown;
}

interface StudioGraftRegistryEntry {
  nodeId: string;
  sourceSessionId: string;
  sourceNodeId: string;
  graftedAt: Date;
  [key: string]: unknown;
}

interface StudioGraftTopicsRequest {
  sourceSessionId: string;
  targetSessionId: string;
  topicIds: string[];
  duplicatePolicy: "skip";
}

interface StudioGraftTopicsResult {
  copiedTopics: Array<{ id: string }>;
  existingTargetTopicId?: string;
  [key: string]: unknown;
}

export interface StudioApiPreviewService {
  getStatus(): { available: boolean; reason?: string };
  run(request: StudioPreviewRequest): Promise<unknown>;
}

export interface StudioPreviewRequest {
  mode: "graft" | "recall";
  sessionId: string;
  query: string;
  graft?: unknown;
  recall?: unknown;
}

export interface StudioApiRepository {
  listSessions(query?: string): Promise<StudioSessionSummary[]>;
  sessionExists(sessionId: string): Promise<boolean>;
  nodeBelongsToSession(sessionId: string, nodeId: string): Promise<boolean>;
  getTopicEdgesBySession(sessionId: string): Promise<StudioTopicEdge[]>;
  getMemoryEdgesBySession(sessionId: string): Promise<StudioMemoryEdge[]>;
  getTablesBySession(sessionId: string): Promise<StudioTableBrowserTable[]>;
  searchTopics(sessionId: string, query: string, limit?: number): Promise<StudioTopicSearchResult[]>;
  searchMemories(sessionId: string, query: string, limit?: number): Promise<StudioMemorySearchResult[]>;
  upsertSessionLabel(sessionId: string, label: string | null): Promise<void>;
}

export interface StudioApiContext {
  store: StudioApiStore;
  repository: StudioApiRepository;
  preview?: StudioApiPreviewService;
}

interface RouteMatch {
  segments: string[];
  url: URL;
}

export function isStudioApiRequest(requestUrl: string | undefined): boolean {
  const path = parseUrl(requestUrl).pathname;

  return path === "/api/sessions"
    || path.startsWith("/api/sessions/")
    || path === "/sessions"
    || path.startsWith("/sessions/");
}

export async function handleStudioApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: StudioApiContext,
): Promise<void> {
  try {
    const route = matchRoute(request.url);
    if (!route) {
      sendJson(response, 404, { error: "Studio API route not found." });
      return;
    }

    const method = request.method ?? "GET";
    const [resource, sessionId, collection, itemId, action] = route.segments;

    if (resource !== "sessions") {
      sendJson(response, 404, { error: "Studio API route not found." });
      return;
    }

    if (route.segments.length === 1) {
      if (method !== "GET") {
        sendMethodNotAllowed(response, ["GET"]);
        return;
      }

      const sessions = await context.repository.listSessions(route.url.searchParams.get("q") ?? undefined);
      sendJson(response, 200, { sessions });
      return;
    }

    if (!sessionId) {
      sendJson(response, 404, { error: "Studio API route not found." });
      return;
    }

    if (route.segments.length === 2) {
      if (method !== "PATCH") {
        sendMethodNotAllowed(response, ["PATCH"]);
        return;
      }

      await updateSession(response, request, context, sessionId);
      return;
    }

    if (collection === "graph" && route.segments.length === 3) {
      if (method !== "GET") {
        sendMethodNotAllowed(response, ["GET"]);
        return;
      }

      await sendSessionGraph(response, context, sessionId);
      return;
    }

    if (collection === "memories" && route.segments.length === 3) {
      if (method !== "GET") {
        sendMethodNotAllowed(response, ["GET"]);
        return;
      }

      await sendSessionMemories(response, context, sessionId);
      return;
    }

    if (collection === "tables" && route.segments.length === 3) {
      if (method !== "GET") {
        sendMethodNotAllowed(response, ["GET"]);
        return;
      }

      await sendSessionTables(response, context, sessionId);
      return;
    }

    if (collection === "preview" && route.segments.length === 3) {
      if (method !== "POST") {
        sendMethodNotAllowed(response, ["POST"]);
        return;
      }

      await sendPromptPreview(request, response, context, sessionId);
      return;
    }

    if (collection === "grafts" && itemId === "preview" && route.segments.length === 4) {
      if (method !== "POST") {
        sendMethodNotAllowed(response, ["POST"]);
        return;
      }
      await sendTopicGraftPreview(request, response, context, sessionId);
      return;
    }

    if (collection === "grafts" && route.segments.length === 3) {
      if (method !== "POST") {
        sendMethodNotAllowed(response, ["POST"]);
        return;
      }
      await executeTopicGraft(request, response, context, sessionId);
      return;
    }

    if (collection === "grafts" && itemId && action === "remove" && route.segments.length === 5) {
      if (method !== "POST") {
        sendMethodNotAllowed(response, ["POST"]);
        return;
      }
      await removeTopicGraft(response, context, sessionId, itemId);
      return;
    }

    if (collection === "search" && route.segments.length === 3) {
      if (method !== "GET") {
        sendMethodNotAllowed(response, ["GET"]);
        return;
      }

      await sendSessionSearch(response, context, sessionId, route.url);
      return;
    }

    if (collection === "nodes" && itemId && action === "suppress" && route.segments.length === 5) {
      if (method !== "POST") {
        sendMethodNotAllowed(response, ["POST"]);
        return;
      }

      await sendSuppressTopic(response, context, sessionId, itemId);
      return;
    }

    sendJson(response, 404, { error: "Studio API route not found." });
  } catch (error) {
    sendJson(response, 500, {
      error: "Studio API request failed.",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function updateSession(
  response: ServerResponse,
  request: IncomingMessage,
  context: StudioApiContext,
  sessionId: string,
): Promise<void> {
  if (!await context.repository.sessionExists(sessionId)) {
    sendJson(response, 404, { error: `Session '${sessionId}' was not found.` });
    return;
  }

  const body = await readJsonBody(request);
  if (!isObject(body)) {
    sendJson(response, 400, { error: "Session update requires a JSON object body." });
    return;
  }

  if (!("label" in body)) {
    sendJson(response, 400, { error: "Session update requires a 'label' field." });
    return;
  }

  if (body.label !== null && typeof body.label !== "string") {
    sendJson(response, 400, { error: "Session label must be a string or null." });
    return;
  }

  const label = typeof body.label === "string" ? body.label.trim() : null;
  if (label && label.length > 120) {
    sendJson(response, 400, { error: "Session label must be 120 characters or fewer." });
    return;
  }

  await context.repository.upsertSessionLabel(sessionId, label || null);
  const [summary] = await context.repository.listSessions(sessionId);

  sendJson(response, 200, {
    sessionId,
    label: label || null,
    displayLabel: summary?.displayLabel ?? label ?? sessionId,
  });
}

async function sendSessionGraph(
  response: ServerResponse,
  context: StudioApiContext,
  sessionId: string,
): Promise<void> {
  if (!await context.repository.sessionExists(sessionId)) {
    sendJson(response, 404, { error: `Session '${sessionId}' was not found.` });
    return;
  }

  const [nodes, segments, edges, memories, memoryEdges, graftRegistry] = await Promise.all([
    context.store.getNodesBySession(sessionId, { includeSuppressed: true }),
    context.store.getSegmentsBySession(sessionId),
    context.repository.getTopicEdgesBySession(sessionId),
    context.store.getMemoriesBySession(sessionId),
    context.repository.getMemoryEdgesBySession(sessionId),
    context.store.getGraftRegistry(sessionId),
  ]);

  sendJson(response, 200, {
    sessionId,
    nodes,
    segments,
    edges,
    memories,
    memoryEdges,
    graftRegistry,
    capturedAt: new Date().toISOString(),
  });
}

async function sendTopicGraftPreview(
  request: IncomingMessage,
  response: ServerResponse,
  context: StudioApiContext,
  sourceSessionId: string,
): Promise<void> {
  const input = await readGraftInput(request, response, context, sourceSessionId);
  if (!input) return;
  const topic = await context.store.getTopicNode(input.topicId, sourceSessionId);
  if (!topic || topic.suppressed) {
    sendJson(response, 404, { error: `Active topic '${input.topicId}' was not found in source session '${sourceSessionId}'.` });
    return;
  }
  const memories = (await context.store.getMemoriesBySession(sourceSessionId) as StudioGraftMemory[])
    .filter((memory) => memory.topicNodeId === input.topicId);
  const activeMemories = memories.filter(isActiveMemory);
  const omittedMemories = memories.filter((memory) => !isActiveMemory(memory)).map((memory) => ({
    memory,
    reasons: [
      ...(memory.forgotten ? ["forgotten"] : []),
      ...(memory.decayed ? ["decayed"] : []),
      ...(memory.supersededBy != null ? ["superseded"] : []),
    ],
  }));
  const targets = await Promise.all(input.targetSessionIds.map(async (targetSessionId) => {
    const existing = (await context.store.getGraftRegistry(targetSessionId)).find((entry) =>
      entry.sourceSessionId === sourceSessionId && entry.sourceNodeId === input.topicId
    );
    return {
      targetSessionId,
      duplicate: Boolean(existing),
      ...(existing ? { existingTargetTopicId: existing.nodeId, graftedAt: existing.graftedAt } : {}),
    };
  }));
  sendJson(response, 200, {
    sourceSessionId,
    topic,
    activeMemories,
    omittedMemories,
    targets,
    duplicatePolicy: "skip",
    note: "Grafting creates an independent copy. Later source changes are not synchronized.",
  });
}

async function executeTopicGraft(
  request: IncomingMessage,
  response: ServerResponse,
  context: StudioApiContext,
  sourceSessionId: string,
): Promise<void> {
  const input = await readGraftInput(request, response, context, sourceSessionId);
  if (!input) return;
  const results = [];
  for (const targetSessionId of input.targetSessionIds) {
    try {
      const result = await context.store.graftTopics({
        sourceSessionId,
        targetSessionId,
        topicIds: [input.topicId],
        duplicatePolicy: "skip",
      });
      results.push({
        ...result,
        targetTopicId: result.copiedTopics[0]?.id ?? result.existingTargetTopicId,
      });
    } catch (error) {
      results.push({
        sourceSessionId,
        targetSessionId,
        sourceTopicId: input.topicId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  sendJson(response, 200, { sourceSessionId, topicId: input.topicId, results });
}

async function removeTopicGraft(
  response: ServerResponse,
  context: StudioApiContext,
  targetSessionId: string,
  nodeId: string,
): Promise<void> {
  if (!await context.repository.sessionExists(targetSessionId)) {
    sendJson(response, 404, { error: `Session '${targetSessionId}' was not found.` });
    return;
  }
  const removed = await context.store.removeGraftFromSession(targetSessionId, nodeId);
  if (!removed) {
    sendJson(response, 404, { error: `Graft '${nodeId}' was not found in session '${targetSessionId}'.` });
    return;
  }
  sendJson(response, 200, { targetSessionId, nodeId, action: "remove-graft", removed });
}

async function readGraftInput(
  request: IncomingMessage,
  response: ServerResponse,
  context: StudioApiContext,
  sourceSessionId: string,
): Promise<{ topicId: string; targetSessionIds: string[] } | null> {
  if (!await context.repository.sessionExists(sourceSessionId)) {
    sendJson(response, 404, { error: `Session '${sourceSessionId}' was not found.` });
    return null;
  }
  const body = await readJsonBody(request);
  if (!isObject(body)) {
    sendJson(response, 400, { error: "Topic graft requires a JSON object body." });
    return null;
  }
  const topicIds = Array.isArray(body.topicIds) ? body.topicIds.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  const targetSessionIds = Array.isArray(body.targetSessionIds)
    ? [...new Set(body.targetSessionIds.filter((value): value is string => typeof value === "string" && value.length > 0))]
    : [];
  if (topicIds.length !== 1 || targetSessionIds.length === 0 || body.duplicatePolicy !== "skip") {
    sendJson(response, 400, { error: "Topic graft requires one topic ID, at least one target session, and duplicatePolicy 'skip'." });
    return null;
  }
  if (targetSessionIds.includes(sourceSessionId)) {
    sendJson(response, 400, { error: "The source session cannot also be a graft target." });
    return null;
  }
  for (const targetSessionId of targetSessionIds) {
    if (!await context.repository.sessionExists(targetSessionId)) {
      sendJson(response, 404, { error: `Target session '${targetSessionId}' was not found.` });
      return null;
    }
  }
  return { topicId: topicIds[0]!, targetSessionIds };
}

function isActiveMemory(memory: StudioGraftMemory): boolean {
  return !memory.forgotten && !memory.decayed && memory.supersededBy == null;
}

async function sendSessionMemories(
  response: ServerResponse,
  context: StudioApiContext,
  sessionId: string,
): Promise<void> {
  if (!await context.repository.sessionExists(sessionId)) {
    sendJson(response, 404, { error: `Session '${sessionId}' was not found.` });
    return;
  }

  const memories = await context.store.getMemoriesBySession(sessionId);
  sendJson(response, 200, { sessionId, memories });
}

async function sendSessionTables(
  response: ServerResponse,
  context: StudioApiContext,
  sessionId: string,
): Promise<void> {
  if (!await context.repository.sessionExists(sessionId)) {
    sendJson(response, 404, { error: `Session '${sessionId}' was not found.` });
    return;
  }

  const [topics, segments, memories, messages, tables] = await Promise.all([
    context.store.getNodesBySession(sessionId, { includeSuppressed: true }),
    context.store.getSegmentsBySession(sessionId),
    context.store.getMemoriesBySession(sessionId),
    context.store.getMessagesBySession(sessionId),
    context.repository.getTablesBySession(sessionId),
  ]);

  sendJson(response, 200, {
    sessionId,
    topics,
    segments,
    memories,
    messages,
    tables,
    capturedAt: new Date().toISOString(),
  });
}

async function sendPromptPreview(
  request: IncomingMessage,
  response: ServerResponse,
  context: StudioApiContext,
  sessionId: string,
): Promise<void> {
  if (!await context.repository.sessionExists(sessionId)) {
    sendJson(response, 404, { error: `Session '${sessionId}' was not found.` });
    return;
  }

  const status = context.preview?.getStatus() ?? {
    available: false,
    reason: "Prompt Preview is not configured.",
  };
  if (!context.preview || !status.available) {
    sendJson(response, 503, {
      error: "Prompt Preview is unavailable.",
      previewStatus: status,
    });
    return;
  }

  const body = await readJsonBody(request);
  if (!isObject(body)) {
    sendJson(response, 400, { error: "Prompt Preview requires a JSON object body." });
    return;
  }

  const mode = body.mode;
  if (mode !== "graft" && mode !== "recall") {
    sendJson(response, 400, { error: "Prompt Preview mode must be 'graft' or 'recall'." });
    return;
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    sendJson(response, 400, { error: "Prompt Preview requires a non-empty query." });
    return;
  }

  const result = await context.preview.run({
    mode,
    sessionId,
    query,
    ...(isObject(body.graft) ? { graft: body.graft } : {}),
    ...(isObject(body.recall) ? { recall: body.recall } : {}),
  });
  sendJson(response, 200, result);
}

async function sendSessionSearch(
  response: ServerResponse,
  context: StudioApiContext,
  sessionId: string,
  url: URL,
): Promise<void> {
  const query = url.searchParams.get("q")?.trim();
  if (!query) {
    sendJson(response, 400, { error: "Missing required search query parameter 'q'." });
    return;
  }

  if (!await context.repository.sessionExists(sessionId)) {
    sendJson(response, 404, { error: `Session '${sessionId}' was not found.` });
    return;
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  const [topics, memories] = await Promise.all([
    context.repository.searchTopics(sessionId, query, limit),
    context.repository.searchMemories(sessionId, query, limit),
  ]);
  sendJson(response, 200, { sessionId, query, topics, memories });
}

async function sendSuppressTopic(
  response: ServerResponse,
  context: StudioApiContext,
  sessionId: string,
  nodeId: string,
): Promise<void> {
  if (!await context.repository.sessionExists(sessionId)) {
    sendJson(response, 404, { error: `Session '${sessionId}' was not found.` });
    return;
  }

  if (!await context.repository.nodeBelongsToSession(sessionId, nodeId)) {
    sendJson(response, 404, { error: `Topic node '${nodeId}' was not found in session '${sessionId}'.` });
    return;
  }

  const changed = await context.store.suppressTopic(nodeId);

  sendJson(response, 200, { sessionId, nodeId, action: "suppress", changed });
}

function matchRoute(requestUrl: string | undefined): RouteMatch | null {
  const url = parseUrl(requestUrl);
  const rawSegments = url.pathname.split("/").filter(Boolean);
  const segments = rawSegments[0] === "api" ? rawSegments.slice(1) : rawSegments;

  if (segments.length === 0) return null;

  try {
    return {
      segments: segments.map((segment) => decodeURIComponent(segment)),
      url,
    };
  } catch {
    return null;
  }
}

function parseUrl(requestUrl: string | undefined): URL {
  return new URL(requestUrl ?? "/", "http://localhost");
}

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;

  return Math.max(1, Math.min(parsed, 100));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendMethodNotAllowed(response: ServerResponse, methods: string[]): void {
  response.setHeader("allow", methods.join(", "));
  sendJson(response, 405, { error: `Method not allowed. Use ${methods.join(" or ")}.` });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

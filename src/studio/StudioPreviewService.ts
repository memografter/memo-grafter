import { buildInvocationPlan } from "../invocation/InvocationPlanner.js";
import type { InvocationPlan, InvocationProfile, PlannedMemoryContext } from "../invocation/types.js";
import { GrafterPipeline } from "../retrieval/GrafterPipeline.js";
import { RetrieverPipeline } from "../retrieval/RetrieverPipeline.js";
import type { EmbedAdapter, FleetMemoryMode, LLMAdapter, MemoGrafterConfig, RetrievalResult } from "../core/types.js";
import type { GraphStore } from "../store/index.js";
import { composePinnedTopicContext } from "../prompts/pinnedTopicPrompt.js";
import { countApproxTokens } from "../utils/text/tokenCount.js";
import { buildFactRetrievalPrompt, formatFactBlock } from "../prompts/factRetrievalPrompt.js";

export interface StudioPreviewRequest { sessionId: string; query: string; profile?: InvocationProfile; fleetMemoryMode?: FleetMemoryMode; sharedSessionId?: string }
export type StudioPreviewResult = InvocationPlan & { planId: string; expiresAt: string };
export interface StudioPreviewCompletionResult { planId: string; response: string; durationMs: number; completedAt: string }
export interface StudioPreviewStatus { available: boolean; reason?: string; completion: { available: boolean; reason?: string; provider?: string; model?: string } }
export interface StudioPreviewService { getStatus(): StudioPreviewStatus; run(request: StudioPreviewRequest): Promise<StudioPreviewResult>; complete(planId: string, sessionId: string): Promise<StudioPreviewCompletionResult> }
export interface StudioPreviewServiceConfig { embedder?: EmbedAdapter; llm?: LLMAdapter; llmProvider?: string; llmModel?: string; systemPrompt?: string; graph?: MemoGrafterConfig["graph"]; inject?: MemoGrafterConfig["inject"]; cache?: MemoGrafterConfig["cache"] }

const PLAN_TTL_MS = 10 * 60 * 1000;

export function createStudioPreviewService(store: GraphStore, config: StudioPreviewServiceConfig | null | undefined): StudioPreviewService {
  if (!config?.embedder) return new UnavailableStudioPreviewService("Invoke Preview requires an embedder in mg.config.ts or mg.config.js. Configure an embedder to preview invocation-time retrieval.");
  return new PipelineStudioPreviewService(store, config.embedder, config);
}

export class UnavailableStudioPreviewService implements StudioPreviewService {
  constructor(private readonly reason: string) {}
  getStatus(): StudioPreviewStatus { return { available: false, reason: this.reason, completion: { available: false, reason: "Invoke Preview is unavailable." } }; }
  run(): Promise<StudioPreviewResult> { throw new Error(this.reason); }
  complete(): Promise<StudioPreviewCompletionResult> { throw new Error(this.reason); }
}

export class PipelineStudioPreviewService implements StudioPreviewService {
  private readonly grafter: GrafterPipeline;
  private readonly plans = new Map<string, { plan: InvocationPlan; expiresAt: number }>();
  private readonly activePlanBySession = new Map<string, string>();
  constructor(private readonly store: GraphStore, private readonly embedder: EmbedAdapter, private readonly config: StudioPreviewServiceConfig) {
    this.grafter = new GrafterPipeline(store, { hopDepth: config.graph?.hopDepth ?? 1, bufferSize: config.inject?.bufferSize ?? 1, tokenBudget: config.inject?.tokenBudget ?? 4000 });
  }
  getStatus(): StudioPreviewStatus {
    return {
      available: true,
      completion: this.config.llm ? {
        available: true,
        ...(this.config.llmProvider ? { provider: this.config.llmProvider } : {}),
        ...(this.config.llmModel ? { model: this.config.llmModel } : {}),
      } : {
        available: false,
        reason: "Configure an LLM adapter and provider API key in mg.config.ts to run the displayed request.",
      },
    };
  }

  async run(request: StudioPreviewRequest): Promise<StudioPreviewResult> {
    const query = request.query.trim();
    if (!query) throw new Error("Invoke Preview requires a non-empty query.");
    const history = await this.store.getMessagesBySession(request.sessionId);
    const profile = request.profile ?? "memo-grafter-agent";
    const plan = await buildInvocationPlan(request.sessionId, query, {
      profile, history, historySource: "database-backed-preview",
      ...(profile === "memo-grafter-agent" ? { baseSystemPrompt: this.config.systemPrompt ?? "", recentWindowSize: this.config.inject?.recentWindowSize ?? 20 } : {}),
      buildMemoryContext: profile === "fleet-worker" ? () => this.buildFleetContext(request) : () => this.buildAgentContext(request.sessionId, query),
    });
    this.removeExpiredPlans();
    const previousPlanId = this.activePlanBySession.get(request.sessionId);
    if (previousPlanId) this.plans.delete(previousPlanId);
    const planId = randomUUID();
    const expiresAt = Date.now() + PLAN_TTL_MS;
    this.plans.set(planId, { plan, expiresAt });
    this.activePlanBySession.set(request.sessionId, planId);
    return { ...plan, planId, expiresAt: new Date(expiresAt).toISOString() };
  }

  async complete(planId: string, sessionId: string): Promise<StudioPreviewCompletionResult> {
    this.removeExpiredPlans();
    const stored = this.plans.get(planId);
    if (!stored || stored.plan.sessionId !== sessionId) throw new Error("Invocation plan was not found or has expired. Generate a new preview.");
    if (!this.config.llm) throw new Error("LLM execution is unavailable. Configure an LLM adapter and provider API key in mg.config.ts.");
    const startedAt = Date.now();
    try {
      const response = await this.config.llm.complete(stored.plan.request.messages, stored.plan.request.system);
      return { planId, response, durationMs: Date.now() - startedAt, completedAt: new Date().toISOString() };
    } catch {
      throw new Error("The configured LLM request failed. Check the provider credentials, model, rate limits, and network connection.");
    }
  }

  private removeExpiredPlans(): void {
    const now = Date.now();
    for (const [planId, stored] of this.plans) {
      if (stored.expiresAt <= now) {
        this.plans.delete(planId);
        if (this.activePlanBySession.get(stored.plan.sessionId) === planId) this.activePlanBySession.delete(stored.plan.sessionId);
      }
    }
  }

  private async buildAgentContext(sessionId: string, query: string): Promise<PlannedMemoryContext> {
    const limit = this.config.inject?.recallLimit ?? 6;
    const minSimilarity = this.config.inject?.recallMinSimilarity ?? 0.55;
    if (await this.store.getSessionNodeCount(sessionId) === 0) return this.empty("not-applicable", [sessionId], limit, minSimilarity);
    const [pinnedTopics, memories] = await Promise.all([
        this.store.getPinnedTopics(sessionId),
        this.store.getMemoriesBySession(sessionId),
    ]);
    let recallError: unknown;
    let result: RetrievalResult;
    try {
      result = await this.recall(query, sessionId, [sessionId], limit, minSimilarity);
    } catch (error: unknown) {
      recallError = error;
      result = { facts: [], nodes: [], systemPrompt: "", tokenCount: 0 };
    }
      const pinnedIds = new Set(pinnedTopics.map((topic) => topic.id));
      const pinnedMemories = memories.filter((memory) => pinnedIds.has(memory.topicNodeId) && !memory.forgotten && !memory.decayed && memory.supersededBy == null);
      const pinned = composePinnedTopicContext(pinnedTopics, pinnedMemories, this.config.inject?.tokenBudget ?? 4000);
      const pinnedPrompt = pinned.systemPrompt;
      const recalledFacts = result.facts.filter((memory) => !pinnedIds.has(memory.topicNodeId));
      const recalledFactsByTopic = new Map<string, typeof recalledFacts>();
      for (const fact of recalledFacts) recalledFactsByTopic.set(fact.topicNodeId, [...(recalledFactsByTopic.get(fact.topicNodeId) ?? []), fact]);
      const recalledNodes = result.nodes.filter((node) => !pinnedIds.has(node.id));
      const recalledPrompt = recalledFacts.length > 0
        ? buildFactRetrievalPrompt(recalledNodes.map((node) => formatFactBlock(recalledFactsByTopic.get(node.id) ?? [], node)))
        : "";
      const content = [pinnedPrompt, recalledPrompt].filter(Boolean).join("\n\n");
      if (!content) return this.empty("no-match", [sessionId], limit, minSimilarity);
      return {
        placement: "message",
        retrieval: {
          status: recallError ? "failed" : "matched", strategy: "recall",
          topics: [...pinnedTopics, ...recalledNodes],
          memories: [...pinnedMemories, ...recalledFacts], limit, minSimilarity, sessionIds: [sessionId],
          ...(recallError ? { error: { message: recallError instanceof Error ? recallError.message : String(recallError), recoverable: true } } : {}),
        },
        memoryContext: {
          content,
          tokenCount: countApproxTokens(content),
          ...(result.tokenBudget !== undefined ? { tokenBudget: result.tokenBudget } : {}),
          components: [
            ...(pinnedPrompt ? [{ kind: "pinned-topics" as const, content: pinnedPrompt, tokenCount: pinned.tokenCount }] : []),
            ...(recalledPrompt ? [{ kind: "recalled-memory" as const, content: recalledPrompt, tokenCount: result.tokenCount }] : []),
          ],
        },
      };
  }

  private async buildFleetContext(request: StudioPreviewRequest): Promise<PlannedMemoryContext> {
    const mode = request.fleetMemoryMode ?? "local";
    const nodes = await this.store.getNodesBySession(request.sessionId);
    const injected = await this.grafter.run(request.sessionId, nodes.map((node) => node.id));
    const fleetId = nodes.find((node) => node.fleetId)?.fleetId;
    const sharedSessionId = request.sharedSessionId?.trim() || (fleetId ? `fleet:${fleetId}:shared` : undefined);
    const sessionIds = mode === "local" ? [request.sessionId] : mode === "fleet" ? (sharedSessionId ? [sharedSessionId] : []) : [request.sessionId, ...(sharedSessionId ? [sharedSessionId] : [])];
    let recalled: RetrievalResult | null = null;
    let recallError: unknown;
    if (mode !== "local") {
      if (!sharedSessionId) recallError = new Error("Fleet shared session could not be inferred; provide sharedSessionId.");
      else try { recalled = await this.recall(request.query, request.sessionId, sessionIds, 6, 0.55); } catch (error: unknown) { recallError = error; }
    }
    const recallPrompt = recalled?.facts.length ? recalled.systemPrompt : "";
    const content = [injected.systemPrompt, recallPrompt].filter(Boolean).join("\n\n");
    return {
      placement: "system",
      retrieval: {
        status: recallError ? "failed" : content ? "matched" : nodes.length ? "no-match" : "not-applicable", strategy: "fleet-combined",
        topics: [...injected.nodes, ...(recalled?.nodes ?? [])].filter((node, index, all) => all.findIndex((item) => item.id === node.id) === index),
        memories: [...(injected.memories ?? []), ...(recalled?.facts ?? [])], limit: 6, minSimilarity: 0.55, sessionIds,
        ...(recallError ? { error: { message: recallError instanceof Error ? recallError.message : String(recallError), recoverable: true } } : {}),
      },
      memoryContext: {
        content: content || null, tokenCount: injected.tokenCount + (recalled?.tokenCount ?? 0), ...((injected.tokenBudget ?? recalled?.tokenBudget) !== undefined ? { tokenBudget: (injected.tokenBudget ?? recalled?.tokenBudget)! } : {}),
        components: [
          ...(injected.systemPrompt ? [{ kind: "local-topics" as const, content: injected.systemPrompt, tokenCount: injected.tokenCount }] : []),
          ...(recallPrompt ? [{ kind: "recalled-memory" as const, content: recallPrompt, tokenCount: recalled?.tokenCount ?? 0 }] : []),
        ],
      },
    };
  }

  private recall(query: string, sessionId: string, sessionIds: string[], limit: number, minSimilarity: number) {
    return new RetrieverPipeline(this.store, this.embedder, { limit, minSimilarity, sessionIds }).run(query, sessionId);
  }
  private fromRecall(result: RetrievalResult, sessionIds: string[], limit: number, minSimilarity: number): PlannedMemoryContext {
    return { placement: "message", retrieval: { status: "matched", strategy: "recall", topics: result.nodes, memories: result.facts, limit, minSimilarity, sessionIds }, memoryContext: { content: result.systemPrompt, tokenCount: result.tokenCount, ...(result.tokenBudget !== undefined ? { tokenBudget: result.tokenBudget } : {}) } };
  }
  private empty(status: "not-applicable" | "no-match" | "failed", sessionIds: string[], limit: number, minSimilarity: number, error?: unknown): PlannedMemoryContext {
    return { placement: "message", retrieval: { status, strategy: "recall", topics: [], memories: [], limit, minSimilarity, sessionIds, ...(error ? { error: { message: error instanceof Error ? error.message : String(error), recoverable: true } } : {}) }, memoryContext: { content: null, tokenCount: 0 } };
  }
}
import { randomUUID } from "node:crypto";

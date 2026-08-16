import type { MemoryNode, Message, TopicNode } from "../core/types.js";

export type InvocationProfile = "memo-grafter-agent" | "fleet-worker";
export type InvocationHistorySource = "process-local" | "database-backed-preview";
export type InvocationRetrievalStatus = "matched" | "no-match" | "failed" | "not-applicable";

export interface InvocationRetrievalDetails {
  status: InvocationRetrievalStatus;
  strategy: "recall" | "fleet-combined";
  topics: TopicNode[];
  memories: Array<MemoryNode & { similarity?: number }>;
  limit?: number;
  minSimilarity?: number;
  sessionIds?: string[];
  error?: { message: string; recoverable: boolean };
}

export interface InvocationMemoryContext {
  content: string | null;
  components?: Array<{ kind: "local-topics" | "recalled-memory"; content: string; tokenCount: number }>;
  tokenCount: number;
  tokenBudget?: number;
}

export interface InvocationPlan {
  profile: InvocationProfile;
  sessionId: string;
  query: string;
  generatedAt: string;
  historySource: InvocationHistorySource;
  baseSystemPrompt: string;
  conversationWindow: Message[];
  retrieval: InvocationRetrievalDetails;
  memoryContext: InvocationMemoryContext;
  request: { system: string; messages: Message[] };
  /** Human-readable rendering only; this is not a provider payload. */
  plainText: string;
  tokens: {
    baseSystem: number;
    memoryContext: number;
    conversation: number;
    userQuery: number;
    total: number;
    budget?: number;
  };
}

export interface PlannedMemoryContext {
  retrieval: InvocationRetrievalDetails;
  memoryContext: InvocationMemoryContext;
  /** Put memory in messages for MemoGrafterAgent, or in system for Fleet Worker. */
  placement: "message" | "system";
}

export interface InvocationPlanningContext {
  profile: InvocationProfile;
  history: Message[];
  historySource: InvocationHistorySource;
  baseSystemPrompt?: string;
  recentWindowSize?: number;
  queryAlreadyInHistory?: boolean;
  buildMemoryContext(): Promise<PlannedMemoryContext>;
}

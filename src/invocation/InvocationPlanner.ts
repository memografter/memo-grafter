import { countApproxTokens } from "../utils/text/tokenCount.js";
import type { InvocationPlan, InvocationPlanningContext } from "./types.js";
import { renderInvocationRequestPlainText } from "./renderInvocationRequest.js";

export async function buildInvocationPlan(
  sessionId: string,
  query: string,
  context: InvocationPlanningContext,
): Promise<InvocationPlan> {
  const normalizedQuery = query.trim();
  if (!sessionId.trim()) throw new Error("Invocation planning requires a non-empty sessionId.");
  if (!normalizedQuery) throw new Error("Invocation planning requires a non-empty query.");

  const memory = await context.buildMemoryContext();
  const sourceHistory = context.queryAlreadyInHistory ? context.history.slice(0, -1) : context.history;
  const conversationWindow = context.recentWindowSize === undefined
    ? [...sourceHistory]
    : sourceHistory.slice(-context.recentWindowSize);
  const memoryMessage = memory.placement === "message" && memory.memoryContext.content
    ? [{ role: "system" as const, content: memory.memoryContext.content }]
    : [];
  const messages = [
    ...memoryMessage,
    ...conversationWindow,
    { role: "user" as const, content: query },
  ];
  const baseSystemPrompt = context.baseSystemPrompt ?? "";
  const system = memory.placement === "system"
    ? [baseSystemPrompt, memory.memoryContext.content].filter(Boolean).join("\n\n")
    : baseSystemPrompt;
  const tokens = {
    baseSystem: countApproxTokens(baseSystemPrompt),
    memoryContext: memory.memoryContext.tokenCount,
    conversation: conversationWindow.reduce((total, message) => total + countApproxTokens(message.content), 0),
    userQuery: countApproxTokens(query),
  };

  const request = { system, messages };
  return {
    profile: context.profile,
    sessionId,
    query,
    generatedAt: new Date().toISOString(),
    historySource: context.historySource,
    baseSystemPrompt,
    conversationWindow,
    retrieval: memory.retrieval,
    memoryContext: memory.memoryContext,
    request,
    plainText: renderInvocationRequestPlainText(request),
    tokens: {
      ...tokens,
      total: tokens.baseSystem + tokens.memoryContext + tokens.conversation + tokens.userQuery,
      ...(memory.memoryContext.tokenBudget !== undefined ? { budget: memory.memoryContext.tokenBudget } : {}),
    },
  };
}

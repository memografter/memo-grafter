import type { LLMAdapter, Message, RetrievalQueryMetadata, RetrieverConfig } from "../core/types.js";
import { validateCompletion } from "../adapters/validation.js";
import { countApproxTokens } from "../utils/text/tokenCount.js";

const DEFAULT_MAX_MESSAGES = 8;
const DEFAULT_MAX_TOKENS = 600;
const MAX_OUTPUT_LENGTH = 1_000;
const CONTEXT_DEPENDENT = /\b(it|its|that|this|those|these|they|them|their|there|then|else|also|another|more|again|same|former|latter|other|cheaper|better|worse|above|previous(?:ly)?)\b|\b(?:what|how) about\b/i;

export interface ContextualizedRetrievalQuery {
  metadata: RetrievalQueryMetadata;
  warning?: unknown;
}

export class RetrievalQueryContextualizer {
  constructor(private readonly llm?: LLMAdapter) {}

  async run(query: string, config?: RetrieverConfig["contextualization"]): Promise<ContextualizedRetrievalQuery> {
    const original = query.trim();
    const enabled = config?.enabled ?? Boolean(config?.recentMessages?.length);
    if (!enabled) return { metadata: this.metadata(original, original, 0, "disabled") };

    const recentMessages = selectRecentMessages(
      config?.recentMessages ?? [],
      config?.maxMessages ?? DEFAULT_MAX_MESSAGES,
      config?.maxTokens ?? DEFAULT_MAX_TOKENS,
    );
    if (recentMessages.length === 0 || !CONTEXT_DEPENDENT.test(original)) {
      return { metadata: this.metadata(original, original, recentMessages.length, "not-needed") };
    }
    if (!this.llm) {
      return { metadata: this.metadata(original, original, recentMessages.length, "fallback"), warning: new Error("No LLM adapter is available for query contextualization.") };
    }

    try {
      const rewritten = validateCompletion(await this.llm.complete([
        { role: "user", content: buildPrompt(recentMessages, original) },
      ]), "context").trim();
      if (!rewritten || rewritten.length > MAX_OUTPUT_LENGTH || /^(assistant|user|system)\s*:/i.test(rewritten) || rewritten.includes("```")) {
        throw new Error("The contextualized retrieval query was invalid.");
      }
      return { metadata: this.metadata(original, rewritten, recentMessages.length, rewritten === original ? "not-needed" : "applied") };
    } catch (warning) {
      return { metadata: this.metadata(original, original, recentMessages.length, "fallback"), warning };
    }
  }

  private metadata(original: string, retrieval: string, contextMessageCount: number, status: RetrievalQueryMetadata["status"]): RetrievalQueryMetadata {
    return { original, retrieval, contextualized: status === "applied", contextMessageCount, status };
  }
}

export function selectRecentMessages(messages: Message[], maxMessages = DEFAULT_MAX_MESSAGES, maxTokens = DEFAULT_MAX_TOKENS): Message[] {
  const bounded = messages.slice(-Math.max(0, maxMessages));
  const selected: Message[] = [];
  let tokens = 0;
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const message = bounded[index];
    if (!message) continue;
    const messageTokens = countApproxTokens(message.content);
    if (selected.length > 0 && tokens + messageTokens > maxTokens) break;
    if (messageTokens > maxTokens) continue;
    selected.unshift({ role: message.role, content: message.content.trim() });
    tokens += messageTokens;
  }
  // Avoid starting with an orphan assistant response when a paired user turn was truncated.
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

function buildPrompt(messages: Message[], query: string): string {
  const history = messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n");
  return [
    "Rewrite the current user query as one concise, standalone semantic-retrieval query using only the conversation context below.",
    "Do not answer the query. Do not invent details. Return only the rewritten query as plain text.",
    "If context adds nothing necessary, return the current query unchanged.",
    "",
    "RECENT CONVERSATION:", history,
    "", "CURRENT QUERY:", query,
  ].join("\n");
}

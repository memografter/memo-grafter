import assert from "node:assert/strict";
import OpenAI from "openai";
import {
  MemoGrafter,
  OpenAIEmbedAdapter,
  OpenAILLMAdapter,
} from "../../../../src/index.js";
import { requireEnv, uniqueId } from "../helpers/fixtures.js";
import { TelemetryLLMAdapter } from "../helpers/telemetry.js";
import type { ConversationEntry, SmokeTestDefinition } from "../helpers/types.js";

const CHAT_MODEL = "gpt-4o-mini";

export const analyzeContextSmoke: SmokeTestDefinition = {
  suite: "external-application",
  name: "openai-analyze-context",
  runtime: {
    llm: { provider: "OpenAI SDK + OpenAI adapter", model: CHAT_MODEL },
    embedder: { provider: "OpenAI", model: "text-embedding-3-small" },
  },
  async run(context) {
    const databaseUrl = requireEnv("DATABASE_URL");
    const apiKey = requireEnv("OPENAI_API_KEY");
    const sessionId = uniqueId("external-openai");
    const openai = new OpenAI({ apiKey });
    const extractionLlm = new TelemetryLLMAdapter(
      new OpenAILLMAdapter(CHAT_MODEL),
      (usage) => context.telemetry.recordLlmCall(usage),
    );
    const memo = new MemoGrafter({
      db: { connectionString: databaseUrl, telemetry: context.telemetry.databaseTelemetry },
      llm: extractionLlm,
      embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
      drift: { mode: "intent", driftSensitivity: "medium", minSegmentMessages: 2 },
    });
    const conversation: ConversationEntry[] = [];

    const invokeExternalLlm = async (userMessage: string, systemPrompt: string): Promise<string> => {
      const response = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: `Answer concisely.\n\n${systemPrompt}` },
          { role: "user", content: userMessage },
        ],
      });
      const assistantMessage = response.choices[0]?.message.content ?? "";
      context.telemetry.recordLlmCall({
        inputTokens: response.usage?.prompt_tokens ?? Math.ceil((systemPrompt.length + userMessage.length) / 4),
        outputTokens: response.usage?.completion_tokens ?? Math.ceil(assistantMessage.length / 4),
      });
      assert.ok(assistantMessage.trim(), "the OpenAI SDK should return a non-empty answer");
      return assistantMessage;
    };

    try {
      await memo.initialize();
      context.telemetry.start();

      const firstUserMessage = "Remember that for Kyoto I prefer a quiet ryokan and a vegetarian breakfast.";
      const emptyContext = await memo.context({
        sessionId,
        query: firstUserMessage,
        minSimilarity: 0.2,
      });
      assert.equal(emptyContext.facts.length, 0, "a new session should initially have no memory context");

      const firstAssistantMessage = await invokeExternalLlm(firstUserMessage, emptyContext.systemPrompt);
      await memo.analyze({ sessionId, userMessage: firstUserMessage, assistantMessage: firstAssistantMessage });
      conversation.push(
        { role: "user", content: firstUserMessage },
        { role: "assistant", content: firstAssistantMessage },
      );

      const secondUserMessage = "What accommodation and breakfast should I choose in Kyoto?";
      const recalledContext = await memo.context({
        sessionId,
        query: secondUserMessage,
        limit: 10,
        minSimilarity: 0.2,
        tokenBudget: 1200,
      });
      assert.ok(recalledContext.facts.length > 0, "context should retrieve memories created by analyze");
      assert.ok(recalledContext.nodes.length > 0, "context should return the topics used in its prompt");
      assert.ok(recalledContext.systemPrompt.trim(), "context should return a renderable prompt");

      const secondAssistantMessage = await invokeExternalLlm(secondUserMessage, recalledContext.systemPrompt);
      await memo.analyze({ sessionId, userMessage: secondUserMessage, assistantMessage: secondAssistantMessage });
      conversation.push(
        { role: "user", content: secondUserMessage },
        { role: "assistant", content: secondAssistantMessage },
      );

      const { nodes } = await memo.getTopics(sessionId);
      const memories = await memo.store.getMemoriesBySession(sessionId);
      assert.ok(nodes.length > 0, "analyze should persist topic nodes");
      assert.ok(memories.length > 0, "analyze should persist atomic memories");

      return {
        assertions: [
          "OpenAI SDK produced both assistant responses",
          "Analyze persisted topics and atomic memories",
          "Context retrieved fresh memories and their topic nodes",
          "The retrieved system prompt was passed to the external OpenAI SDK call",
        ],
        metrics: {
          sessionId,
          analyzedExchanges: 2,
          topicNodes: nodes.length,
          memoryNodes: memories.length,
          contextFacts: recalledContext.facts.length,
          contextNodes: recalledContext.nodes.length,
          contextTokenCount: recalledContext.tokenCount,
        },
        conversation,
      };
    } finally {
      context.telemetry.stop();
      await memo.store.clearSession(sessionId).catch(() => undefined);
      await memo.close().catch(() => undefined);
    }
  },
};

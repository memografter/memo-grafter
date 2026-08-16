declare const process: {
  env: {
    DATABASE_URL?: string;
    OPENAI_API_KEY?: string;
    MEMO_GRAFTER_LLM_MODEL?: string;
    MEMO_GRAFTER_EMBEDDING_MODEL?: string;
    REDIS_URL?: string;
  };
};

import { defineConfig, OpenAILLMAdapter } from "memo-grafter";

const llmModel = process.env.MEMO_GRAFTER_LLM_MODEL ?? "gpt-4o";
const embeddingModel = process.env.MEMO_GRAFTER_EMBEDDING_MODEL ?? "text-embedding-3-small";

export default defineConfig(() => ({
  db: {
    connectionString: process.env.DATABASE_URL,
  },

  llm: new OpenAILLMAdapter(llmModel),

  // Optional recall cache. Falls back to PostgreSQL if Redis is unavailable.

  // cache: process.env.REDIS_URL
  //   ? { connectionString: process.env.REDIS_URL }
  //   : undefined,

  // Optional Redis-backed ingestion; failed enqueues do not retry synchronously.

  // queue: process.env.REDIS_URL
  //   ? { redisUrl: process.env.REDIS_URL }
  //   : undefined,

  // Set OPENAI_API_KEY in your environment or replace this object with your own embedder.
  embedder: process.env.OPENAI_API_KEY
    ? {
      async embed(text: string): Promise<number[]> {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: embeddingModel,
            input: text,
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI embeddings request failed: ${response.status} ${await response.text()}`);
        }

        const body = await response.json() as { data?: Array<{ embedding?: number[] }> };
        const embedding = body.data?.[0]?.embedding;
        if (!embedding) throw new Error("OpenAI embeddings response did not include an embedding.");
        return embedding;
      },
    }
    : undefined,
}));

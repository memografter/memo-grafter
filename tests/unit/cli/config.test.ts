import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadConfig,
  resolveConnectionString,
  resolveStudioRuntimeConfig,
} from "../../../cli/utils/config.js";

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousEmbeddingModel = process.env.MEMO_GRAFTER_EMBEDDING_MODEL;
const previousRedisUrl = process.env.REDIS_URL;

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
  if (previousOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
  if (previousEmbeddingModel === undefined) {
    delete process.env.MEMO_GRAFTER_EMBEDDING_MODEL;
  } else {
    process.env.MEMO_GRAFTER_EMBEDDING_MODEL = previousEmbeddingModel;
  }
  if (previousRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = previousRedisUrl;
  }
});

describe("CLI config", () => {
  it("resolves connection string by flag, environment, then mg.config.ts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "memo-grafter-config-"));

    process.env.DATABASE_URL = "postgres://env";
    expect(await resolveConnectionString({ cwd, db: "postgres://flag" })).toBe("postgres://flag");
    expect(await resolveConnectionString({ cwd })).toBe("postgres://env");

    delete process.env.DATABASE_URL;
    await mkdir(path.join(cwd, "src", "memo-grafter"), { recursive: true });
    await writeFile(path.join(cwd, "src", "memo-grafter", "mg.config.ts"), `export default {
  db: {
    connectionString: "postgres://config",
  },
};
`, "utf8");

    expect(await resolveConnectionString({ cwd })).toBe("postgres://config");
  });

  it("detects the generated TypeScript OpenAI embedder scaffold for Studio preview", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "memo-grafter-config-"));
    await mkdir(path.join(cwd, "src", "memo-grafter"), { recursive: true });
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MEMO_GRAFTER_EMBEDDING_MODEL = "text-embedding-3-small";
    await writeFile(path.join(cwd, "src", "memo-grafter", "mg.config.ts"), `export default {
  db: {
    connectionString: "postgres://config",
  },
  llm: new OpenAILLMAdapter("gpt-4o"),
  embedder: process.env.OPENAI_API_KEY
    ? {
      async embed(text: string): Promise<number[]> {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          body: JSON.stringify({ input: text }),
        });
        return [];
      },
    }
    : undefined,
};
`, "utf8");

    const runtime = await resolveStudioRuntimeConfig({ cwd });

    expect(runtime?.embedder).toBeDefined();
    expect(typeof runtime?.embedder?.embed).toBe("function");
    expect(typeof runtime?.llm?.complete).toBe("function");
    expect(runtime?.llmProvider).toBe("OpenAI");
  });

  it("ignores commented Redis examples and detects them after opt-in", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "memo-grafter-config-"));
    const directory = path.join(cwd, "src", "memo-grafter");
    await mkdir(directory, { recursive: true });
    process.env.REDIS_URL = "redis://localhost:6379";
    const configPath = path.join(directory, "mg.config.ts");
    await writeFile(configPath, `export default {
  db: { connectionString: "postgres://config" },
  // cache: process.env.REDIS_URL
  //   ? { connectionString: process.env.REDIS_URL }
  //   : undefined,
  /* queue: process.env.REDIS_URL
    ? { redisUrl: process.env.REDIS_URL }
    : undefined, */
  embedderUrl: "https://api.openai.com/v1/embeddings",
};
`, "utf8");

    const commented = await loadConfig(cwd);
    expect(commented?.cache).toBeUndefined();
    expect(commented?.queue).toBeUndefined();

    await writeFile(configPath, `export default {
  db: { connectionString: "postgres://config" },
  cache: process.env.REDIS_URL
    ? { connectionString: process.env.REDIS_URL }
    : undefined,
  queue: process.env.REDIS_URL
    ? { redisUrl: process.env.REDIS_URL }
    : undefined,
};
`, "utf8");

    const enabled = await loadConfig(cwd);
    expect(enabled?.cache?.connectionString).toBe("redis://localhost:6379");
    expect(enabled?.queue?.redisUrl).toBe("redis://localhost:6379");
  });
});

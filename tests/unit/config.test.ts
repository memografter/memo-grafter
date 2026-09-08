import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineConfig,
  resolveMemoGrafterConfig,
  type EmbedAdapter,
  type LLMAdapter,
  type MemoGrafterProjectConfig,
} from "../../src/index.js";

const llm: LLMAdapter = { complete: vi.fn(async () => "ok") };
const embedder: EmbedAdapter = { embed: vi.fn(async () => [0.1]) };

function projectConfig(changes: Partial<MemoGrafterProjectConfig> = {}): MemoGrafterProjectConfig {
  return {
    db: { connectionString: "postgres://example" },
    llm,
    embedder,
    inject: { recallLimit: 6, recentWindowSize: 20 },
    ...changes,
  };
}

describe("MemoGrafter project configuration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defineConfig preserves objects and factories", async () => {
    const object = projectConfig();
    const factory = vi.fn(() => object);

    expect(defineConfig(object)).toBe(object);
    expect(defineConfig(factory)).toBe(factory);
    await expect(resolveMemoGrafterConfig(defineConfig(async () => object))).resolves.toMatchObject(object);
  });

  it("merges nested overrides without losing inherited values", async () => {
    const replacementLlm: LLMAdapter = { complete: vi.fn(async () => "replacement") };
    const resolved = await resolveMemoGrafterConfig(projectConfig({
      graph: { topK: 5, hopDepth: 2 },
      clustering: { enabled: true, candidateLimit: 8 },
      cache: { connectionString: "redis://cache" },
      queue: { redisUrl: "redis://queue" },
    }), {
      llm: replacementLlm,
      graph: { topK: 10 },
      clustering: { candidateLimit: 4 },
      inject: { recallLimit: 12 },
      cache: false,
      queue: false,
    });

    expect(resolved.llm).toBe(replacementLlm);
    expect(resolved.graph).toEqual({ topK: 10, hopDepth: 2 });
    expect(resolved.clustering).toEqual({ enabled: true, candidateLimit: 4 });
    expect(resolved.inject).toEqual({ recallLimit: 12, recentWindowSize: 20 });
    expect(resolved.cache).toBeUndefined();
    expect(resolved.queue).toBeUndefined();
  });

  it("evaluates factories at resolution time", async () => {
    const environment: { connectionString?: string } = {};
    const source = defineConfig(() => projectConfig({
      db: { connectionString: environment.connectionString },
    }));
    environment.connectionString = "postgres://late-bound";

    const resolved = await resolveMemoGrafterConfig(source);

    expect(resolved.db.connectionString).toBe("postgres://late-bound");
  });

  it.each([
    ["database", projectConfig({ db: { connectionString: undefined } }), "db.connectionString is missing"],
    ["llm", projectConfig({ llm: undefined }), "llm is missing or invalid"],
    ["embedder", projectConfig({ embedder: undefined }), "embedder is missing or invalid"],
  ])("reports an actionable error for a missing %s", async (_name, config, message) => {
    await expect(resolveMemoGrafterConfig(config)).rejects.toThrow(message);
  });

  it("does not include database credentials in validation errors", async () => {
    const secret = "postgres://admin:very-secret@example/database";

    await expect(resolveMemoGrafterConfig(projectConfig({
      db: { connectionString: secret },
      llm: undefined,
    }))).rejects.not.toThrow(secret);
  });
});

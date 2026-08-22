import type {
  EmbedAdapter,
  LLMAdapter,
  MemoGrafterCacheConfig,
  MemoGrafterConfig,
  MemoGrafterDatabaseConfig,
  MemoGrafterDriftConfig,
  MemoGrafterGraphConfig,
  MemoGrafterInjectConfig,
  MemoGrafterQueueConfig,
} from "./core/types.js";
import { MemoGrafterError } from "./diagnostics.js";

export interface MemoGrafterProjectDatabaseConfig
  extends Omit<MemoGrafterDatabaseConfig, "connectionString"> {
  connectionString?: string | undefined;
}

export interface MemoGrafterProjectConfig
  extends Omit<MemoGrafterConfig, "db" | "llm" | "embedder"> {
  db: MemoGrafterProjectDatabaseConfig;
  llm?: LLMAdapter | undefined;
  embedder?: EmbedAdapter | undefined;
}

export type MemoGrafterConfigSource =
  | MemoGrafterProjectConfig
  | (() => MemoGrafterProjectConfig | Promise<MemoGrafterProjectConfig>);

export interface MemoGrafterConfigOverrides {
  db?: Partial<MemoGrafterDatabaseConfig>;
  llm?: LLMAdapter;
  embedder?: EmbedAdapter;
  systemPrompt?: string;
  sessionId?: string;
  drift?: Partial<MemoGrafterDriftConfig>;
  graph?: Partial<MemoGrafterGraphConfig>;
  inject?: Partial<MemoGrafterInjectConfig>;
  queue?: MemoGrafterQueueConfig | false;
  cache?: MemoGrafterCacheConfig | false;
  diagnostics?: MemoGrafterConfig["diagnostics"];
}

export function defineConfig(config: MemoGrafterProjectConfig): MemoGrafterProjectConfig;
export function defineConfig(config: () => MemoGrafterProjectConfig | Promise<MemoGrafterProjectConfig>): MemoGrafterConfigSource;
export function defineConfig(config: MemoGrafterConfigSource): MemoGrafterConfigSource {
  return config;
}

export async function resolveMemoGrafterConfig(
  source: MemoGrafterConfigSource,
  overrides: MemoGrafterConfigOverrides = {},
): Promise<MemoGrafterConfig> {
  const projectConfig = typeof source === "function" ? await source() : source;
  const db = { ...projectConfig.db, ...overrides.db };
  const llm = overrides.llm ?? projectConfig.llm;
  const embedder = overrides.embedder ?? projectConfig.embedder;
  const problems: string[] = [];

  if (typeof db.connectionString !== "string" || db.connectionString.trim() === "") {
    problems.push("db.connectionString is missing. Set DATABASE_URL or configure it in mg.config.ts.");
  }
  if (!llm || typeof llm.complete !== "function") {
    problems.push("llm is missing or invalid. Configure an LLM adapter in mg.config.ts or pass an override.");
  }
  if (!embedder || typeof embedder.embed !== "function") {
    problems.push("embedder is missing or invalid. Configure an embedder in mg.config.ts or pass an override.");
  }
  if (problems.length > 0) {
    throw new MemoGrafterError(`Invalid MemoGrafter configuration:\n- ${problems.join("\n- ")}`, {
      code: "CONFIGURATION_INVALID", operation: "create", stage: "configuration", retryable: false,
    });
  }

  const queue = overrides.queue === false ? undefined : overrides.queue ?? projectConfig.queue;
  const cache = overrides.cache === false ? undefined : overrides.cache ?? projectConfig.cache;

  return {
    db: {
      ...db,
      connectionString: db.connectionString as string,
    },
    llm: llm as LLMAdapter,
    embedder: embedder as EmbedAdapter,
    ...(overrides.systemPrompt !== undefined
      ? { systemPrompt: overrides.systemPrompt }
      : projectConfig.systemPrompt !== undefined ? { systemPrompt: projectConfig.systemPrompt } : {}),
    ...((overrides.sessionId ?? projectConfig.sessionId) !== undefined
      ? { sessionId: overrides.sessionId ?? projectConfig.sessionId }
      : {}),
    ...(mergeOptional(projectConfig.drift, overrides.drift, "drift")),
    ...(mergeOptional(projectConfig.graph, overrides.graph, "graph")),
    ...(mergeOptional(projectConfig.inject, overrides.inject, "inject")),
    ...(queue !== undefined ? { queue } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...((overrides.diagnostics ?? projectConfig.diagnostics) !== undefined
      ? { diagnostics: overrides.diagnostics ?? projectConfig.diagnostics } : {}),
  };
}

function mergeOptional<T extends object, K extends string>(
  base: T | undefined,
  override: Partial<T> | undefined,
  key: K,
): { [P in K]?: T } {
  if (base === undefined && override === undefined) return {};
  return { [key]: { ...base, ...override } as T } as { [P in K]?: T };
}

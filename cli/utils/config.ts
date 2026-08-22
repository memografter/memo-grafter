import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MissingDatabaseConfigurationError } from "./database-errors.js";
interface Message { role: "system" | "user" | "assistant"; content: string }
interface AdapterReadiness { ready: boolean; checks: Array<{ id: string; status: "passed" | "warning" | "failed"; code?: string; message: string; help?: string }> }
interface LLMAdapter { complete(messages: Message[], system?: string): Promise<string>; validate?(): Promise<AdapterReadiness> }

export interface MemoGrafterCliConfig {
  llm?: LLMAdapter;
  db?: {
    connectionString?: string;
  };
  embedder?: {
    embed(text: string): Promise<number[]>;
    validate?(): Promise<AdapterReadiness>;
  };
  graph?: {
    topK?: number;
    hopDepth?: number;
  };
  inject?: {
    bufferSize?: number;
    tokenBudget?: number;
    recentWindowSize?: number;
    recallLimit?: number;
    recallMinSimilarity?: number;
  };
  cache?: {
    connectionString: string;
    ttlSeconds?: number;
  };
  queue?: {
    redisUrl: string;
    queueName?: string;
    removeOnComplete?: boolean | number;
    removeOnFail?: boolean | number;
  };
}

export interface StudioRuntimeConfig {
  llm?: LLMAdapter;
  llmProvider?: string;
  llmModel?: string;
  embedder?: MemoGrafterCliConfig["embedder"];
  graph?: MemoGrafterCliConfig["graph"];
  inject?: MemoGrafterCliConfig["inject"];
  cache?: MemoGrafterCliConfig["cache"];
}

export function findConfigFiles(cwd: string): string[] {
  const configBasePaths = [
    path.join(cwd, "src", "memo-grafter", "mg.config"),
    path.join(cwd, "mg.config"),
  ];
  const extensions = [".ts", ".js", ".mjs", ".cjs"];
  return configBasePaths.flatMap((basePath) =>
    extensions
      .map((extension) => `${basePath}${extension}`)
      .filter((filePath) => existsSync(filePath))
  );
}

export async function loadConfig(cwd: string): Promise<MemoGrafterCliConfig | null> {
  const configBasePaths = [
    path.join(cwd, "src", "memo-grafter", "mg.config"),
    path.join(cwd, "mg.config"),
  ];

  for (const configBasePath of configBasePaths) {
    const config = await tryLoadConfig(configBasePath);
    if (config) return config;
  }

  return null;
}

async function tryLoadConfig(configBasePath: string): Promise<MemoGrafterCliConfig | null> {
  const jsConfigPath = `${configBasePath}.js`;
  if (existsSync(jsConfigPath)) {
    try {
      const module = await import(pathToFileURL(jsConfigPath).href);
      return (module.default ?? module) as MemoGrafterCliConfig;
    } catch (error) {
      throw new Error(
        `Failed to load ${path.basename(jsConfigPath)}. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const tsConfigPath = `${configBasePath}.ts`;
  if (!existsSync(tsConfigPath)) return null;

  return parseTypeScriptConfig(readFileSync(tsConfigPath, "utf8"));
}

export async function resolveConnectionString(options: {
  cwd: string;
  db?: string;
}): Promise<string> {
  if (options.db) return options.db;
  loadEnvFile(options.cwd);
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const config = await loadConfig(options.cwd);
  const configured = config?.db?.connectionString;
  if (configured) return configured;

  throw new MissingDatabaseConfigurationError();
}

export async function resolveStudioRuntimeConfig(options: {
  cwd: string;
}): Promise<StudioRuntimeConfig | null> {
  const config = await loadConfig(options.cwd);
  if (!config) return null;

  return {
    ...(config.llm !== undefined ? { llm: config.llm } : {}),
    ...(config.llm !== undefined ? { llmProvider: process.env.OPENAI_API_KEY ? "OpenAI" : "Configured provider" } : {}),
    ...(config.llm !== undefined && process.env.MEMO_GRAFTER_LLM_MODEL ? { llmModel: process.env.MEMO_GRAFTER_LLM_MODEL } : {}),
    ...(config.embedder !== undefined ? { embedder: config.embedder } : {}),
    ...(config.graph !== undefined ? { graph: config.graph } : {}),
    ...(config.inject !== undefined ? { inject: config.inject } : {}),
    ...(config.cache !== undefined ? { cache: config.cache } : {}),
  };
}

export function loadEnvFile(cwd: string): boolean {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) return false;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = stripEnvQuotes(rawValue);
  }
  return true;
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseTypeScriptConfig(source: string): MemoGrafterCliConfig {
  const activeSource = stripTypeScriptComments(source);
  const config: MemoGrafterCliConfig = {};
  const dbBlock = activeSource.match(/\bdb\s*:\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const envMatch = dbBlock.match(/connectionString\s*:\s*process\.env\.([A-Z0-9_]+)/);
  if (envMatch?.[1]) {
    const connectionString = process.env[envMatch[1]];
    if (connectionString) {
      config.db = {
        connectionString,
      };
    }
  } else {
    const literalMatch = dbBlock.match(/connectionString\s*:\s*["'`]([^"'`]+)["'`]/);
    if (literalMatch?.[1]) {
      config.db = {
        connectionString: literalMatch[1],
      };
    }
  }

  const hasOpenAiEmbedderScaffold = /OPENAI_API_KEY/.test(activeSource)
    && /https:\/\/api\.openai\.com\/v1\/embeddings/.test(activeSource)
    && /\bembedder\s*:/.test(activeSource);
  if (hasOpenAiEmbedderScaffold && process.env.OPENAI_API_KEY) {
    config.embedder = createOpenAiEmbedder(
      process.env.OPENAI_API_KEY,
      process.env.MEMO_GRAFTER_EMBEDDING_MODEL ?? "text-embedding-3-small",
    );
  }

  const hasOpenAiLlmScaffold = /\bllm\s*:\s*new\s+OpenAILLMAdapter\s*\(/.test(activeSource);
  if (hasOpenAiLlmScaffold && process.env.OPENAI_API_KEY) {
    config.llm = createOpenAiLlm(
      process.env.OPENAI_API_KEY,
      process.env.MEMO_GRAFTER_LLM_MODEL ?? "gpt-4o",
    );
  }

  const cacheConnectionString = resolveConfigString(
    activeSource,
    "cache",
    "connectionString",
  );
  if (cacheConnectionString) {
    config.cache = { connectionString: cacheConnectionString };
  }

  const queueRedisUrl = resolveConfigString(activeSource, "queue", "redisUrl");
  if (queueRedisUrl) {
    config.queue = { redisUrl: queueRedisUrl };
  }

  return config;
}

function resolveConfigString(source: string, property: string, valueKey: string): string | undefined {
  const conditional = new RegExp(
    `\\b${property}\\s*:\\s*process\\.env\\.([A-Z0-9_]+)\\s*`
    + `\\?\\s*\\{\\s*${valueKey}\\s*:\\s*process\\.env\\.([A-Z0-9_]+)[^}]*\\}`
    + `\\s*:\\s*undefined`,
  ).exec(source);
  if (conditional?.[1] && conditional[2]) {
    const enabled = process.env[conditional[1]];
    return enabled ? process.env[conditional[2]] : undefined;
  }

  const objectBlock = new RegExp(`\\b${property}\\s*:\\s*\\{([\\s\\S]*?)\\}`).exec(source)?.[1];
  if (!objectBlock) return undefined;
  const envName = new RegExp(`${valueKey}\\s*:\\s*process\\.env\\.([A-Z0-9_]+)`).exec(objectBlock)?.[1];
  if (envName) return process.env[envName];
  return new RegExp(`${valueKey}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(objectBlock)?.[1];
}

function stripTypeScriptComments(source: string): string {
  let output = "";
  let quote: "'" | "\"" | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        output += character;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }

  return output;
}

function createOpenAiEmbedder(apiKey: string, model: string): NonNullable<MemoGrafterCliConfig["embedder"]> {
  return {
    async embed(text: string): Promise<number[]> {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
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
  };
}

function createOpenAiLlm(apiKey: string, model: string): LLMAdapter {
  return {
    async complete(messages: Message[], system?: string): Promise<string> {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [...(system ? [{ role: "system" as const, content: system }] : []), ...messages],
        }),
      });
      if (!response.ok) throw new Error(`OpenAI completion request failed with status ${response.status}.`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("OpenAI completion response did not include text.");
      return content;
    },
  };
}

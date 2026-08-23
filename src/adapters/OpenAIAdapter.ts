import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { EmbedAdapter, LLMAdapter, MemoGrafterOperationOptions, Message } from "../core/types.js";
import { MemoGrafterError, isMemoGrafterError, type AdapterReadiness } from "../diagnostics.js";
import { validateCompletion, validateEmbedding } from "./validation.js";

export interface OpenAILLMAdapterOptions {
  streaming?: boolean;
  onChunk?: (chunk: string) => void | Promise<void>;
}

export class OpenAILLMAdapter implements LLMAdapter {
  private clientPromise: Promise<OpenAI> | undefined;

  constructor(
    private readonly model = "gpt-4o",
    private readonly options: OpenAILLMAdapterOptions = {},
  ) {}

  async complete(messages: Message[], system?: string, operationOptions?: MemoGrafterOperationOptions): Promise<string> {
    const openAiMessages: ChatCompletionMessageParam[] = [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];

    try {
      const client = await this.getClient();

      if (this.options.streaming) {
        const request = {
          model: this.model,
          messages: openAiMessages,
          stream: true,
        } as const;
        const stream = operationOptions?.signal
          ? await client.chat.completions.create(request, { signal: operationOptions.signal })
          : await client.chat.completions.create(request);
        let response = "";

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta.content;
          if (!content) continue;

          response += content;
          await this.options.onChunk?.(content);
        }

        return validateCompletion(response);
      }

      const request = {
        model: this.model,
        messages: openAiMessages,
      };
      const response = operationOptions?.signal
        ? await client.chat.completions.create(request, { signal: operationOptions.signal })
        : await client.chat.completions.create(request);

      return validateCompletion(response.choices[0]?.message.content);
    } catch (error) {
      if (isMemoGrafterError(error)) throw error;
      throw new MemoGrafterError(
        "OpenAI completion failed. Configure OPENAI_API_KEY and verify the model and credentials.",
        { code: "PROVIDER_REQUEST_FAILED", operation: "ingest", stage: "provider-request", retryable: true, cause: error },
      );
    }
  }

  validate(): Promise<AdapterReadiness> { return validateOpenAI("llm"); }

  private getClient(): Promise<OpenAI> {
    if (this.clientPromise) return this.clientPromise;
    const loading = loadOpenAIClient();
    this.clientPromise = loading;
    void loading.catch(() => {
      if (this.clientPromise === loading) this.clientPromise = undefined;
    });
    return loading;
  }
}

export class OpenAIEmbedAdapter implements EmbedAdapter {
  private clientPromise: Promise<OpenAI> | undefined;

  readonly dimensions: number;
  constructor(private readonly model = "text-embedding-3-small", dimensions = 1536) { this.dimensions = dimensions; }

  async embed(text: string, operationOptions?: MemoGrafterOperationOptions): Promise<number[]> {
    try {
      const client = await this.getClient();
      const request = {
        model: this.model,
        input: text,
      };
      const response = operationOptions?.signal
        ? await client.embeddings.create(request, { signal: operationOptions.signal })
        : await client.embeddings.create(request);

      return validateEmbedding(response.data[0]?.embedding, this.dimensions);
    } catch (error) {
      if (isMemoGrafterError(error)) throw error;
      throw new MemoGrafterError(
        "OpenAI embedding failed. Configure OPENAI_API_KEY and verify the embedding model and credentials.",
        { code: "PROVIDER_REQUEST_FAILED", operation: "ingest", stage: "provider-request", retryable: true, cause: error },
      );
    }
  }

  validate(): Promise<AdapterReadiness> { return validateOpenAI("embedder"); }

  private getClient(): Promise<OpenAI> {
    if (this.clientPromise) return this.clientPromise;
    const loading = loadOpenAIClient();
    this.clientPromise = loading;
    void loading.catch(() => {
      if (this.clientPromise === loading) this.clientPromise = undefined;
    });
    return loading;
  }
}

const missingOpenAISdkMessage =
  'OpenAI adapter requires the optional "openai" package. Install it with: npm install openai';

async function loadOpenAIClient(): Promise<OpenAI> {
  try {
    const { default: OpenAIClient } = await import("openai");
    return new OpenAIClient();
  } catch (error) {
    if (isModuleNotFound(error, "openai")) {
      throw new MemoGrafterError(missingOpenAISdkMessage, { code: "PROVIDER_SDK_MISSING", operation: "readiness", stage: "provider-loading", retryable: false, context: { provider: "openai" }, cause: error });
    }
    throw error;
  }
}

async function validateOpenAI(adapter: string): Promise<AdapterReadiness> {
  const checks: AdapterReadiness["checks"] = [];
  try { await import("openai"); checks.push({ id: `adapter.${adapter}.openai-sdk`, status: "passed", message: "OpenAI SDK is installed." }); }
  catch { checks.push({ id: `adapter.${adapter}.openai-sdk`, status: "failed", code: "PROVIDER_SDK_MISSING", message: missingOpenAISdkMessage, help: "Install it with: npm install openai" }); }
  checks.push(process.env.OPENAI_API_KEY
    ? { id: `adapter.${adapter}.openai-key`, status: "passed", message: "OPENAI_API_KEY is configured." }
    : { id: `adapter.${adapter}.openai-key`, status: "failed", code: "PROVIDER_CONFIGURATION_MISSING", message: "OPENAI_API_KEY is not configured.", help: "Set OPENAI_API_KEY before using the adapter." });
  return { ready: checks.every((check) => check.status !== "failed"), checks };
}

function isModuleNotFound(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
    && error.message.includes(packageName);
}

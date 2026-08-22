import type { Content, GoogleGenAI } from "@google/genai";
import type { EmbedAdapter, LLMAdapter, Message } from "../core/types.js";
import { MemoGrafterError, isMemoGrafterError, type AdapterReadiness } from "../diagnostics.js";
import { validateCompletion, validateEmbedding } from "./validation.js";

export class GeminiLLMAdapter implements LLMAdapter {
  private clientPromise: Promise<GoogleGenAI> | undefined;

  constructor(private readonly model = "gemini-2.5-flash") {}

  async complete(messages: Message[], system?: string): Promise<string> {
    const systemMessages = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    const contents: Content[] = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
    const systemInstruction = [system, ...systemMessages].filter(Boolean).join("\n\n");

    try {
      const client = await this.getClient();
      const response = await client.models.generateContent({
        model: this.model,
        contents,
        ...(systemInstruction ? { config: { systemInstruction } } : {}),
      });

      return validateCompletion(response.text);
    } catch (error) {
      if (isMemoGrafterError(error)) throw error;
      throw new MemoGrafterError(
        "Gemini completion failed. Configure GEMINI_API_KEY and verify the model and credentials.",
        { code: "PROVIDER_REQUEST_FAILED", operation: "ingest", stage: "provider-request", retryable: true, cause: error },
      );
    }
  }

  validate(): Promise<AdapterReadiness> { return validateGemini("llm"); }

  private getClient(): Promise<GoogleGenAI> {
    if (this.clientPromise) return this.clientPromise;
    const loading = loadGeminiClient();
    this.clientPromise = loading;
    void loading.catch(() => {
      if (this.clientPromise === loading) this.clientPromise = undefined;
    });
    return loading;
  }
}

export class GeminiEmbedAdapter implements EmbedAdapter {
  private clientPromise: Promise<GoogleGenAI> | undefined;

  constructor(
    private readonly model = "gemini-embedding-001",
    readonly dimensions = 1536
  ) {}

  async embed(text: string): Promise<number[]> {
    try {
      const client = await this.getClient();
      const response = await client.models.embedContent({
        model: this.model,
        contents: text,
        config: {
          outputDimensionality: this.dimensions,
          taskType: "SEMANTIC_SIMILARITY",
        },
      });

      return validateEmbedding(response.embeddings?.[0]?.values, this.dimensions);
    } catch (error) {
      if (isMemoGrafterError(error)) throw error;
      throw new MemoGrafterError(
        "Gemini embedding failed. Configure GEMINI_API_KEY and verify the embedding model and credentials.",
        { code: "PROVIDER_REQUEST_FAILED", operation: "ingest", stage: "provider-request", retryable: true, cause: error },
      );
    }
  }

  validate(): Promise<AdapterReadiness> { return validateGemini("embedder"); }

  private getClient(): Promise<GoogleGenAI> {
    if (this.clientPromise) return this.clientPromise;
    const loading = loadGeminiClient();
    this.clientPromise = loading;
    void loading.catch(() => {
      if (this.clientPromise === loading) this.clientPromise = undefined;
    });
    return loading;
  }
}

const missingGeminiSdkMessage =
  'Gemini adapter requires the optional "@google/genai" package. Install it with: npm install @google/genai';

async function loadGeminiClient(): Promise<GoogleGenAI> {
  try {
    const { GoogleGenAI: GoogleGenAIClient } = await import("@google/genai");
    return new GoogleGenAIClient(
      process.env.GEMINI_API_KEY ? { apiKey: process.env.GEMINI_API_KEY } : {},
    );
  } catch (error) {
    if (isModuleNotFound(error, "@google/genai")) {
      throw new MemoGrafterError(missingGeminiSdkMessage, { code: "PROVIDER_SDK_MISSING", operation: "readiness", stage: "provider-loading", retryable: false, context: { provider: "gemini" }, cause: error });
    }
    throw error;
  }
}

async function validateGemini(adapter: string): Promise<AdapterReadiness> {
  const checks: AdapterReadiness["checks"] = [];
  try { await import("@google/genai"); checks.push({ id: `adapter.${adapter}.gemini-sdk`, status: "passed", message: "Gemini SDK is installed." }); }
  catch { checks.push({ id: `adapter.${adapter}.gemini-sdk`, status: "failed", code: "PROVIDER_SDK_MISSING", message: missingGeminiSdkMessage, help: "Install it with: npm install @google/genai" }); }
  checks.push(process.env.GEMINI_API_KEY
    ? { id: `adapter.${adapter}.gemini-key`, status: "passed", message: "GEMINI_API_KEY is configured." }
    : { id: `adapter.${adapter}.gemini-key`, status: "failed", code: "PROVIDER_CONFIGURATION_MISSING", message: "GEMINI_API_KEY is not configured.", help: "Set GEMINI_API_KEY before using the adapter." });
  return { ready: checks.every((check) => check.status !== "failed"), checks };
}

function isModuleNotFound(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
    && error.message.includes(packageName);
}

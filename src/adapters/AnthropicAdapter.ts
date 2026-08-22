import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { LLMAdapter, Message } from "../core/types.js";
import { MemoGrafterError, isMemoGrafterError, type AdapterReadiness } from "../diagnostics.js";
import { validateCompletion } from "./validation.js";

export class AnthropicLLMAdapter implements LLMAdapter {
  private clientPromise: Promise<Anthropic> | undefined;

  constructor(
    private readonly model = "claude-sonnet-4-5",
    private readonly maxTokens = 1024
  ) {}

  async complete(messages: Message[], system?: string): Promise<string> {
    const systemMessages = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    const anthropicMessages: MessageParam[] = messages
      .filter((message): message is Message & { role: "user" | "assistant" } => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));
    const systemPrompt = [system, ...systemMessages].filter(Boolean).join("\n\n");

    try {
      const client = await this.getClient();
      const response = await client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: anthropicMessages,
      });

      return validateCompletion(response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""));
    } catch (error) {
      if (isMemoGrafterError(error)) throw error;
      throw new MemoGrafterError(
        "Anthropic completion failed. Configure ANTHROPIC_API_KEY and verify the model and credentials.",
        { code: "PROVIDER_REQUEST_FAILED", operation: "ingest", stage: "provider-request", retryable: true, cause: error },
      );
    }
  }

  async validate(): Promise<AdapterReadiness> {
    const checks: AdapterReadiness["checks"] = [];
    try { await import("@anthropic-ai/sdk"); checks.push({ id: "adapter.llm.anthropic-sdk", status: "passed", message: "Anthropic SDK is installed." }); }
    catch { checks.push({ id: "adapter.llm.anthropic-sdk", status: "failed", code: "PROVIDER_SDK_MISSING", message: missingAnthropicSdkMessage, help: "Install it with: npm install @anthropic-ai/sdk" }); }
    checks.push(process.env.ANTHROPIC_API_KEY
      ? { id: "adapter.llm.anthropic-key", status: "passed", message: "ANTHROPIC_API_KEY is configured." }
      : { id: "adapter.llm.anthropic-key", status: "failed", code: "PROVIDER_CONFIGURATION_MISSING", message: "ANTHROPIC_API_KEY is not configured.", help: "Set ANTHROPIC_API_KEY before using the adapter." });
    return { ready: checks.every((check) => check.status !== "failed"), checks };
  }

  private getClient(): Promise<Anthropic> {
    if (this.clientPromise) return this.clientPromise;
    const loading = loadAnthropicClient();
    this.clientPromise = loading;
    void loading.catch(() => {
      if (this.clientPromise === loading) this.clientPromise = undefined;
    });
    return loading;
  }
}

const missingAnthropicSdkMessage =
  'AnthropicLLMAdapter requires the optional "@anthropic-ai/sdk" package. Install it with: npm install @anthropic-ai/sdk';

async function loadAnthropicClient(): Promise<Anthropic> {
  try {
    const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
    return new AnthropicClient();
  } catch (error) {
    if (isModuleNotFound(error, "@anthropic-ai/sdk")) {
      throw new MemoGrafterError(missingAnthropicSdkMessage, { code: "PROVIDER_SDK_MISSING", operation: "readiness", stage: "provider-loading", retryable: false, context: { provider: "anthropic" }, cause: error });
    }
    throw error;
  }
}

function isModuleNotFound(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
    && error.message.includes(packageName);
}

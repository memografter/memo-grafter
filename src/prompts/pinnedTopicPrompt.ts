import type { MemoryNode, TopicNode } from "../core/types.js";
import { countApproxTokens } from "../utils/text/tokenCount.js";

export function buildPinnedTopicPrompt(blocks: string[]): string {
  if (blocks.length === 0) return "";
  return [
    "### Pinned Session Topics",
    "Always treat these topics as active session context, even when the current query is unrelated.",
    "",
    blocks.join("\n---\n"),
  ].join("\n");
}

export function formatPinnedTopicBlock(topic: TopicNode, memories: MemoryNode[], summary = topic.summary): string {
  const facts = memories
    .filter((memory) => !memory.forgotten && !memory.decayed && memory.supersededBy == null)
    .map((memory) => `- ${memory.subject} ${memory.predicate}: ${memory.value}`);
  return [
    `## ${topic.label}`,
    summary.replace(/\s+/g, " ").trim(),
    ...(facts.length > 0 ? ["Active facts:", ...facts] : []),
  ].filter(Boolean).join("\n");
}

export function composePinnedTopicContext(
  nodes: TopicNode[],
  memories: MemoryNode[],
  tokenBudget: number,
): { systemPrompt: string; tokenCount: number; truncated: boolean } {
  let blocks = nodes.map((node) => formatPinnedTopicBlock(node, memories.filter((memory) => memory.topicNodeId === node.id)));
  let systemPrompt = buildPinnedTopicPrompt(blocks);
  let truncated = false;
  if (countApproxTokens(systemPrompt) > tokenBudget) {
    truncated = true;
    blocks = nodes.map((node) => formatPinnedTopicBlock(node, [], node.summary));
    systemPrompt = buildPinnedTopicPrompt(blocks);
  }
  if (countApproxTokens(systemPrompt) > tokenBudget) {
    const charsPerTopic = Math.max(40, Math.floor((tokenBudget * 3) / Math.max(nodes.length, 1)));
    blocks = nodes.map((node) => formatPinnedTopicBlock(node, [], `${node.summary.slice(0, charsPerTopic)}…`));
    systemPrompt = buildPinnedTopicPrompt(blocks);
  }
  return { systemPrompt, tokenCount: countApproxTokens(systemPrompt), truncated };
}

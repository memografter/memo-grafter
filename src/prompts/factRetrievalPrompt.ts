import { normalizeMemoryQuality } from "../utils/memoryQuality.js";
import type { MemoryNode, TopicNode } from "../core/types.js";

const FACT_RETRIEVAL_SUBHEADER =
  "The following facts were retrieved from prior conversation memory. " +
  "Use them to inform your response where relevant.";

function compactSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}

function formatFactLine(fact: MemoryNode): string {
  const quality = normalizeMemoryQuality(fact.quality);
  return `[${fact.memoryType.toUpperCase()}] ${fact.subject} → ${fact.predicate}: ` +
    `${fact.value} (evidence: ${quality.explicitness.toFixed(2)}, source: ${quality.sourceReliability.toFixed(2)})`;
}

export function formatFactBlock(facts: MemoryNode[], parentNode: TopicNode): string {
  const header = `## ${parentNode.label} (order: ${parentNode.topicOrder})`;
  const summary = `> ${compactSummary(parentNode.summary)}`;

  if (facts.length === 0) {
    return [header, "", summary].join("\n") + "\n";
  }

  return [header, ...facts.map(formatFactLine), "", summary].join("\n") + "\n";
}

export function buildFactRetrievalPrompt(blocks: string[]): string {
  if (blocks.length === 0) {
    return ["### Retrieved Memory", FACT_RETRIEVAL_SUBHEADER].join("\n") + "\n";
  }

  return ["### Retrieved Memory", FACT_RETRIEVAL_SUBHEADER, "", blocks.join("\n---\n")]
    .join("\n") + "\n";
}

import type { TopicClusterMetadata } from "../core/types.js";
import type { GraphStore } from "../store/GraphStore.js";
import { emitWarning, type MemoGrafterDiagnostics, type MemoGrafterWarning } from "../diagnostics.js";

/** Fresh metadata for selected topics only. No candidate expansion and no prompt formatting. */
export async function loadClusterMetadata(store: GraphStore, topics: Array<{ id: string; sessionId: string }>,
  warnings: MemoGrafterWarning[] = [], diagnostics?: MemoGrafterDiagnostics): Promise<TopicClusterMetadata | undefined> {
  if (!store.getTopicClusterMetadata || !topics.length) return undefined;
  try {
    return await store.getTopicClusterMetadata([...new Map(topics.map(topic => [topic.id, { id: topic.id, sessionId: topic.sessionId }])).values()]);
  } catch (cause) {
    const warning: MemoGrafterWarning = { code: "BEST_EFFORT_OPERATION_FAILED", operation: "context",
      context: { reason: "cluster-metadata" }, cause };
    warnings.push(warning); emitWarning(diagnostics, warning);
    return undefined;
  }
}

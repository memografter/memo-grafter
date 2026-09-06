import { buildMemoryInjectionPrompt, formatMemoryNode } from "../prompts/memoryInjectionPrompt.js";
import type { GraphStore } from "../store/index.js";
import type { GraftExpansionStrategy, InjectionResult, MemoryEdge, MemoryNode, TopicNode } from "../core/types.js";
import { countApproxTokens } from "../utils/text/tokenCount.js";

export interface GrafterPipelineRunOptions {
  hopDepth?: number;
  expansionStrategy?: GraftExpansionStrategy;
  sessionIds?: string[];
}

export class GrafterPipeline {
  constructor(
    /** @internal */
    private store: GraphStore,
    /** @internal */
    private config: {
      hopDepth: number;
      bufferSize: number;
      tokenBudget: number;
    },
  ) {}

  async run(sessionId: string, topicIds: string[], options: GrafterPipelineRunOptions = {}): Promise<InjectionResult> {
    if (topicIds.length === 0) {
      return { systemPrompt: "", nodes: [], tokenCount: 0, tokenBudget: this.config.tokenBudget };
    }

    const hopDepth = options.expansionStrategy === "none" ? 0 : options.hopDepth ?? this.config.hopDepth;
    const sessionIds = this.resolveSessionIds(sessionId, options.sessionIds);
    const useConfiguredSessions = sessionIds.length > 1 || sessionIds[0] !== sessionId;
    const neighbourhood = await this.store.getNeighbours(
      topicIds,
      hopDepth,
      useConfiguredSessions ? undefined : sessionId,
    );
    const allowedSessions = new Set(sessionIds);
    const nodes = neighbourhood
      .filter((node) => allowedSessions.has(node.sessionId))
      .filter((node) => !node.suppressed)
      .sort((a, b) =>
        a.sessionId.localeCompare(b.sessionId)
        ||
        a.messageRange[0] - b.messageRange[0]
        || a.messageRange[1] - b.messageRange[1]
        || a.topicOrder - b.topicOrder
      );
    const fittedNodes = [...nodes];
    let systemPrompt = await this.assemblePrompt(fittedNodes);
    let tokenCount = countApproxTokens(systemPrompt);

    while (tokenCount > this.config.tokenBudget && fittedNodes.length > 0) {
      fittedNodes.pop();
      systemPrompt = await this.assemblePrompt(fittedNodes);
      tokenCount = countApproxTokens(systemPrompt);
    }

    return {
      systemPrompt,
      nodes: fittedNodes,
      tokenCount,
      tokenBudget: this.config.tokenBudget,
    };
  }

  private async assemblePrompt(nodes: TopicNode[]): Promise<string> {
    if (nodes.length === 0) return "";

    const blocks: string[] = [];
    const memoryBySession = new Map<string, MemoryNode[]>();
    const edgeBySession = new Map<string, MemoryEdge[]>();

    for (const node of nodes) {
      const sessionId = node.sessionId;
      let sessionMemories = memoryBySession.get(sessionId);
      if (!sessionMemories) {
        sessionMemories = (await this.store.getMemoriesBySession(sessionId))
          .filter((memory) => !memory.forgotten);
        memoryBySession.set(sessionId, sessionMemories);
      }

      let memoryEdges = edgeBySession.get(sessionId);
      if (!memoryEdges) {
        const visibleMemoryIds = new Set(sessionMemories.map((memory) => memory.id));
        memoryEdges = (await this.store.getMemoryEdgesBySession(sessionId))
          .filter((edge) => visibleMemoryIds.has(edge.sourceId) && visibleMemoryIds.has(edge.targetId));
        edgeBySession.set(sessionId, memoryEdges);
      }

      const episodes = await this.store.getEpisodesByTopic?.(node.id, 20) ?? [];
      const ranges = episodes.length > 0 ? episodes.map((episode) => episode.messageRange) : [node.messageRange];
      const messageGroups = await Promise.all(ranges.map(([rangeStart, rangeEnd]) => {
        const buffer = episodes.length > 0 ? 0 : this.config.bufferSize;
        return this.store.getBufferMessages(sessionId, Math.max(0, rangeStart - buffer), rangeEnd + buffer);
      }));
      const messages = messageGroups.flat();
      const topicMemories = sessionMemories.filter((memory) => memory.topicNodeId === node.id);
      blocks.push(formatMemoryNode(
        node,
        messages,
        buildMaintenancePromptContext(topicMemories, sessionMemories, memoryEdges),
      ));
    }

    return buildMemoryInjectionPrompt(blocks);
  }

  private resolveSessionIds(sessionId: string, configured?: string[]): string[] {
    const sessionIds = configured && configured.length > 0 ? configured : [sessionId];
    return [...new Set(sessionIds)];
  }
}

function buildMaintenancePromptContext(
  topicMemories: MemoryNode[],
  sessionMemories: MemoryNode[],
  memoryEdges: MemoryEdge[],
): { notes?: string[]; activeMemories?: MemoryNode[] } {
  const notes: string[] = [];
  const topicMemoryIds = new Set(topicMemories.map((memory) => memory.id));
  const memoriesById = new Map(sessionMemories.map((memory) => [memory.id, memory]));
  const hasMaintenanceEdge = memoryEdges.some((edge) =>
    (edge.edgeType === "conflicts" || edge.edgeType === "updates")
    && (topicMemoryIds.has(edge.sourceId) || topicMemoryIds.has(edge.targetId))
  );
  const hasConflict = topicMemories.some((memory) => memory.hasConflict);
  const supersededMemories = topicMemories.filter((memory) => memory.supersededBy != null);

  for (const memory of supersededMemories) {
    const supersedingMemory = memory.supersededBy ? memoriesById.get(memory.supersededBy) : undefined;
    if (supersedingMemory) {
      notes.push(
        `The fact "${memory.subject} ${memory.predicate}: ${memory.value}" was superseded by "${supersedingMemory.value}".`,
      );
    } else {
      notes.push(
        `The fact "${memory.subject} ${memory.predicate}: ${memory.value}" was superseded by a newer memory.`,
      );
    }
  }

  if (hasConflict || supersededMemories.length > 0 || hasMaintenanceEdge) {
    notes.push("Prefer active memory facts over contradictory historical summary details.");
  }

  const activeMemoriesById = new Map<string, MemoryNode>();
  for (const memory of topicMemories) {
    if (!memory.decayed && memory.supersededBy == null) {
      activeMemoriesById.set(memory.id, memory);
    }
  }
  for (const memory of supersededMemories) {
    const supersedingMemory = memory.supersededBy ? memoriesById.get(memory.supersededBy) : undefined;
    if (supersedingMemory && !supersedingMemory.decayed && supersedingMemory.supersededBy == null) {
      activeMemoriesById.set(supersedingMemory.id, supersedingMemory);
    }
  }
  const activeMemories = [...activeMemoriesById.values()];

  return {
    ...(notes.length > 0 ? { notes } : {}),
    ...(notes.length > 0 && activeMemories.length > 0 ? { activeMemories } : {}),
  };
}

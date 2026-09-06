import type { Episode, TopicNode } from "../../core/types.js";
import type { GraphStore } from "../../store/index.js";
import { cosineSimilarity } from "../../utils/drift/cosineSimilarity.js";
import { normalizeTags } from "../../utils/tags.js";

export interface TopicAssignment {
  topic: TopicNode;
  createTopic: boolean;
  similarity: number | null;
}

/** Assigns episode-sized events to stable, session-scoped topics. */
export class TopicAssigner {
  constructor(
    private readonly store: GraphStore,
    private readonly config: { reuseThreshold?: number; candidateLimit?: number } = {},
  ) {}

  async assign(episode: Episode, proposed: TopicNode, currentRunTopics: TopicNode[] = []): Promise<TopicAssignment> {
    const limit = Math.max(1, this.config.candidateLimit ?? 8);
    const persisted = await this.store.getSimilarNodes(episode.embedding, episode.sessionId, {
      k: limit,
      minSimilarity: -1,
    });
    const candidates = new Map<string, TopicNode>();
    for (const topic of [...persisted, ...currentRunTopics]) {
      if (topic.sessionId === episode.sessionId && !topic.suppressed) candidates.set(topic.id, topic);
    }
    const ranked = [...candidates.values()]
      .map((topic) => ({ topic, similarity: cosineSimilarity(episode.embedding, topic.embedding) }))
      .sort((a, b) => b.similarity - a.similarity || a.topic.id.localeCompare(b.topic.id));
    const best = ranked[0];
    if (!best || best.similarity < (this.config.reuseThreshold ?? 0.82)) {
      return { topic: this.createTopic(proposed, episode), createTopic: true, similarity: null };
    }
    return { topic: this.updateTopic(best.topic, episode), createTopic: false, similarity: best.similarity };
  }

  private createTopic(topic: TopicNode, episode: Episode): TopicNode {
    return {
      ...topic,
      segmentId: episode.segmentId,
      messageRange: episode.messageRange,
      embedding: [...episode.embedding],
      episodeCount: 1,
      embeddingCount: 1,
      firstActiveAt: episode.createdAt,
      lastActiveAt: episode.createdAt,
      lastEpisodeId: episode.id,
      revision: 1,
    };
  }

  private updateTopic(topic: TopicNode, episode: Episode): TopicNode {
    const count = Math.max(1, topic.embeddingCount ?? topic.episodeCount ?? 1);
    const dimensions = Math.min(topic.embedding.length, episode.embedding.length);
    const centroid = Array.from({ length: dimensions }, (_, index) =>
      (((topic.embedding[index] ?? 0) * count) + (episode.embedding[index] ?? 0)) / (count + 1));
    const magnitude = Math.sqrt(centroid.reduce((sum, value) => sum + value * value, 0));
    const embedding = magnitude > 0 ? centroid.map((value) => value / magnitude) : centroid;
    return {
      ...topic,
      summary: mergeSummary(topic.summary, episode.summary),
      embedding,
      tags: normalizeTags([...(topic.tags ?? []), ...(episode.tags ?? [])]),
      episodeCount: (topic.episodeCount ?? 1) + 1,
      embeddingCount: count + 1,
      firstActiveAt: topic.firstActiveAt ?? topic.createdAt,
      lastActiveAt: episode.createdAt,
      lastEpisodeId: episode.id,
      revision: (topic.revision ?? 1) + 1,
    };
  }
}

function mergeSummary(current: string, addition: string, maxLength = 1200): string {
  const parts = [current.trim(), addition.trim()].filter(Boolean);
  const unique = [...new Set(parts)];
  const merged = unique.join(" ");
  if (merged.length <= maxLength) return merged;
  return `${merged.slice(0, maxLength - 1).trimEnd()}…`;
}

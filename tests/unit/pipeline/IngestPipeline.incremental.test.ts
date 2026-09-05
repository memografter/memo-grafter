import { describe, expect, it } from "vitest";
import { IngestPipeline } from "../../../src/ingestion/conversation/IngestPipeline.js";
import type { GraphStore } from "../../../src/store/index.js";
import type {
  DriftSensitivity,
  EmbedAdapter,
  LLMAdapter,
  MemoryNode,
  MemoryNodeInsert,
  Message,
  SessionIngestState,
  TopicEdge,
  TopicNode,
  TopicSegment,
} from "../../../src/core/types.js";

class FakeLLMAdapter implements LLMAdapter {
  async complete(messages: Message[] = []): Promise<string> {
    const documentMode = messages.at(-1)?.content.includes("document segment") ?? false;
    return JSON.stringify({
      label: "Japan Travel",
      user_intent: "The user is discussing Japan travel preferences.",
      outcome: "The assistant captured useful travel context.",
      open: null,
      memories: [{
        memory_type: "fact",
        subject: "user",
        predicate: "discussed",
        value: "Japan travel preferences.",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        provenance: documentMode
          ? { speaker: "document", message_indexes: [1], extraction_method: "document-extraction" }
          : { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
      }],
    });
  }
}

class FakeEmbedAdapter implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    vector[text.toLowerCase().includes("budget") ? 1 : 0] = 1;
    return vector;
  }
}

class IncrementalStore {
  messages: Message[] = [];
  segments: TopicSegment[] = [];
  nodes: TopicNode[] = [];
  edges: TopicEdge[] = [];
  memories: MemoryNodeInsert[] = [];
  ingestState: SessionIngestState | null = null;
  messageWrites: Array<{ startIndex: number; messages: Message[] }> = [];

  async saveMessages(_sessionId: string, messages: Message[]): Promise<void> {
    this.messages = [...messages];
  }

  async saveMessagesAt(_sessionId: string, startIndex: number, messages: Message[]): Promise<void> {
    this.messageWrites.push({ startIndex, messages: [...messages] });
    for (const [offset, message] of messages.entries()) {
      this.messages[startIndex + offset] = message;
    }
  }

  async appendMessages(_sessionId: string, messages: Message[]): Promise<{ startIndex: number; endIndex: number }> {
    const startIndex = this.messages.length;
    await this.saveMessagesAt(_sessionId, startIndex, messages);
    return { startIndex, endIndex: startIndex + messages.length - 1 };
  }

  async getRecentMessagesBefore(_sessionId: string, beforeIndex: number, limit: number): Promise<Message[]> {
    return this.messages.slice(Math.max(0, beforeIndex - limit), beforeIndex);
  }

  async getMessagesBySession(_sessionId?: string, startIndex = 0, endIndex = this.messages.length - 1): Promise<Message[]> {
    return this.messages
      .slice(startIndex, endIndex + 1)
      .filter((message): message is Message => message !== undefined);
  }

  async clearSession(): Promise<void> {
    this.messages = [];
    this.segments = [];
    this.nodes = [];
    this.edges = [];
    this.memories = [];
    this.ingestState = null;
  }

  async getSessionIngestState(): Promise<SessionIngestState | null> {
    return this.ingestState;
  }

  async updateSessionIngestState(sessionId: string, lastIngestedMessageIndex: number): Promise<void> {
    this.ingestState = {
      sessionId,
      lastIngestedMessageIndex,
      updatedAt: new Date(0),
    };
  }

  async getNodesBySession(): Promise<TopicNode[]> {
    return [...this.nodes];
  }

  async saveSegment(segment: TopicSegment): Promise<TopicSegment> {
    const existing = this.segments.find((candidate) =>
      candidate.sessionId === segment.sessionId
      && candidate.startIndex === segment.startIndex
      && candidate.endIndex === segment.endIndex
    );
    if (existing) return existing;

    this.segments.push(segment);
    return segment;
  }

  async saveSegmentWithNode(
    segment: TopicSegment,
    node: TopicNode,
  ): Promise<{ segment: TopicSegment; node: TopicNode }> {
    const savedSegment = await this.saveSegment(segment);
    const existing = this.nodes.find((candidate) => candidate.segmentId === savedSegment.id);
    const stableNode = { ...node, id: existing?.id ?? node.id, segmentId: savedSegment.id };
    await this.saveNode(stableNode);
    return { segment: savedSegment, node: stableNode };
  }

  async saveNode(node: TopicNode): Promise<void> {
    const index = this.nodes.findIndex((candidate) => candidate.segmentId === node.segmentId);
    if (index >= 0) {
      this.nodes[index] = node;
      return;
    }

    this.nodes.push(node);
  }

  async insertMemories(nodes: MemoryNodeInsert[]): Promise<void> {
    this.memories.push(...nodes);
  }

  async buildMemoryEdges(): Promise<void> {
    return;
  }

  async saveEdge(edge: TopicEdge): Promise<void> {
    const index = this.edges.findIndex((candidate) =>
      candidate.srcId === edge.srcId && candidate.dstId === edge.dstId
    );
    if (index >= 0) {
      this.edges[index] = edge;
      return;
    }

    this.edges.push(edge);
  }

  async getSimilarNodes(_embedding: number[], _sessionId: string, options: { excludeNodeId?: string } = {}): Promise<TopicNode[]> {
    return this.nodes.filter((node) => node.id !== options.excludeNodeId);
  }

  async searchMemories(): Promise<(MemoryNode & { similarity: number })[]> {
    return [];
  }
}

function createPipeline(store: IncrementalStore): IngestPipeline {
  return new IngestPipeline(
    store as unknown as GraphStore,
    new FakeLLMAdapter(),
    new FakeEmbedAdapter(),
    {
      windowSize: 5,
      topK: 3,
      mode: "intent",
      minSegmentMessages: 1,
      driftSensitivity: "medium" satisfies DriftSensitivity,
    },
  );
}

describe("IngestPipeline incremental ingest", () => {
  it("serializes exchange appends and allocates consecutive message indexes", async () => {
    const store = new IncrementalStore();
    const pipeline = createPipeline(store);

    await Promise.all([
      pipeline.append([
        { role: "user", content: "I am planning a Japan trip." },
        { role: "assistant", content: "Which cities interest you?" },
      ], "session-append"),
      pipeline.append([
        { role: "user", content: "Tokyo and Kyoto." },
        { role: "assistant", content: "Both are excellent choices." },
      ], "session-append"),
    ]);

    expect(store.messageWrites.map((write) => write.startIndex)).toEqual([0, 2]);
    expect(store.messages).toHaveLength(4);
    expect(store.ingestState?.lastIngestedMessageIndex).toBe(3);
  });

  it("preserves a failed exchange and recovers it with the next append", async () => {
    const store = new IncrementalStore();
    let extractionAttempts = 0;
    const llm: LLMAdapter = {
      async complete(): Promise<string> {
        extractionAttempts += 1;
        if (extractionAttempts === 1) throw new Error("temporary extraction failure");
        return new FakeLLMAdapter().complete();
      },
    };
    const pipeline = new IngestPipeline(
      store as unknown as GraphStore,
      llm,
      new FakeEmbedAdapter(),
      {
        windowSize: 5,
        topK: 3,
        mode: "intent",
        minSegmentMessages: 1,
        driftSensitivity: "medium",
      },
    );
    const firstPair: Message[] = [
      { role: "user", content: "I am planning a Japan trip." },
      { role: "assistant", content: "Which cities interest you?" },
    ];
    const secondPair: Message[] = [
      { role: "user", content: "My budget is 2500 dollars." },
      { role: "assistant", content: "I can plan around that budget." },
    ];

    await expect(pipeline.append(firstPair, "session-recovery")).rejects.toThrow("temporary extraction failure");

    expect(store.messages).toEqual(firstPair);
    expect(store.segments).toEqual([]);
    expect(store.nodes).toEqual([]);
    expect(store.ingestState).toBeNull();

    await expect(pipeline.append(secondPair, "session-recovery")).resolves.not.toThrow();

    expect(store.messages).toEqual([...firstPair, ...secondPair]);
    expect(store.messageWrites.map((write) => write.startIndex)).toEqual([0, 2]);
    expect(store.ingestState?.lastIngestedMessageIndex).toBe(3);
    expect(store.nodes.length).toBeGreaterThan(0);
  });

  it("does not persist a segment when topic summary embedding fails", async () => {
    const store = new IncrementalStore();
    let embeddingCalls = 0;
    const pipeline = new IngestPipeline(
      store as unknown as GraphStore,
      new FakeLLMAdapter(),
      {
        embed: async () => {
          embeddingCalls += 1;
          if (embeddingCalls === 3) throw new Error("summary embedding unavailable");
          return new Array<number>(1536).fill(0);
        },
      },
      {
        windowSize: 5,
        topK: 3,
        mode: "intent",
        minSegmentMessages: 1,
        driftSensitivity: "medium",
      },
    );

    await expect(pipeline.append([
      { role: "user", content: "I want to switch jobs." },
      { role: "assistant", content: "Let us build a transition plan." },
    ], "session-summary-failure")).rejects.toThrow("summary embedding unavailable");

    expect(store.messages).toHaveLength(2);
    expect(store.segments).toEqual([]);
    expect(store.nodes).toEqual([]);
    expect(store.ingestState).toBeNull();
  });

  it("skips already ingested messages and appends nodes for new messages only", async () => {
    const store = new IncrementalStore();
    const pipeline = createPipeline(store);
    const firstHistory: Message[] = [
      { role: "user", content: "I am planning a Japan trip." },
      { role: "assistant", content: "Response to Japan trip." },
    ];

    const firstNodes = await pipeline.run(firstHistory, "session-1");
    const replayNodes = await pipeline.run(firstHistory, "session-1");
    const secondNodes = await pipeline.run([
      ...firstHistory,
      { role: "user", content: "My Japan budget is around 2500 dollars." },
      { role: "assistant", content: "Response to budget." },
    ], "session-1");

    expect(firstNodes).toHaveLength(1);
    expect(replayNodes).toHaveLength(0);
    expect(secondNodes).toHaveLength(1);
    expect(store.nodes).toHaveLength(2);
    expect(store.segments.map((segment) => [segment.startIndex, segment.endIndex])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(store.ingestState?.lastIngestedMessageIndex).toBe(3);
    expect(store.messageWrites).toEqual([
      { startIndex: 0, messages: firstHistory },
      {
        startIndex: 2,
        messages: [
          { role: "user", content: "My Japan budget is around 2500 dollars." },
          { role: "assistant", content: "Response to budget." },
        ],
      },
    ]);
    expect(store.edges.length).toBeGreaterThan(0);
  });

  it("treats a completed incremental job as a write-free no-op", async () => {
    const store = new IncrementalStore();
    const pipeline = createPipeline(store);
    const pair: Message[] = [
      { role: "user", content: "I am planning a Japan trip." },
      { role: "assistant", content: "Response to Japan trip." },
    ];

    await pipeline.runIncremental(pair, "session-1", 0);
    const writesAfterFirstRun = store.messageWrites.length;
    const nodes = await pipeline.runIncremental(pair, "session-1", 0);

    expect(nodes).toEqual([]);
    expect(store.messageWrites).toHaveLength(writesAfterFirstRun);
    expect(store.nodes).toHaveLength(1);
    expect(store.ingestState?.lastIngestedMessageIndex).toBe(1);
  });

  it("trims the completed prefix of a partially overlapping job", async () => {
    const store = new IncrementalStore();
    const pipeline = createPipeline(store);
    const firstPair: Message[] = [
      { role: "user", content: "I am planning a Japan trip." },
      { role: "assistant", content: "Response to Japan trip." },
    ];
    const secondPair: Message[] = [
      { role: "user", content: "My Japan budget is around 2500 dollars." },
      { role: "assistant", content: "Response to budget." },
    ];

    await pipeline.runIncremental(firstPair, "session-1", 0);
    await pipeline.runIncremental([...firstPair, ...secondPair], "session-1", 0);

    expect(store.messageWrites.at(-1)).toEqual({ startIndex: 2, messages: secondPair });
    expect(store.segments.map((segment) => [segment.startIndex, segment.endIndex])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(store.ingestState?.lastIngestedMessageIndex).toBe(3);
  });

  it("recovers a contiguous persisted gap before processing a later job", async () => {
    const store = new IncrementalStore();
    const pipeline = createPipeline(store);
    const firstPair: Message[] = [
      { role: "user", content: "I am planning a Japan trip." },
      { role: "assistant", content: "Response to Japan trip." },
    ];
    const secondPair: Message[] = [
      { role: "user", content: "My Japan budget is around 2500 dollars." },
      { role: "assistant", content: "Response to budget." },
    ];

    await store.saveMessagesAt("session-1", 0, firstPair);
    store.messageWrites.length = 0;
    const nodes = await pipeline.runIncremental(secondPair, "session-1", 2);

    expect(nodes).toHaveLength(2);
    expect(store.messageWrites).toEqual([{ startIndex: 2, messages: secondPair }]);
    expect(store.segments.map((segment) => [segment.startIndex, segment.endIndex])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(store.ingestState?.lastIngestedMessageIndex).toBe(3);
  });

  it("rejects a later job when its preceding message range is missing", async () => {
    const store = new IncrementalStore();
    const pipeline = createPipeline(store);
    const laterPair: Message[] = [
      { role: "user", content: "My Japan budget is around 2500 dollars." },
      { role: "assistant", content: "Response to budget." },
    ];

    await expect(pipeline.runIncremental(laterPair, "session-1", 2)).rejects.toThrow(
      "MemoGrafter ingestion gap for session session-1",
    );
    expect(store.ingestState).toBeNull();
    expect(store.nodes).toEqual([]);
  });

  it("ingests raw text with label and source metadata, then replaces it", async () => {
    const store = new IncrementalStore();
    const pipeline = createPipeline(store);

    const firstNodes = await pipeline.runText("I prefer quiet cafes for planning.", "session-1", {
      label: "Morning entry",
      source: "classic-editor",
    });

    expect(firstNodes).toHaveLength(1);
    expect(store.messages).toEqual([
      { role: "user", content: "I prefer quiet cafes for planning." },
    ]);
    expect(store.nodes[0]?.source).toBe("classic-editor");
    expect(store.memories[0]?.source).toBe("classic-editor");
    expect(store.memories[0]?.sourceType).toBe("document");

    const replacementNodes = await pipeline.runText("The roadmap now focuses on imports.", "session-1", {
      replace: true,
      source: "import",
    });

    expect(replacementNodes).toHaveLength(1);
    expect(store.messages).toEqual([
      { role: "user", content: "The roadmap now focuses on imports." },
    ]);
    expect(store.nodes).toHaveLength(1);
    expect(store.nodes[0]?.source).toBe("import");
  });

  it("detects multiple topics inside one raw text string", async () => {
    const store = new IncrementalStore();
    const pipeline = createPipeline(store);

    const nodes = await pipeline.runText([
      "I am planning a quiet Japan trip.",
      "I want to visit local cafes.",
      "The project budget is now 2500 dollars.",
      "Budget approval is required before booking.",
    ].join("\n"), "session-1");

    expect(store.messages).toEqual([
      { role: "user", content: "I am planning a quiet Japan trip." },
      { role: "user", content: "I want to visit local cafes." },
      { role: "user", content: "The project budget is now 2500 dollars." },
      { role: "user", content: "Budget approval is required before booking." },
    ]);
    expect(nodes).toHaveLength(2);
    expect(store.segments.map((segment) => [segment.startIndex, segment.endIndex])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});

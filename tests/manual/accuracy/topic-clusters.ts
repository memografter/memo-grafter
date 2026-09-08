/** Provider evaluation against a small labeled fixture set. No database writes.
 * npm run accuracy:clusters -- /absolute/path/to/mg.config.ts
 * Uses that configuration's LLM and embedder (provider calls incur their usual costs).
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { TopicClusterAssigner } from "../../../src/ingestion/clustering/TopicClusterAssigner.js";
import type { TopicCluster, TopicNode, MemoGrafterConfig } from "../../../src/core/types.js";
import type { ClusterDecision, GraphStore } from "../../../src/store/GraphStore.js";

const fixtures = [
  ["Japan Trip", "Planning a two-week holiday in Tokyo and Kyoto.", "Travel"],
  ["Visa Planning", "Preparing documents for a tourist visa for the Japan holiday.", "Travel"],
  ["Flights", "Comparing airline tickets and luggage options for an international holiday.", "Travel"],
  ["Flight Simulator Development", "Building a flight simulator game; debugging its rendering engine.", "Software"],
  ["Database Indexes", "Improving a software application's query performance using database indexes.", "Software"],
  ["Strength Training", "Keeping a regular strength training routine and recording exercise sessions.", "Health"],
  ["Sleep Routine", "Tracking a consistent sleep schedule and sleep quality.", "Health"],
  ["Household Budget", "Organizing household expenses and savings goals.", "Finance"],
  ["Mixed Notes", "Unrelated notes on a work project, a holiday, sleep and household expenses with no main theme.", null],
] as const;
const configPath = process.argv[2];
if (!configPath) throw new Error("Pass a path to an adapter configuration: npm run accuracy:clusters -- /path/to/mg.config.ts");
const imported = (await import(pathToFileURL(resolve(configPath)).href)).default;
const config: MemoGrafterConfig = typeof imported === "function" ? await imported() : imported;
if (!config?.llm || !config?.embedder) throw new Error("The configuration must provide llm and embedder adapters.");
let providerCalls = 0;
let embeddingCalls = 0;
let revision = 0;
const clusters: TopicCluster[] = [];
const nodes = fixtures.map(([label, summary], index): TopicNode => ({
  id: String(index), sessionId: "evaluation", segmentId: String(index), label, summary, embedding: [],
  messageRange: [index, index], topicOrder: index, driftScore: 0, revision: 1,
  agentColor: null, fleetId: null, agentId: null, createdAt: new Date(),
}));
const store = {
  getTopicNode: async (id: string) => nodes.find(node => node.id === id) ?? null,
  getTopicClusterCatalog: async () => ({ clusters: structuredClone(clusters), revision: String(revision) }),
  commitTopicClusterDecision: async (decision: ClusterDecision) => {
    const node = nodes.find(node => node.id === decision.topicId)!;
    if (decision.expectedCatalogRevision !== String(revision) || node.clusterId) return "stale";
    if (decision.cluster && !clusters.some(cluster => cluster.id === decision.cluster!.id)) { clusters.push(decision.cluster); revision++; }
    if (decision.verifiedAlias && decision.cluster) {
      const cluster = clusters.find(item => item.id === decision.cluster!.id)!;
      cluster.aliases = [...new Set([...(cluster.aliases ?? []), decision.verifiedAlias])]; revision++;
    }
    node.clusterId = decision.cluster?.id ?? null; node.clusterAssignment = decision.assignment;
    return "saved";
  },
} as unknown as GraphStore;
const assigner = new TopicClusterAssigner(store,
  { complete: (...args) => { providerCalls++; return config.llm.complete(...args); } },
  { ...(config.embedder.dimensions !== undefined ? { dimensions: config.embedder.dimensions } : {}),
    embed: (...args) => { embeddingCalls++; return config.embedder.embed(...args); } },
  { ...config.clustering, enabled: true });
const durations: number[] = [];
let warningCount = 0;
for (const node of nodes) {
  const started = performance.now();
  warningCount += (await assigner.classify([node])).length;
  durations.push(performance.now() - started);
}
let correctPairs = 0; let predictedPairs = 0; let expectedPairs = 0;
for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
  const expected = fixtures[a]![2] !== null && fixtures[a]![2] === fixtures[b]![2];
  const predicted = Boolean(nodes[a]!.clusterId) && nodes[a]!.clusterId === nodes[b]!.clusterId;
  if (expected) expectedPairs++;
  if (predicted) predictedPairs++;
  if (expected && predicted) correctPairs++;
}
const expectedDomains = [...new Set(fixtures.map(fixture => fixture[2]).filter(Boolean))];
const extraClusters = expectedDomains.reduce((sum, domain) => sum + Math.max(0, new Set(nodes.filter((_node, i) => fixtures[i]![2] === domain)
  .map(node => node.clusterId).filter(Boolean)).size - 1), 0);
const sorted = [...durations].sort((a, b) => a - b);
console.log(JSON.stringify({
  rows: nodes.map((node, i) => ({ topic: node.label, expected: fixtures[i]![2], assigned: clusters.find(cluster => cluster.id === node.clusterId)?.label ?? null })),
  pairPrecision: predictedPairs ? correctPairs / predictedPairs : null, pairRecall: expectedPairs ? correctPairs / expectedPairs : null,
  extraClustersWithinExpectedDomains: extraClusters,
  unassignedRate: nodes.filter(node => !node.clusterId).length / nodes.length,
  ambiguousFixtureAssigned: Boolean(nodes.at(-1)!.clusterId), providerCalls, embeddingCalls,
  providerCallsPerTopic: providerCalls / nodes.length, classificationP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], warningCount,
}, null, 2));

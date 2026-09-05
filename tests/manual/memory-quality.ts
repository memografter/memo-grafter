/** Live manual test: npm run manual:memory-quality. Requires DATABASE_URL and OPENAI_API_KEY. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  MemoGrafter, OpenAIEmbedAdapter, OpenAILLMAdapter, computePersistenceScore,
  type LLMAdapter, type MemoryNode, type Message, type TopicNode,
} from "../../src/index.js";
import { QUALITY_DIMENSIONS } from "../../src/utils/memoryQuality.js";

// Entirely fictional fixtures authored for this test. The travel plans, dietary history,
// team size, billing volume and business constraints do not describe the user or any real company.
// Only these literals and generated assistant replies are sent to the LLM; no private documents,
// existing database memories or application messages are loaded into the conversation.
const questions = [
  {
    title: "Japan work assignment with personal constraints",
    question: "I have just accepted my company's offer to spend two weeks in Japan in November. I'll land at Haneda on a Sunday and the current plan is to work in our Shinagawa office in Tokyo from 9 am to 6 pm on weekdays, with both weekends free. My employer covers flights and weekday accommodation, but I have a personal budget of 45,000 yen for sightseeing, local travel and weekend food. I've been vegetarian for eight years and don't eat fish or fish-based broth. I enjoy photography, quiet gardens and independent bookstores more than nightlife, and I prefer not to change hotels frequently. Could you suggest a realistic way to use the evenings and weekends, including whether one overnight trip outside Tokyo is worth the cost? I haven't booked any weekend travel yet.",
    review: "Look for durable dietary/interests/preferences separately from the temporary two-week assignment and budget. Suggested destinations in the assistant response are not user decisions.",
  },
  {
    title: "Confirmed schedule correction and an undecided side trip",
    question: "Actually, my manager has now confirmed that I will work in Tokyo only during the first week and transfer to our Osaka office for the second week; the company will pay for that transfer and change my return flight to depart from Kansai. My 45,000-yen personal budget stays the same. A friend might meet me in Kyoto on the second Saturday, but she hasn't confirmed and I haven't decided whether to go. I also need to attend a client call from the hotel at 8 pm on the first Saturday, so an overnight trip that weekend would be awkward. Could you revise the plan around this change and compare a Kyoto day trip with staying in Osaka, without assuming my friend will join? Please keep the vegetarian requirement and my preference for a slower pace in mind.",
    review: "Inspect how the confirmed Tokyo-to-Osaka correction relates to earlier memories. Kyoto and the friend's attendance should remain tentative; the client call is temporary but useful.",
  },
  {
    title: "A separate engineering decision with a provisional experiment",
    question: "A separate work issue before I leave: I lead a six-person team maintaining a Node.js and TypeScript billing service. PostgreSQL is our source of truth, and our firm requirements are that retrying a payment request must never create a second charge, every state change must remain auditable, and raw card details must never enter our application logs. We currently process about 20,000 invoices a month. I'm considering a two-week Redis caching experiment to reduce dashboard latency, but we haven't approved it and I don't want a cache to become authoritative for payment state. I'd like to review the experiment's latency and error-rate results with the team next Friday. How would you split the design into permanent correctness guarantees and a reversible performance experiment, and what should we measure before deciding whether to keep Redis?",
    review: "Look for permanent billing constraints with high stability/salience, distinct from current volume, a near-term review task and an unapproved Redis experiment. Assistant implementation suggestions should not become approved architecture.",
  },
];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Add it to the root .env file.`);
  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
requireEnv("OPENAI_API_KEY");
const model = process.env.MEMORY_QUALITY_MODEL?.trim() || "gpt-4o-mini";
const embeddingModel = "text-embedding-3-small";
const sessionId = `manual-memory-quality-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const reportDirectory = fileURLToPath(new URL("./reports/memory-quality/", import.meta.url));
const markdownPath = join(reportDirectory, `${sessionId}.md`);
const jsonPath = join(reportDirectory, `${sessionId}.json`);
const transcript: Message[] = [];
const extractionResponses: Array<{ exchange: number; response: string }> = [];
const diagnostics: Array<{ exchange: number; code: string; context: unknown }> = [];
let exchange = 0;
let ingestionCompletions = 0;
const liveLlm = new OpenAILLMAdapter(model);
const ingestionLlm: LLMAdapter = {
  async complete(messages, system, options) {
    ingestionCompletions++;
    const response = await liveLlm.complete(messages, system, options);
    if (messages.some(message => message.content.includes("Conversation segment:"))) {
      extractionResponses.push({ exchange, response });
    }
    return response;
  },
};

const memo = new MemoGrafter({
  db: { connectionString: databaseUrl },
  llm: ingestionLlm,
  embedder: new OpenAIEmbedAdapter(embeddingModel),
  drift: { mode: "intent", minSegmentMessages: 1 },
  diagnostics: { onWarning: warning => diagnostics.push({ exchange, code: warning.code, context: warning.context }) },
});

function memoryView(memory: MemoryNode) {
  return {
    id: memory.id, topicNodeId: memory.topicNodeId, memoryType: memory.memoryType,
    subject: memory.subject, predicate: memory.predicate, value: memory.value,
    quality: memory.quality, qualityDefaulted: memory.qualityDefaulted,
    qualityOrigin: memory.qualityOrigin, persistenceScore: computePersistenceScore(memory.quality),
    provenance: memory.provenance, supersededBy: memory.supersededBy,
    hasConflict: memory.hasConflict, decayed: memory.decayed, forgotten: memory.forgotten,
    reinforcementCount: memory.reinforcementCount,
  };
}
function topicView(topic: TopicNode) {
  return { id: topic.id, label: topic.label, summary: topic.summary, messageRange: topic.messageRange, topicOrder: topic.topicOrder };
}
type Snapshot = {
  exchange: number; title: string; question: string; answer: string; review: string;
  newTopicIds: string[]; newMemoryIds: string[]; updatedMemoryIds: string[];
  topics: ReturnType<typeof topicView>[]; memories: ReturnType<typeof memoryView>[];
};
const snapshots: Snapshot[] = [];
const checks: Array<{ name: string; passed: boolean }> = [];
let failure: string | undefined;

function cell(value: unknown): string {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}
function score(value: number | undefined): string { return typeof value === "number" ? value.toFixed(3) : "missing"; }

async function saveReport(): Promise<void> {
  const lines = [
    "# Live memory quality ingestion report", "",
    `Session: ${sessionId}`, `LLM: ${model}; embeddings: ${embeddingModel}`, "",
    "Three synthetic user questions; assistant replies, extraction, embeddings, topics and quality assignments are live. No quality scores are supplied by the test.", "",
    "The database session is retained for inspection in Studio. Each exchange below includes a complete graph snapshot; new and updated IDs distinguish ingestion effects.", "",
    "Quality describes the memory itself. Persistence is derived separately for retention; no retrieval query or relevance score is involved.", "",
    ...checks.map(check => `- ${check.passed ? "PASS" : "FAIL"}: ${check.name}`), "",
    ...(failure ? [`Run failure: ${failure}`, ""] : []),
  ];
  for (const snapshot of snapshots) {
    lines.push(`## Exchange ${snapshot.exchange}: ${snapshot.title}`, "", "### User", "", snapshot.question, "", "### Live LLM response", "", snapshot.answer, "",
      `New topics: ${snapshot.newTopicIds.length}; new memories: ${snapshot.newMemoryIds.length}; updated memories: ${snapshot.updatedMemoryIds.length}.`, "",
      `**Semantic review:** ${snapshot.review}`, "");
    for (const topic of snapshot.topics) {
      lines.push(`### ${topic.label}${snapshot.newTopicIds.includes(topic.id) ? " (new topic)" : ""}`, "", `ID: ${topic.id}; message range: ${topic.messageRange.join("–")} (zero-based).`, "", topic.summary, "",
        "| Memory ID / change | Type | Subject → predicate → value | Explicitness | Source reliability | Stability | Salience | Persistence | Defaulted | State |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
      const children = snapshot.memories.filter(memory => memory.topicNodeId === topic.id);
      for (const memory of children) {
        const change = snapshot.newMemoryIds.includes(memory.id) ? "new" : snapshot.updatedMemoryIds.includes(memory.id) ? "updated" : "existing";
        const state = memory.supersededBy ? `superseded by ${memory.supersededBy}` : memory.hasConflict ? "conflicting" : "active";
        lines.push(`| ${memory.id} / ${change} | ${memory.memoryType} | ${cell(`${memory.subject} → ${memory.predicate} → ${memory.value}`)} | ${score(memory.quality?.explicitness)} | ${score(memory.quality?.sourceReliability)} | ${score(memory.quality?.stability)} | ${score(memory.quality?.salience)} | ${score(memory.persistenceScore)} | ${cell(memory.qualityDefaulted?.join(", ") || "none")} | ${cell(state)} |`);
      }
      lines.push("", "Evidence:", "");
      for (const memory of children) {
        lines.push(`- ${memory.id}: ${cell(memory.provenance?.speaker)}; ${cell(memory.provenance?.extractionMethod)}; message indexes ${cell(memory.provenance?.messageIndexes.join(", "))}.`);
      }
      lines.push("");
    }
  }
  lines.push("## Interpretation", "",
    "Scores and exact extraction counts are nondeterministic. Passing checks establishes graph creation, complete bounded scores and user-message provenance; it does not certify semantic correctness. Review whether memories preserve uncertainty, distinguish temporary plans from enduring constraints, and avoid turning assistant suggestions into user commitments.", "",
    "The JSON report includes unrounded scores, complete snapshots, diagnostics and raw extraction responses, so defaults can be distinguished from model-assigned values.", "");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(markdownPath, lines.join("\n"), "utf8");
  await writeFile(jsonPath, JSON.stringify({ sessionId, model, embeddingModel, ingestionCompletions, checks, failure, transcript, snapshots, diagnostics, extractionResponses }, null, 2), "utf8");
}

console.log(`Live memory quality test\nSession: ${sessionId}\nModel: ${model}\n`);
try {
  // Normal additive migration; writes below use only this run's unique session.
  await memo.store.migrate();
  await memo.initialize();
  for (const scenario of questions) {
    exchange++;
    const beforeTopics = new Set((await memo.store.getNodesBySession(sessionId)).map(topic => topic.id));
    const beforeMemories = new Map((await memo.store.getMemoriesBySession(sessionId)).map(memory => [memory.id, JSON.stringify(memoryView(memory))]));
    console.log(`Exchange ${exchange}/3: ${scenario.title}\nUSER: ${scenario.question}\nGenerating assistant response...`);
    transcript.push({ role: "user", content: scenario.question });
    const answer = await liveLlm.complete(transcript, "Respond helpfully to this fictional conversation in at most 220 words. Clearly distinguish the user's confirmed facts from your suggestions and unconfirmed possibilities. Do not invent bookings, approvals, or current prices. Answer the question naturally; do not discuss memory extraction or assign scores.");
    assert.ok(answer.trim(), "The live LLM returned an empty assistant response");
    transcript.push({ role: "assistant", content: answer });
    console.log(`ASSISTANT: ${answer}\nIngesting the completed exchange...`);
    await memo.analyzeDetailed({ sessionId, userMessage: scenario.question, assistantMessage: answer });
    const [topics, memories] = await Promise.all([memo.store.getNodesBySession(sessionId), memo.store.getMemoriesBySession(sessionId)]);
    const snapshot: Snapshot = {
      exchange, ...scenario, answer,
      newTopicIds: topics.filter(topic => !beforeTopics.has(topic.id)).map(topic => topic.id),
      newMemoryIds: memories.filter(memory => !beforeMemories.has(memory.id)).map(memory => memory.id),
      updatedMemoryIds: memories.filter(memory => beforeMemories.has(memory.id) && beforeMemories.get(memory.id) !== JSON.stringify(memoryView(memory))).map(memory => memory.id),
      topics: topics.map(topicView), memories: memories.map(memoryView),
    };
    snapshots.push(snapshot);
    checks.push(
      { name: `Exchange ${exchange} created topics`, passed: snapshot.newTopicIds.length > 0 },
      { name: `Exchange ${exchange} created memories`, passed: snapshot.newMemoryIds.length > 0 },
      { name: `Exchange ${exchange}: every memory has four finite scores in [0, 1]`, passed: memories.every(memory => QUALITY_DIMENSIONS.every(key => typeof memory.quality?.[key] === "number" && Number.isFinite(memory.quality[key]) && memory.quality[key] >= 0 && memory.quality[key] <= 1)) },
      { name: `Exchange ${exchange}: scores were assigned by extraction without defaults`, passed: memories.every(memory => memory.qualityOrigin === "extracted" && memory.qualityDefaulted?.length === 0) },
      { name: `Exchange ${exchange}: provenance points to user messages`, passed: memories.every(memory => memory.provenance?.speaker === "user" && memory.provenance.messageIndexes.length > 0 && memory.provenance.messageIndexes.every(index => transcript[index]?.role === "user")) },
      { name: `Exchange ${exchange}: public memories contain no confidence field`, passed: memories.every(memory => !("confidence" in memory)) },
    );
    console.table(snapshot.topics.map(topic => ({ topic: topic.label, id: topic.id, new: snapshot.newTopicIds.includes(topic.id), summary: topic.summary })));
    console.table(snapshot.memories.map(memory => ({ id: memory.id, topic: topics.find(topic => topic.id === memory.topicNodeId)?.label, value: memory.value, ...memory.quality, defaulted: memory.qualityDefaulted?.join(", ") || "none", superseded: !!memory.supersededBy, conflict: memory.hasConflict })));
    await saveReport();
    console.log(`Saved exchange ${exchange} snapshot.\n`);
  }
  assert.ok(extractionResponses.length > 0, "No live extraction responses were captured");
  assert.ok(checks.every(check => check.passed), `Checks failed: ${checks.filter(check => !check.passed).map(check => check.name).join("; ")}`);
  console.log("PASS: live ingestion created topics and memories with complete quality scores. Review the report for semantic accuracy.");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(failure);
} finally {
  try { await saveReport(); }
  finally { await memo.close(); }
  console.log(`\nReport: ${markdownPath}\nRaw data: ${jsonPath}\nSession retained in PostgreSQL: ${sessionId}`);
}

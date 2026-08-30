import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";
import {
  MemoGrafterAgent,
  OpenAIEmbedAdapter,
  OpenAILLMAdapter,
  type InjectionResult,
  type RetrievalResult,
} from "../../src/index.js";

interface LoCoMoConversation {
  conversation_id?: string;
  conversationId?: string;
  id?: string;
  sample_id?: string;
  sessions?: LoCoMoSession[];
  conversation?: LoCoMoConversationBlock;
  qa?: LoCoMoQAPair[];
  qa_pairs?: LoCoMoQAPair[];
}

interface LoCoMoConversationBlock {
  speaker_a?: string;
  speaker_b?: string;
  [key: string]: unknown;
}

interface LoCoMoSession {
  session_id?: string | number;
  sessionId?: string | number;
  dateTime?: string;
  conversation?: LoCoMoTurn[];
  turns?: LoCoMoTurn[];
}

interface LoCoMoTurn {
  role?: string;
  speaker?: string;
  dia_id?: string;
  content?: string;
  text?: string;
}

interface LoCoMoQAPair {
  question?: string;
  answer?: string;
  category?: string | number;
}

interface CliOptions {
  conversations?: number;
  resume: boolean;
  dataDir: string;
  output: string;
  delayMs: number;
}

interface ConversationResult {
  conversationId: string;
  sessionCount: number;
  turnCount: number;
  qaCount: number;
  results: QAResult[];
}

interface QAResult {
  question: string;
  groundTruth: string;
  category: string;
  baseline: ModeResult;
  recall: ModeResult;
  graft: ModeResult;
}

interface ModeResult {
  answer: string;
  f1: number;
  exactMatch: boolean;
  recallMiss?: boolean;
  graftMiss?: boolean;
}

type ModeName = "baseline" | "recall" | "graft";
type NormalizedRole = "user" | "assistant";

const baselineSystemPrompt =
  "You are a helpful assistant. Answer the question as accurately as possible based on your knowledge.";
let openai: OpenAI;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    resume: false,
    dataDir: "./locomo-data",
    output: "./locomo-results.json",
    delayMs: 2000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];

    if (flag === "--resume") {
      options.resume = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }

    if (flag === "--conversations") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--conversations must be a positive integer.");
      }
      options.conversations = parsed;
      i += 1;
      continue;
    }

    if (flag === "--data-dir") {
      options.dataDir = value;
      i += 1;
      continue;
    }

    if (flag === "--output") {
      options.output = value;
      i += 1;
      continue;
    }

    if (flag === "--delay-ms") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--delay-ms must be a non-negative integer.");
      }
      options.delayMs = parsed;
      i += 1;
      continue;
    }

    throw new Error(`Unknown CLI flag: ${flag}`);
  }

  return options;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Set it before running the LoCoMo benchmark.`);
  }
  return value;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findDatasetPath(dataDir: string): Promise<string> {
  const candidates = [
    path.join(dataDir, "data", "locomo10.json"),
    path.join(dataDir, "locomo10.json"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find LoCoMo dataset. Expected one of:\n${candidates
      .map((candidate) => `  - ${candidate}`)
      .join("\n")}`,
  );
}

async function loadDataset(dataDir: string): Promise<LoCoMoConversation[]> {
  const datasetPath = await findDatasetPath(dataDir);
  const raw = await fs.readFile(datasetPath, "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${datasetPath} to contain a top-level array.`);
  }

  if (parsed.length === 0) {
    throw new Error(`Dataset ${datasetPath} is empty.`);
  }

  console.error(`Loaded LoCoMo dataset: ${datasetPath}`);
  console.error(`First conversation top-level keys: ${Object.keys(parsed[0] as object).join(", ")}`);
  return parsed as LoCoMoConversation[];
}

function getConversationId(conversation: LoCoMoConversation, index: number): string {
  return (
    conversation.conversation_id ??
    conversation.conversationId ??
    conversation.id ??
    conversation.sample_id ??
    `conversation_${index + 1}`
  );
}

function getSessions(conversation: LoCoMoConversation): LoCoMoSession[] {
  if (Array.isArray(conversation.sessions)) {
    return conversation.sessions;
  }

  const conversationBlock = conversation.conversation;
  if (!conversationBlock) {
    return [];
  }

  return Object.keys(conversationBlock)
    .map((key) => {
      const match = /^session_(\d+)$/.exec(key);
      return match ? { key, order: Number.parseInt(match[1] ?? "0", 10) } : null;
    })
    .filter((sessionKey): sessionKey is { key: string; order: number } => sessionKey !== null)
    .sort((a, b) => a.order - b.order)
    .map(({ key, order }) => {
      const turns = conversationBlock[key];
      const dateTime = conversationBlock[`session_${order}_date_time`];
      const session: LoCoMoSession = {
        session_id: order,
        turns: Array.isArray(turns) ? (turns as LoCoMoTurn[]) : [],
      };

      if (typeof dateTime === "string") {
        session.dateTime = dateTime;
      }

      return session;
    });
}

function getSessionTurns(session: LoCoMoSession): LoCoMoTurn[] {
  if (Array.isArray(session.conversation)) {
    return session.conversation;
  }

  if (Array.isArray(session.turns)) {
    return session.turns;
  }

  return [];
}

function getQAPairs(conversation: LoCoMoConversation): LoCoMoQAPair[] {
  if (Array.isArray(conversation.qa)) {
    return conversation.qa;
  }

  if (Array.isArray(conversation.qa_pairs)) {
    return conversation.qa_pairs;
  }

  return [];
}

function getTurnText(turn: LoCoMoTurn): string {
  return turn.content ?? turn.text ?? "";
}

function normalizeTurnRole(turn: LoCoMoTurn, speakerRoleMap: Map<string, NormalizedRole>): NormalizedRole {
  const rawRole = (turn.role ?? turn.speaker ?? "").toLowerCase().trim();
  if (rawRole === "assistant" || rawRole === "agent" || rawRole === "bot") {
    return "assistant";
  }

  if (rawRole === "user" || rawRole === "human") {
    return "user";
  }

  if (!rawRole) {
    return "user";
  }

  const mappedRole = speakerRoleMap.get(rawRole);
  if (mappedRole) {
    return mappedRole;
  }

  const role = speakerRoleMap.size === 0 ? "user" : "assistant";
  speakerRoleMap.set(rawRole, role);
  return role;
}

function normalizeCategory(category: string | number | undefined): string {
  const categoryMap: Record<string, string> = {
    "1": "single_hop",
    "2": "temporal",
    "3": "open_domain",
    "4": "multi_hop",
    "5": "adversarial",
  };
  const rawCategory = String(category ?? "unknown").trim();
  const mappedCategory = categoryMap[rawCategory] ?? rawCategory;

  return mappedCategory
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .replace(/[^\w]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function normaliseAnswer(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function tokenF1(predicted: string, ground: string): number {
  const p = normaliseAnswer(predicted).split(" ").filter(Boolean);
  const g = normaliseAnswer(ground).split(" ").filter(Boolean);

  if (p.length === 0 || g.length === 0) {
    return p.length === g.length ? 1 : 0;
  }

  const predictedCounts = tokenCounts(p);
  const groundCounts = tokenCounts(g);
  let overlap = 0;

  for (const [token, predictedCount] of predictedCounts) {
    overlap += Math.min(predictedCount, groundCounts.get(token) ?? 0);
  }

  if (overlap === 0) {
    return 0;
  }

  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

function exactMatch(predicted: string, ground: string): boolean {
  return normaliseAnswer(predicted) === normaliseAnswer(ground);
}

function scoreAnswer(answer: string, groundTruth: string): ModeResult {
  return {
    answer,
    f1: tokenF1(answer, groundTruth),
    exactMatch: exactMatch(answer, groundTruth),
  };
}

function zeroResult(extra?: Pick<ModeResult, "recallMiss" | "graftMiss">): ModeResult {
  return {
    answer: "",
    f1: 0,
    exactMatch: false,
    ...extra,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function generateAnswerOnce(systemPrompt: string, question: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature: 0,
    max_tokens: 200,
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}

async function generateAnswer(systemPrompt: string, question: string): Promise<string> {
  try {
    return await generateAnswerOnce(systemPrompt, question);
  } catch (error) {
    console.error(`generateAnswer failed. Retrying once in 5 seconds.`, error);
    await sleep(5000);
    return generateAnswerOnce(systemPrompt, question);
  }
}

async function answerAndScore(systemPrompt: string, question: string, groundTruth: string): Promise<ModeResult> {
  try {
    const answer = await generateAnswer(systemPrompt, question);
    return scoreAnswer(answer, groundTruth);
  } catch (error) {
    console.error(`generateAnswer failed after retry. Recording zero-score result.`, error);
    return zeroResult();
  }
}

async function writeResults(outputPath: string, results: ConversationResult[]): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
}

async function loadExistingResults(outputPath: string): Promise<ConversationResult[]> {
  if (!(await pathExists(outputPath))) {
    return [];
  }

  const raw = await fs.readFile(outputPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected existing results file ${outputPath} to contain an array.`);
  }

  return parsed as ConversationResult[];
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageF1(results: QAResult[], mode: ModeName): number {
  return mean(results.map((result) => result[mode].f1));
}

function collectQAResults(results: ConversationResult[]): QAResult[] {
  return results.flatMap((conversation) => conversation.results);
}

function formatNumber(value: number): string {
  return value.toFixed(3);
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "0.0%";
  }

  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function modeAverage(results: QAResult[], mode: ModeName, metric: "f1" | "exactMatch"): number {
  if (metric === "f1") {
    return averageF1(results, mode);
  }

  return mean(results.map((result) => (result[mode].exactMatch ? 1 : 0)));
}

function printRow(label: string, baseline: number, recall: number, graft: number): void {
  console.log(
    `${label.padEnd(20)}${formatNumber(baseline).padStart(10)}${formatNumber(recall).padStart(12)}${formatNumber(
      graft,
    ).padStart(11)}`,
  );
}

function printSummary(results: ConversationResult[], outputPath: string): void {
  const allQA = collectQAResults(results);
  const categories = [...new Set(allQA.map((result) => result.category))].sort();
  const recallMisses = allQA.filter((result) => result.recall.recallMiss).length;
  const graftMisses = allQA.filter((result) => result.graft.graftMiss).length;

  console.log("=====================================================");
  console.log("LoCoMo QA Benchmark - MemoGrafter Results");
  console.log("=====================================================");
  console.log(`Conversations evaluated : ${results.length}`);
  console.log(`Total QA pairs          : ${allQA.length}`);
  console.log("");
  console.log("                    Baseline    recall()    graft()");
  console.log("-----------------------------------------------------");
  printRow(
    "Overall F1",
    modeAverage(allQA, "baseline", "f1"),
    modeAverage(allQA, "recall", "f1"),
    modeAverage(allQA, "graft", "f1"),
  );
  printRow(
    "Overall EM",
    modeAverage(allQA, "baseline", "exactMatch"),
    modeAverage(allQA, "recall", "exactMatch"),
    modeAverage(allQA, "graft", "exactMatch"),
  );
  console.log("");
  console.log("Per-category F1:");
  for (const category of categories) {
    const byCategory = allQA.filter((result) => result.category === category);
    printRow(
      `  ${category}`,
      modeAverage(byCategory, "baseline", "f1"),
      modeAverage(byCategory, "recall", "f1"),
      modeAverage(byCategory, "graft", "f1"),
    );
  }
  console.log("");
  console.log("Per-category EM:");
  for (const category of categories) {
    const byCategory = allQA.filter((result) => result.category === category);
    printRow(
      `  ${category}`,
      modeAverage(byCategory, "baseline", "exactMatch"),
      modeAverage(byCategory, "recall", "exactMatch"),
      modeAverage(byCategory, "graft", "exactMatch"),
    );
  }
  console.log("");
  console.log(`Recall misses (recall mode)  : ${recallMisses} / ${allQA.length} (${formatPercent(recallMisses, allQA.length)})`);
  console.log(`Graft misses  (graft mode)   : ${graftMisses} / ${allQA.length} (${formatPercent(graftMisses, allQA.length)})`);
  console.log("");
  console.log(`Full results saved to: ${outputPath}`);
  console.log("=====================================================");
}

async function ingestConversation(
  agent: MemoGrafterAgent,
  conversationId: string,
  sessions: LoCoMoSession[],
): Promise<number> {
  let turnIndex = 0;
  let ingestedTurns = 0;
  const speakerRoleMap = new Map<string, NormalizedRole>();

  for (const session of sessions) {
    let shouldAttachSessionDate = typeof session.dateTime === "string" && session.dateTime.trim().length > 0;

    for (const turn of getSessionTurns(session)) {
      let text = getTurnText(turn).trim();
      if (!text || normalizeTurnRole(turn, speakerRoleMap) !== "user") {
        turnIndex += 1;
        continue;
      }

      if (shouldAttachSessionDate) {
        text = `Session ${String(session.session_id ?? "")} date/time: ${session.dateTime}\n${text}`;
        shouldAttachSessionDate = false;
      }

      try {
        await agent.invoke(text);
        ingestedTurns += 1;
      } catch (error) {
        console.error(`${conversationId} - invoke failed for turn ${turnIndex}. Skipping turn.`, error);
      }

      turnIndex += 1;
    }
  }

  return ingestedTurns;
}

async function evaluateRecall(
  agent: MemoGrafterAgent,
  question: string,
  groundTruth: string,
): Promise<ModeResult> {
  let recallResult: RetrievalResult;

  try {
    recallResult = await agent.recall(question, { minSimilarity: 0.3, limit: 10, tokenBudget: 1500 });
  } catch (error) {
    console.error(`recall() failed. Recording recall miss.`, error);
    return zeroResult({ recallMiss: true });
  }

  if (recallResult.facts.length === 0) {
    const result = await answerAndScore(baselineSystemPrompt, question, groundTruth);
    return { ...result, recallMiss: true };
  }

  return answerAndScore(recallResult.systemPrompt, question, groundTruth);
}

async function evaluateGraft(
  graftResult: InjectionResult | null,
  graftFailed: boolean,
  question: string,
  groundTruth: string,
): Promise<ModeResult> {
  if (graftFailed) {
    return zeroResult({ graftMiss: true });
  }

  const systemPrompt = graftResult?.systemPrompt.trim() ?? "";
  if (!systemPrompt) {
    const result = await answerAndScore(baselineSystemPrompt, question, groundTruth);
    return { ...result, graftMiss: true };
  }

  return answerAndScore(systemPrompt, question, groundTruth);
}

async function evaluateConversation(
  conversation: LoCoMoConversation,
  conversationIndex: number,
  totalConversations: number,
  databaseUrl: string,
): Promise<ConversationResult> {
  const conversationId = getConversationId(conversation, conversationIndex);
  const sessions = getSessions(conversation);
  const qaPairs = getQAPairs(conversation);
  const turnCount = sessions.reduce((sum, session) => sum + getSessionTurns(session).length, 0);

  console.error(`[${conversationIndex + 1}/${totalConversations}] ${conversationId} - ingesting ${sessions.length} sessions (${turnCount} turns)...`);

  const agent = new MemoGrafterAgent({
    db: { connectionString: databaseUrl },
    llm: new OpenAILLMAdapter("gpt-4o-mini"),
    embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
    systemPrompt: "You are a helpful assistant.",
  });

  const results: QAResult[] = [];
  let graftResult: InjectionResult | null = null;
  let graftFailed = false;

  try {
    await agent.initialize();
    await ingestConversation(agent, conversationId, sessions);

    // invoke() schedules memory graph work through a background promise; this gives
    // queued ingestion a short moment to settle before recall/graft benchmarking.
    await sleep(1000);

    try {
      graftResult = await agent.graft();
    } catch (error) {
      graftFailed = true;
      console.error(`${conversationId} - graft() failed. Graft mode will be zero-scored for this conversation.`, error);
    }

    console.error(`[${conversationIndex + 1}/${totalConversations}] ${conversationId} - ingesting complete. Running ${qaPairs.length} QA pairs...`);

    for (const qa of qaPairs) {
      const question = (qa.question ?? "").trim();
      const groundTruth = (qa.answer ?? "").trim();
      const category = normalizeCategory(qa.category);

      if (!question) {
        continue;
      }

      const baseline = await answerAndScore(baselineSystemPrompt, question, groundTruth);
      const recall = await evaluateRecall(agent, question, groundTruth);
      const graft = await evaluateGraft(graftResult, graftFailed, question, groundTruth);

      results.push({
        question,
        groundTruth,
        category,
        baseline,
        recall,
        graft,
      });
    }

    console.error(
      `[${conversationIndex + 1}/${totalConversations}] ${conversationId} - done. F1: baseline=${averageF1(results, "baseline").toFixed(
        2,
      )} recall=${averageF1(results, "recall").toFixed(2)} graft=${averageF1(results, "graft").toFixed(2)}`,
    );
  } finally {
    await agent.close();
  }

  return {
    conversationId,
    sessionCount: sessions.length,
    turnCount,
    qaCount: results.length,
    results,
  };
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const openAIApiKey = requireEnv("OPENAI_API_KEY");
  openai = new OpenAI({ apiKey: openAIApiKey });

  const options = parseArgs(process.argv.slice(2));
  const dataset = await loadDataset(options.dataDir);
  const selectedDataset = dataset.slice(0, options.conversations ?? dataset.length);
  const outputPath = options.output;
  const results = options.resume ? await loadExistingResults(outputPath) : [];
  const completedIds = new Set(results.map((result) => result.conversationId));

  for (let index = 0; index < selectedDataset.length; index += 1) {
    const conversation = selectedDataset[index];
    if (!conversation) {
      continue;
    }

    const conversationId = getConversationId(conversation, index);
    if (options.resume && completedIds.has(conversationId)) {
      console.error(`[${index + 1}/${selectedDataset.length}] ${conversationId} - already present in ${outputPath}; skipping.`);
      continue;
    }

    try {
      const result = await evaluateConversation(conversation, index, selectedDataset.length, databaseUrl);
      results.push(result);
      completedIds.add(result.conversationId);
      await writeResults(outputPath, results);
    } catch (error) {
      console.error(`${conversationId} - conversation failed. Continuing with next conversation.`, error);
    }

    if (index < selectedDataset.length - 1 && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  printSummary(results, outputPath);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

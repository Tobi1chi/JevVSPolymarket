import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

type BackgroundMode = "bare" | "generic" | "sports_prior" | "calibrated";

const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const SPORTS_TAG_ID = process.env.POLYMARKET_SPORTS_TAG_ID ?? "100639";
const TARGET_COUNT = Number(process.env.JEV_BATCH_COUNT ?? "100");
const PAGE_SIZE = 100;
const MAX_PAGES = Number(process.env.JEV_BATCH_MAX_PAGES ?? "20");
const MIN_VOLUME = Number(process.env.JEV_BATCH_MIN_VOLUME ?? "50");
const CONCURRENCY = Math.max(1, Number(process.env.JEV_BATCH_CONCURRENCY ?? "5"));
const PRE_EVENT_LEAD_SECONDS = Number(process.env.JEV_BATCH_PRE_EVENT_LEAD_SECONDS ?? "3600");
const REPEAT_COUNT = Math.max(1, Math.floor(Number(process.env.JEV_BATCH_REPEATS ?? "1")) || 1);
const SUPPORTED_BACKGROUND_MODES: BackgroundMode[] = [
  "bare",
  "generic",
  "sports_prior",
  "calibrated",
];
const BACKGROUND_MODES = parseBackgroundModes(process.env.JEV_BATCH_BACKGROUND_MODES);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const resultsPath = resolve("data/jev-batch-" + runId + ".jsonl");
const summaryPath = resolve("data/jev-batch-" + runId + "-summary.json");

type GammaMarket = {
  question: string;
  slug: string;
  description: string;
  outcomes: string | string[];
  outcomePrices: string | string[];
  clobTokenIds?: string | string[];
  startDate?: string;
  endDate?: string;
  volume?: string | number;
  closed?: boolean;
};

type Candidate = {
  market: GammaMarket;
  outcomes: [string, string];
  finalPrices: [number, number];
  actualIndex: 0 | 1;
  volume: number;
  family: string;
};

type BatchResult = {
  status: "ok" | "error";
  backgroundMode: BackgroundMode;
  repeat: number;
  index: number;
  slug: string;
  question: string;
  family: string;
  outcomes: [string, string];
  actualOutcome?: string;
  jevProbabilities?: [number, number];
  jevChoice?: "outcome_a" | "outcome_b";
  jevConfidence?: number;
  probabilityOfActual?: number;
  brier?: number;
  correct?: boolean;
  marketProbabilities?: [number, number];
  marketProbabilityOfActual?: number;
  marketBrier?: number;
  marketCorrect?: boolean;
  marketPriceTimestamp?: number;
  marketPriceCutoffTimestamp?: number;
  marketBaselineMode?: "lead_time" | "event_end_fallback";
  marketBaselineError?: string;
  latencyMs?: number;
  inputTokens?: number;
  model?: string;
  error?: string;
};

function parseBackgroundModes(value: string | undefined): BackgroundMode[] {
  const requested = (value ?? "generic")
    .split(",")
    .map((mode) => mode.trim())
    .filter((mode): mode is BackgroundMode =>
      SUPPORTED_BACKGROUND_MODES.includes(mode as BackgroundMode),
    );
  return requested.length ? [...new Set(requested)] : ["generic"];
}

function parseArray<T>(value: unknown, field: string): T[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Expected array in " + field);
  return parsed as T[];
}

function numberValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Expected number in " + field);
  return parsed;
}

function familyFor(question: string): string {
  const colon = question.indexOf(":");
  if (colon > 0) return question.slice(0, colon).trim();
  return question.split(/\s+/).slice(0, 2).join(" ");
}

async function fetchPage(offset: number): Promise<GammaMarket[]> {
  const url =
    GAMMA_MARKETS_URL +
    "?closed=true&limit=" +
    PAGE_SIZE +
    "&offset=" +
    offset +
    "&tag_id=" +
    encodeURIComponent(SPORTS_TAG_ID);

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("Gamma API returned a non-array page");
    return payload as GammaMarket[];
  } catch (error: unknown) {
    const cause = error instanceof Error && "cause" in error ? String(error.cause) : String(error);
    throw new Error("Failed to fetch historical markets at offset " + offset + ": " + cause);
  }
}

type MarketBaseline = {
  probabilities: [number, number];
  priceTimestamp: number;
  cutoffTimestamp: number;
  mode: "lead_time" | "event_end_fallback";
};

async function fetchMarketBaseline(candidate: Candidate): Promise<MarketBaseline> {
  if (!candidate.market.clobTokenIds || !candidate.market.endDate) {
    throw new Error("Missing CLOB token IDs or end date");
  }
  const tokenIds = parseArray<string>(candidate.market.clobTokenIds, candidate.market.slug + ".clobTokenIds");
  if (tokenIds.length !== 2) throw new Error("Expected two CLOB token IDs");

  const eventEndSeconds = Math.floor(Date.parse(candidate.market.endDate) / 1000);
  if (!Number.isFinite(eventEndSeconds)) {
    throw new Error("Invalid historical market time range");
  }
  const preferredCutoffSeconds = eventEndSeconds - PRE_EVENT_LEAD_SECONDS;
  const fallbackStartSeconds = Math.max(0, eventEndSeconds - 7 * 24 * 60 * 60);
  const declaredStartSeconds = candidate.market.startDate
    ? Math.floor(Date.parse(candidate.market.startDate) / 1000)
    : Number.NaN;
  const startSeconds =
    Number.isFinite(declaredStartSeconds) && declaredStartSeconds < eventEndSeconds
      ? declaredStartSeconds
      : fallbackStartSeconds;
  if (eventEndSeconds <= startSeconds) {
    throw new Error("Invalid historical market time range");
  }

  const attempts: Array<{ cutoffSeconds: number; mode: MarketBaseline["mode"] }> = [
    { cutoffSeconds: preferredCutoffSeconds, mode: "lead_time" },
    { cutoffSeconds: eventEndSeconds, mode: "event_end_fallback" },
  ];
  let lastError = "No pre-event price history";
  for (const attempt of attempts) {
    if (attempt.cutoffSeconds <= startSeconds) continue;
    const url =
      "https://clob.polymarket.com/prices-history?market=" +
      encodeURIComponent(tokenIds[0]) +
      "&startTs=" +
      startSeconds +
      "&endTs=" +
      attempt.cutoffSeconds +
      "&fidelity=60";
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      lastError = "CLOB history HTTP " + response.status;
      continue;
    }
    const payload = (await response.json()) as { history?: Array<{ t?: number; p?: number }> };
    const points = (payload.history ?? [])
      .map((point) => ({ t: Number(point.t), p: Number(point.p) }))
      .filter(
        (point) =>
          Number.isFinite(point.t) && Number.isFinite(point.p) && point.t <= attempt.cutoffSeconds,
      )
      .sort((a, b) => a.t - b.t);
    const last = points.at(-1);
    if (!last) {
      lastError = "No pre-event price history";
      continue;
    }
    const p0 = Math.max(0, Math.min(1, last.p));
    return {
      probabilities: [p0, 1 - p0],
      priceTimestamp: last.t,
      cutoffTimestamp: attempt.cutoffSeconds,
      mode: attempt.mode,
    };
  }
  throw new Error(lastError);
}

type BaselineLookup = {
  baseline: MarketBaseline | null;
  error?: string;
};

async function collectMarketBaselines(candidates: Candidate[]): Promise<BaselineLookup[]> {
  const lookups: BaselineLookup[] = new Array(candidates.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= candidates.length) return;
      try {
        lookups[index] = { baseline: await fetchMarketBaseline(candidates[index]) };
      } catch (error: unknown) {
        lookups[index] = {
          baseline: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
  return lookups;
}

function toCandidate(market: GammaMarket): Candidate | null {
  if (market.closed !== true || !market.question || !market.description) return null;
  const outcomes = parseArray<string>(market.outcomes, market.slug + ".outcomes");
  const finalPrices = parseArray<unknown>(market.outcomePrices, market.slug + ".outcomePrices").map(
    (value) => numberValue(value, market.slug + ".outcomePrices"),
  );
  if (outcomes.length !== 2 || finalPrices.length !== 2) return null;
  const winner = finalPrices.findIndex((price) => price >= 0.999);
  if (winner < 0 || finalPrices[1 - winner] > 0.001) return null;
  const volume = numberValue(market.volume ?? 0, market.slug + ".volume");
  if (volume < MIN_VOLUME) return null;
  return {
    market,
    outcomes: [outcomes[0], outcomes[1]],
    finalPrices: [finalPrices[0], finalPrices[1]],
    actualIndex: winner as 0 | 1,
    volume,
    family: familyFor(market.question),
  };
}

function selectDiverse(candidates: Candidate[], count: number): Candidate[] {
  const buckets = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.family) ?? [];
    bucket.push(candidate);
    buckets.set(candidate.family, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.volume - a.volume);
  }

  const selected: Candidate[] = [];
  const families = [...buckets.keys()].sort();
  while (selected.length < count) {
    let progressed = false;
    for (const family of families) {
      const candidate = buckets.get(family)?.shift();
      if (!candidate) continue;
      selected.push(candidate);
      progressed = true;
      if (selected.length === count) break;
    }
    if (!progressed) break;
  }
  return selected;
}

function questionFor(outcomes: [string, string]) {
  return choice(
    "Which outcome would have been more likely before this historical market was resolved? " +
      "Use only the market question, exact resolution rule, and supplied background. " +
      "Do not infer the answer from this being a retrospective test. Treat missing evidence as uncertainty.",
    {
      outcome_a: "The market resolves to " + outcomes[0] + ".",
      outcome_b: "The market resolves to " + outcomes[1] + ".",
    },
  );
}

function backgroundFor(mode: BackgroundMode): string {
  if (mode === "bare") return "No additional background is provided.";
  if (mode === "sports_prior") {
    return (
      "This is a historical sports or esports prediction market. " +
      "The final outcome, terminal market price, comments, and post-event information are intentionally omitted. " +
      "For a match, relevant general considerations can include relative team strength, recent form, roster availability, venue, and format. " +
      "Only use such considerations when supported by the supplied information; do not invent missing facts."
    );
  }
  if (mode === "calibrated") {
    return (
      "This is a historical sports or esports prediction market. " +
      "The final outcome, terminal market price, comments, and post-event information are intentionally omitted. " +
      "Judge as if making the decision before resolution using only the supplied question and resolution rule. " +
      "When evidence is missing, keep the probability distribution cautious rather than manufacturing certainty."
    );
  }
  return (
    "This is a historical sports or esports prediction market. " +
    "The final outcome, terminal market price, comments, and post-event information are intentionally omitted. " +
    "Judge as if making the decision before resolution using only the supplied question and resolution rule."
  );
}

async function collectCandidates(): Promise<Candidate[]> {
  const bySlug = new Map<string, Candidate>();
  for (let page = 0; page < MAX_PAGES && bySlug.size < TARGET_COUNT * 2; page += 1) {
    const markets = await fetchPage(page * PAGE_SIZE);
    if (markets.length === 0) break;
    for (const market of markets) {
      try {
        const candidate = toCandidate(market);
        if (candidate) bySlug.set(candidate.market.slug, candidate);
      } catch {
        // Skip malformed or non-binary market records.
      }
    }
    console.log("Collected candidates: " + bySlug.size + " after page " + (page + 1));
  }

  const selected = selectDiverse([...bySlug.values()], TARGET_COUNT);
  if (selected.length < TARGET_COUNT) {
    throw new Error(
      "Only found " +
        selected.length +
        " eligible markets. Lower JEV_BATCH_MIN_VOLUME or increase JEV_BATCH_MAX_PAGES.",
    );
  }
  return selected;
}

async function runOne(
  client: TypeSafeClient,
  candidate: Candidate,
  index: number,
  backgroundMode: BackgroundMode,
  repeat: number,
  marketBaseline: MarketBaseline | null,
  marketBaselineError: string | undefined,
): Promise<BatchResult> {
  const startedAt = performance.now();
  try {
    const response = await client.systemOne({
      state: {
        market_question: candidate.market.question,
        resolution_rule: candidate.market.description,
        outcomes: candidate.outcomes,
        background: backgroundFor(backgroundMode),
        deadline: candidate.market.endDate ?? null,
      },
      questions: {
        resolved_outcome: questionFor(candidate.outcomes),
      },
    });

    const answer = response.answers.resolved_outcome;
    const probabilities: [number, number] = [
      answer.probabilities.outcome_a,
      answer.probabilities.outcome_b,
    ];
    const actualProbability = probabilities[candidate.actualIndex];
    const target = candidate.actualIndex === 0 ? [1, 0] : [0, 1];
    const brier = (probabilities[0] - target[0]) ** 2 + (probabilities[1] - target[1]) ** 2;
    const marketProbabilityOfActual = marketBaseline
      ? marketBaseline.probabilities[candidate.actualIndex]
      : undefined;
    const marketBrier = marketBaseline
      ? (marketBaseline.probabilities[0] - target[0]) ** 2 +
        (marketBaseline.probabilities[1] - target[1]) ** 2
      : undefined;

    return {
      status: "ok",
      backgroundMode,
      repeat,
      index,
      slug: candidate.market.slug,
      question: candidate.market.question,
      family: candidate.family,
      outcomes: candidate.outcomes,
      actualOutcome: candidate.outcomes[candidate.actualIndex],
      jevProbabilities: probabilities,
      jevChoice: answer.choice,
      jevConfidence: answer.confidence,
      probabilityOfActual: actualProbability,
      brier,
      correct: (answer.choice === "outcome_a" ? 0 : 1) === candidate.actualIndex,
      marketProbabilities: marketBaseline?.probabilities,
      marketProbabilityOfActual,
      marketBrier,
      marketCorrect: marketProbabilityOfActual === undefined ? undefined : marketProbabilityOfActual >= 0.5,
      marketPriceTimestamp: marketBaseline?.priceTimestamp,
      marketPriceCutoffTimestamp: marketBaseline?.cutoffTimestamp,
      marketBaselineMode: marketBaseline?.mode,
      marketBaselineError,
      latencyMs: Math.round(performance.now() - startedAt),
      inputTokens: response.usage.input_tokens,
      model: response.model,
    };
  } catch (error: unknown) {
    return {
      status: "error",
      backgroundMode,
      repeat,
      index,
      slug: candidate.market.slug,
      question: candidate.market.question,
      family: candidate.family,
      outcomes: candidate.outcomes,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type BatchMetrics = {
  successfulCount: number;
  errorCount: number;
  accuracy: number | null;
  meanBrier: number;
  meanProbabilityOfActual: number;
  highConfidenceWrong: number;
  marketBaselineCount: number;
  marketBaselineFallbackCount: number;
  marketAccuracy: number | null;
  marketMeanBrier: number | null;
  jevMeanBrierOnMarketComparable: number | null;
  jevBrierWinsAgainstMarket: number;
};

function summarizeResults(results: BatchResult[]): BatchMetrics {
  const successful = results.filter((result) => result.status === "ok");
  const marketComparable = successful.filter((result) => result.marketBrier !== undefined);
  const correct = successful.filter((result) => result.correct).length;
  const meanBrier =
    successful.reduce((sum, result) => sum + (result.brier ?? 0), 0) / Math.max(1, successful.length);
  const meanProbabilityOfActual =
    successful.reduce((sum, result) => sum + (result.probabilityOfActual ?? 0), 0) /
    Math.max(1, successful.length);
  const highConfidenceWrong = successful.filter(
    (result) => !result.correct && (result.jevConfidence ?? 0) >= 0.7,
  ).length;
  const marketCorrect = marketComparable.filter((result) => result.marketCorrect).length;
  const marketBrier = marketComparable.reduce((sum, result) => sum + (result.marketBrier ?? 0), 0);
  const jevBrierOnMarketComparable = marketComparable.reduce(
    (sum, result) => sum + (result.brier ?? 0),
    0,
  );
  return {
    successfulCount: successful.length,
    errorCount: results.length - successful.length,
    accuracy: successful.length ? correct / successful.length : null,
    meanBrier,
    meanProbabilityOfActual,
    highConfidenceWrong,
    marketBaselineCount: marketComparable.length,
    marketBaselineFallbackCount: marketComparable.filter(
      (result) => result.marketBaselineMode === "event_end_fallback",
    ).length,
    marketAccuracy: marketComparable.length ? marketCorrect / marketComparable.length : null,
    marketMeanBrier: marketComparable.length ? marketBrier / marketComparable.length : null,
    jevMeanBrierOnMarketComparable: marketComparable.length
      ? jevBrierOnMarketComparable / marketComparable.length
      : null,
    jevBrierWinsAgainstMarket: marketComparable.filter(
      (result) => (result.brier ?? Infinity) < (result.marketBrier ?? Infinity),
    ).length,
  };
}

function summarizeByFamily(results: BatchResult[]): Record<string, object> {
  const successful = results.filter((result) => result.status === "ok");
  const byFamily = new Map<string, { count: number; correct: number; brier: number }>();
  for (const result of successful) {
    const current = byFamily.get(result.family) ?? { count: 0, correct: 0, brier: 0 };
    current.count += 1;
    current.correct += result.correct ? 1 : 0;
    current.brier += result.brier ?? 0;
    byFamily.set(result.family, current);
  }
  return Object.fromEntries(
    [...byFamily.entries()].map(([family, value]) => [
      family,
      {
        count: value.count,
        accuracy: value.correct / value.count,
        meanBrier: value.brier / value.count,
      },
    ]),
  );
}

function average(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finiteValues.length ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length : null;
}

function standardDeviation(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!finiteValues.length) return null;
  const mean = finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
  return Math.sqrt(
    finiteValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finiteValues.length,
  );
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new Error("Missing TYPESAFE_API_KEY.");
  }

  const candidates = await collectCandidates();
  const baselines = await collectMarketBaselines(candidates);
  await mkdir(resolve("data"), { recursive: true });
  await writeFile(resultsPath, "", "utf8");

  const client = new TypeSafeClient({ logLevel: "off", timeout: 30000 });
  const jobs = Array.from(
    { length: BACKGROUND_MODES.length * REPEAT_COUNT * candidates.length },
    (_, flatIndex) => {
      const modeStride = REPEAT_COUNT * candidates.length;
      const modeIndex = Math.floor(flatIndex / modeStride);
      const modeOffset = flatIndex % modeStride;
      return {
        flatIndex,
        backgroundMode: BACKGROUND_MODES[modeIndex],
        repeat: Math.floor(modeOffset / candidates.length),
        index: modeOffset % candidates.length,
      };
    },
  );
  let cursor = 0;
  const results: BatchResult[] = new Array(jobs.length);
  let writeChain = Promise.resolve();

  const worker = async () => {
    while (true) {
      const job = jobs[cursor++];
      if (!job) return;
      const candidate = candidates[job.index];
      const baseline = baselines[job.index];
      const result = await runOne(
        client,
        candidate,
        job.index,
        job.backgroundMode,
        job.repeat,
        baseline.baseline,
        baseline.error,
      );
      results[job.flatIndex] = result;
      writeChain = writeChain.then(() => appendFile(resultsPath, JSON.stringify(result) + "\n", "utf8"));
      await writeChain;
      console.log(
        "[" +
          (job.flatIndex + 1) +
          "/" +
          jobs.length +
          "] " +
          "repeat " +
          (job.repeat + 1) +
          "/" +
          REPEAT_COUNT +
          " " +
          job.backgroundMode +
          " " +
          result.status +
          " " +
          candidate.market.question,
      );
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  const overall = summarizeResults(results);
  const uniqueMarketBaselineCount = baselines.filter((baseline) => baseline.baseline).length;
  const uniqueMarketFallbackCount = baselines.filter(
    (baseline) => baseline.baseline?.mode === "event_end_fallback",
  ).length;

  const summarizeMode = (mode: BackgroundMode) => {
    const modeResults = results.filter((result) => result.backgroundMode === mode);
    const modeOverall = summarizeResults(modeResults);
    const repeatSummaries = Array.from({ length: REPEAT_COUNT }, (_, repeat) => ({
      repeat: repeat + 1,
      ...summarizeResults(modeResults.filter((result) => result.repeat === repeat)),
    }));
    const repeatAccuracy = repeatSummaries.map((item) => item.accuracy);
    const repeatMeanBrier = repeatSummaries.map((item) => item.meanBrier);
    const repeatMeanActualProbability = repeatSummaries.map(
      (item) => item.meanProbabilityOfActual,
    );
    const repeatHighConfidenceWrong = repeatSummaries.map((item) => item.highConfidenceWrong);
    return {
      mode,
      ...modeOverall,
      marketBaselineCount: uniqueMarketBaselineCount,
      marketBaselineFallbackCount: uniqueMarketFallbackCount,
      repeatSummaries,
      repeatAggregate: {
        accuracyMean: average(repeatAccuracy),
        accuracyStdDev: standardDeviation(repeatAccuracy),
        meanBrierMean: average(repeatMeanBrier),
        meanBrierStdDev: standardDeviation(repeatMeanBrier),
        meanProbabilityOfActualMean: average(repeatMeanActualProbability),
        highConfidenceWrongMean: average(repeatHighConfidenceWrong),
      },
    };
  };
  const ablationSummaries = BACKGROUND_MODES.map(summarizeMode);
  const primaryModeSummary = ablationSummaries[0];

  const summary = {
    runId,
    targetCount: TARGET_COUNT,
    selectedCount: candidates.length,
    backgroundModes: BACKGROUND_MODES,
    modeCount: BACKGROUND_MODES.length,
    repeatCount: REPEAT_COUNT,
    ...overall,
    concurrency: CONCURRENCY,
    sportsTagId: SPORTS_TAG_ID,
    minVolume: MIN_VOLUME,
    uniformBaselineBrier: 0.5,
    uniqueMarketBaselineCount,
    marketBaselineCount: uniqueMarketBaselineCount,
    marketBaselineFallbackCount: uniqueMarketFallbackCount,
    preEventLeadSeconds: PRE_EVENT_LEAD_SECONDS,
    byFamily: summarizeByFamily(
      results.filter(
        (result) => result.backgroundMode === BACKGROUND_MODES[0] && result.repeat === 0,
      ),
    ),
    byFamilyScope: BACKGROUND_MODES[0] + " repeat 1",
    repeatSummaries: primaryModeSummary.repeatSummaries,
    repeatAggregate: primaryModeSummary.repeatAggregate,
    ablationSummaries,
    resultsPath,
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("\n=== Historical Jev batch summary ===");
  console.log(
    "Fixed markets: " +
      candidates.length +
      " | background modes: " +
      BACKGROUND_MODES.join(",") +
      " | repeats per mode: " +
      REPEAT_COUNT +
      " | successful predictions: " +
      overall.successfulCount +
      "/" +
      jobs.length,
  );
  console.log(
    "Aggregate accuracy: " +
      (overall.accuracy === null ? "n/a" : (overall.accuracy * 100).toFixed(1) + "%"),
  );
  console.log("Aggregate mean Brier: " + overall.meanBrier.toFixed(4) + " (uniform baseline: 0.5000)");
  console.log(
    "Market baseline: " +
      uniqueMarketBaselineCount +
      " unique comparable | accuracy " +
      (overall.marketAccuracy === null ? "n/a" : (overall.marketAccuracy * 100).toFixed(1)) +
      "% | mean Brier " +
      (overall.marketMeanBrier ?? NaN).toFixed(4),
  );
  console.log(
    "Jev mean Brier on same subset: " +
      (overall.jevMeanBrierOnMarketComparable ?? NaN).toFixed(4) +
      " | Jev wins " +
      overall.jevBrierWinsAgainstMarket +
      " across all repeats",
  );
  for (const modeSummary of ablationSummaries) {
    console.log(
      "Mode " +
        modeSummary.mode +
        ": accuracy " +
        (modeSummary.repeatAggregate.accuracyMean === null
          ? "n/a"
          : (modeSummary.repeatAggregate.accuracyMean * 100).toFixed(1) +
            "% ± " +
            ((modeSummary.repeatAggregate.accuracyStdDev ?? 0) * 100).toFixed(1) +
            "pp") +
        " | Brier " +
        (modeSummary.repeatAggregate.meanBrierMean ?? NaN).toFixed(4) +
        " ± " +
        (modeSummary.repeatAggregate.meanBrierStdDev ?? NaN).toFixed(4) +
        " | high-confidence wrong " +
        (modeSummary.repeatAggregate.highConfidenceWrongMean ?? NaN).toFixed(1),
    );
  }
  console.log("Results: " + resultsPath);
  console.log("Summary: " + summaryPath);
}

main().catch((error: unknown) => {
  console.error("Batch experiment failed: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

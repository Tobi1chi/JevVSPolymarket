import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const SNAPSHOT_PATH = resolve("data/jev-snapshots.jsonl");

type MarketConfig = {
  slug: string;
  background: string;
};

type GammaMarket = {
  question: string;
  slug: string;
  description: string;
  outcomes: string | string[];
  outcomePrices: string | string[];
  endDate?: string;
  volume?: string | number;
  updatedAt?: string;
  active?: boolean;
  closed?: boolean;
};

type PreparedMarket = {
  config: MarketConfig;
  market: GammaMarket;
  outcomeLabels: [string, string];
  marketProbabilities: [number, number];
};

type ExperimentSnapshot = {
  capturedAt: string;
  slug: string;
  question: string;
  marketUrl: string;
  resolutionRule: string;
  background: string;
  deadline: string | null;
  outcomes: [string, string];
  marketProbabilities: [number, number];
  jevProbabilities: [number, number];
  jevChoice: "outcome_a" | "outcome_b";
  jevConfidence: number;
  jevModel: string;
  jevLatencyMs: number;
  inputTokens: number;
};

// These are non-political, binary markets selected from Polymarket's sports/entertainment
// listings. The background is deliberately explicit and easy to replace for another test.
const MARKET_CONFIGS = [
  {
    slug: "cs2-ace1-bbp-2026-01-23",
    background:
      "This is a best-of-three Counter-Strike match between Acend and Bebop " +
      "in CCT Europe Series #14 Play-In Group B. Judge only the match winner. " +
      "No odds, roster status, map veto, or recent-form data is provided.",
  },
];

const transitionQuestion = (outcomes: [string, string]) =>
  choice(
    "Which of the two listed outcomes is more likely to be the official resolved outcome of " +
      "this market? Use the exact resolution rule and the supplied background. Treat missing " +
      "evidence as uncertainty. Do not assume that the market price is correct.",
    {
      outcome_a: `The market resolves to ${outcomes[0]}.`,
      outcome_b: `The market resolves to ${outcomes[1]}.`,
    },
  );

function parseArray<T>(value: unknown, field: string): T[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`Polymarket field ${field} was not an array.`);
  }
  return parsed as T[];
}

function asNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Polymarket field ${field} was not numeric.`);
  }
  return parsed;
}

async function fetchMarket(slug: string): Promise<GammaMarket> {
  const queryUrls = [
    `${GAMMA_MARKETS_URL}?slug=${encodeURIComponent(slug)}`,
    `${GAMMA_MARKETS_URL}?slug=${encodeURIComponent(slug)}&closed=true`,
  ];

  for (const url of queryUrls) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Polymarket API returned HTTP ${response.status} for ${slug}.`);
    }

    const payload: unknown = await response.json();
    const markets = Array.isArray(payload) ? payload : [payload];
    if (markets.length === 1) return markets[0] as GammaMarket;
  }

  throw new Error(`Polymarket returned no active or closed market for ${slug}.`);
}

async function prepareMarket(config: MarketConfig): Promise<PreparedMarket> {
  const market = await fetchMarket(config.slug);
  const outcomes = parseArray<string>(market.outcomes, `${config.slug}.outcomes`);
  const prices = parseArray<unknown>(market.outcomePrices, `${config.slug}.outcomePrices`).map(
    (price) => asNumber(price, `${config.slug}.outcomePrices`),
  );

  if (outcomes.length !== 2 || prices.length !== 2) {
    throw new Error(`${config.slug} is not a binary market; choose a market with exactly two outcomes.`);
  }

  return {
    config,
    market,
    outcomeLabels: [outcomes[0], outcomes[1]],
    marketProbabilities: [prices[0], prices[1]],
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function money(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "n/a";
}

function readChoiceProbability(
  probabilities: Readonly<{ outcome_a: number; outcome_b: number }>,
): [number, number] {
  return [probabilities.outcome_a, probabilities.outcome_b];
}

async function appendSnapshot(snapshot: ExperimentSnapshot): Promise<void> {
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await appendFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot)}\n`, "utf8");
}

async function runExperiment(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new Error(
      "Missing TYPESAFE_API_KEY. Set it in the shell before running this experiment; the key is never stored in this project.",
    );
  }

  const preparedMarkets = await Promise.all(MARKET_CONFIGS.map(prepareMarket));
  const client = new TypeSafeClient({ logLevel: "off" });

  const results = await Promise.all(
    preparedMarkets.map(async (item) => {
      const startedAt = performance.now();
      const response = await client.systemOne({
        state: {
          market_question: item.market.question,
          resolution_rule: item.market.description,
          background: item.config.background,
          deadline: item.market.endDate ?? null,
          note: "This is an offline-style model evaluation, not trading advice.",
        },
        questions: {
          resolved_outcome: transitionQuestion(item.outcomeLabels),
        },
      });
      const answer = response.answers.resolved_outcome;
      const jevProbabilities = readChoiceProbability(answer.probabilities);
      const elapsedMs = Math.round(performance.now() - startedAt);

      return {
        item,
        response,
        answer,
        jevProbabilities,
        elapsedMs,
      };
    }),
  );

  for (const { item, response, answer, jevProbabilities, elapsedMs } of results) {
    await appendSnapshot({
      capturedAt: new Date().toISOString(),
      slug: item.market.slug,
      question: item.market.question,
      marketUrl: `https://polymarket.com/event/${item.market.slug}`,
      resolutionRule: item.market.description,
      background: item.config.background,
      deadline: item.market.endDate ?? null,
      outcomes: item.outcomeLabels,
      marketProbabilities: item.marketProbabilities,
      jevProbabilities,
      jevChoice: answer.choice,
      jevConfidence: answer.confidence,
      jevModel: response.model,
      jevLatencyMs: elapsedMs,
      inputTokens: response.usage.input_tokens,
    });

    console.log(`=== ${item.market.question} ===`);
    console.log(
      `Market: ${item.outcomeLabels[0]} ${percent(item.marketProbabilities[0])} / ` +
        `${item.outcomeLabels[1]} ${percent(item.marketProbabilities[1])}`,
    );
    console.log(
      `Jev: ${item.outcomeLabels[answer.choice === "outcome_a" ? 0 : 1]} ` +
        `(confidence ${percent(answer.confidence)})`,
    );
    console.log(
      `Jev distribution: ${item.outcomeLabels[0]} ${percent(jevProbabilities[0])} / ` +
        `${item.outcomeLabels[1]} ${percent(jevProbabilities[1])}`,
    );
    console.log(`Volume: ${money(item.market.volume)} | latency: ${elapsedMs} ms`);
    console.log(`Market URL: ${`https://polymarket.com/event/${item.market.slug}`}`);
    console.log();
  }

  console.log(`Snapshots appended to ${SNAPSHOT_PATH}`);
  console.log("After a market settles, run: pnpm analyze");
}

function settledOutcome(market: GammaMarket): string | null {
  if (market.closed !== true) return null;

  const outcomes = parseArray<string>(market.outcomes, `${market.slug}.outcomes`);
  const prices = parseArray<unknown>(market.outcomePrices, `${market.slug}.outcomePrices`).map(
    (price) => asNumber(price, `${market.slug}.outcomePrices`),
  );
  if (outcomes.length !== 2 || prices.length !== 2) return null;

  const winner = prices.findIndex((price) => price >= 0.999);
  return winner >= 0 ? outcomes[winner] : null;
}

async function analyzeSnapshots(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(SNAPSHOT_PATH, "utf8");
  } catch {
    throw new Error(`No snapshot file found at ${SNAPSHOT_PATH}. Run pnpm start first.`);
  }

  const snapshots = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExperimentSnapshot);
  const grouped = new Map<string, ExperimentSnapshot[]>();
  for (const snapshot of snapshots) {
    const existing = grouped.get(snapshot.slug) ?? [];
    existing.push(snapshot);
    grouped.set(snapshot.slug, existing);
  }

  let resolvedCount = 0;
  let jevBrierTotal = 0;
  let marketBrierTotal = 0;

  for (const [slug, records] of grouped) {
    const market = await fetchMarket(slug);
    const actual = settledOutcome(market);
    if (actual === null) {
      console.log(`${slug}: not settled yet; saved snapshots=${records.length}`);
      continue;
    }

    resolvedCount += records.length;
    for (const record of records) {
      const actualIndex = record.outcomes.indexOf(actual);
      if (actualIndex < 0) {
        console.log(`${slug}: actual outcome ${actual} was not in the saved outcomes; skipped.`);
        continue;
      }

      const jevActual = record.jevProbabilities[actualIndex];
      const marketActual = record.marketProbabilities[actualIndex];
      const jevBrier = (jevActual - 1) ** 2 + record.jevProbabilities[1 - actualIndex] ** 2;
      const marketBrier = (marketActual - 1) ** 2 + record.marketProbabilities[1 - actualIndex] ** 2;
      jevBrierTotal += jevBrier;
      marketBrierTotal += marketBrier;

      console.log(`=== Settled: ${record.question} ===`);
      console.log(`Actual outcome: ${actual}`);
      console.log(
        `Snapshot ${record.capturedAt}: Jev p(actual) ${percent(jevActual)} / ` +
          `Market p(actual) ${percent(marketActual)}`,
      );
      console.log(`Brier: Jev ${jevBrier.toFixed(4)} / Market ${marketBrier.toFixed(4)}`);
      console.log();
    }
  }

  if (resolvedCount > 0) {
    console.log(
      `Resolved snapshots: ${resolvedCount} | ` +
        `mean Brier Jev ${(jevBrierTotal / resolvedCount).toFixed(4)} / ` +
        `Market ${(marketBrierTotal / resolvedCount).toFixed(4)}`,
    );
  }
}

const analyze = process.argv.includes("--analyze");
(analyze ? analyzeSnapshots() : runExperiment()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Experiment failed: ${message}`);
  process.exitCode = 1;
});

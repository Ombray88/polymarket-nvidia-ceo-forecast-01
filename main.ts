import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// This script processes historical price case files and computes future quantile forecasts.
// Each individual market uses its own recent price volatility to scale prediction uncertainty.

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Asymmetric multipliers for the five quantiles: the lower tail is wider than the upper one,
 * because these prices collapse downward far more often and further than they jump up. */
const Z = [-2.2, -0.8, 0, 0.6, 1.35];
/** One-minute price changes are clipped to this range before volatility is measured,
 * so a single jump cannot inflate the spread. */
const WINSOR = 0.005;
/** Minutes of recent history used to measure each market's volatility. */
const WINDOW = 720;
/** Volatility is clamped to this range, so a frozen market still gets a small spread
 * and a wild one cannot blow the bands out. */
const SIGMA_MIN = 0.0002;
const SIGMA_MAX = 0.02;
/** Fallback volatility for a market with too little history to measure. */
const SIGMA_DEFAULT = 0.0025;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** One market's per-minute volatility from its recent history, winsorized. */
function sigmaOf(prices: number[]): number {
  const p = prices.slice(-WINDOW);
  if (p.length < 2) return SIGMA_DEFAULT;
  const d: number[] = [];
  for (let i = 1; i < p.length; i++) {
    const c = p[i] - p[i - 1];
    d.push(Math.min(WINSOR, Math.max(-WINSOR, c)));
  }
  const mu = d.reduce((s, x) => s + x, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mu) * (x - mu), 0) / d.length);
  return Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, sd));
}

/**
 * Truncating extreme outlier ticks during variance calculation prevents transient
 * order-book noise or single-minute flashes from artificially inflating our uncertainty bounds,
 * yielding tighter, more accurate dispersion forecasts.
 */
/** One market's forecast: horizon rows of the five quantiles around its last price. */
function forecast(m: CaseMarket, horizon: number): number[][] {
  if (m.prices.length === 0) return Array.from({ length: horizon }, () => [0.5, 0.5, 0.5, 0.5, 0.5]);
  const x = m.prices[m.prices.length - 1] as number;
  const sd = sigmaOf(m.prices);
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const row = Z.map((z) => price6(x + z * sd * Math.sqrt(h)));
    row.sort((a, b) => a - b);
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  // Ensure cases with no markets produce an empty forecasts output file rather than failing.
  if (!c.markets || c.markets.length === 0) {
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts: [] })}\n`);
    continue;
  }
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}

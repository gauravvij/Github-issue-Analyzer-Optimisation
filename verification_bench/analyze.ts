/**
 * Paired, stratified analysis of v2 benchmark runs.
 *
 * The campaign's headline was "94.29% -> 100%". That number is true and almost
 * useless: two questions out of thirty-five moved, both of them `Issue.state`
 * enum questions, and the aggregate hid it completely. So this reports nothing
 * as a bare percentage. It reports, per arm contrast:
 *
 *   - which individual questions flipped, and in which stratum
 *   - McNemar's exact test on the discordant pairs
 *   - a paired bootstrap CI on the accuracy difference
 *   - per-stratum accuracy with Wilson intervals
 *   - how much the answer changes when the same question is reworded
 *
 * Jobs are matched by name: `<arm>__<split>`, e.g. `A-baseline__skl-dev`.
 *
 *   bun verification_bench/analyze.ts
 *   bun verification_bench/analyze.ts --arms A-baseline,D-champion-enum
 *   bun verification_bench/analyze.ts --regrade bench/jobs/repro-champion
 *
 * `--regrade` re-scores a stored report with grade-v2 and prints the delta. It
 * costs nothing and loses nothing: every answer the harness has ever stored is
 * far below the 4,000-character cap it truncates at.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Check } from '../bench/scripts/build-tasks';
import { gradeDeterministic } from '../bench/harness/grade';
import { gradeDeterministicV2 } from './grade-v2';
import { STRATA, type Stratum, type TaskV2 } from './scripts/build-tasks-v2';

const BENCH = import.meta.dirname;
const JOBS = join(BENCH, 'jobs');

// ---------------------------------------------------------------------------
// Statistics — stdlib only, deterministic
// ---------------------------------------------------------------------------

function lnGamma(x: number): number {
  // Lanczos, g=7. Plenty for binomial coefficients at n < 10^4.
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const lnChoose = (n: number, k: number) => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);

/** Exact two-sided McNemar: is a discordant split of b vs c worse than a coin? */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(lnChoose(n, i) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

/** Wilson score interval — behaves at 0% and 100%, which normal approx does not. */
export function wilson(passes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = passes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - half) / d), Math.min(1, (centre + half) / d)];
}

const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/** Percentile CI on the paired difference, resampling QUESTIONS not attempts. */
export function pairedBootstrap(a: number[], b: number[], iters = 10_000, seed = 20260905): [number, number] {
  const n = a.length;
  if (n === 0) return [0, 0];
  const rand = lcg(seed);
  const diffs: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rand() * n);
      s += b[k] - a[k];
    }
    diffs.push(s / n);
  }
  diffs.sort((x, y) => x - y);
  return [diffs[Math.floor(iters * 0.025)], diffs[Math.floor(iters * 0.975)]];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface Attempt { pass: boolean; reason: string; answer: string; error?: string; toolCalls: unknown[] }
interface TaskRecord { id: string; template: string; kind: string; canary: boolean; question: string; oracle: string; attempts: Attempt[]; passRate: number }
interface Report {
  job: string; split: string; valid: boolean; invalidReason: string | null;
  config: { attempts: number; stage: string; keepGraph: boolean };
  sut: { hash: string; files: number };
  graphProvenance: { sutHash: string; split: string; job: string } | null;
  qa?: { tasks: TaskRecord[] };
  score?: Record<string, unknown>;
  cost?: Record<string, number>;
}

interface Row {
  arm: string; split: string; id: string; template: string; stratum: Stratum;
  paraphraseGroup?: string; canary: boolean; passRate: number; solved: boolean;
  emptyAnswer: boolean; errored: boolean; question: string;
}

const readTasks = (root: string, split: string): Map<string, TaskV2> => {
  const p = join(root, 'tasks', `${split}.jsonl`);
  const m = new Map<string, TaskV2>();
  if (!existsSync(p)) return m;
  for (const line of readFileSync(p, 'utf-8').trim().split('\n')) {
    const t = JSON.parse(line) as TaskV2;
    m.set(t.id, t);
  }
  return m;
};

/** Majority of attempts. A single lucky attempt is not a solved question. */
const solvedBy = (passRate: number) => passRate >= 2 / 3 - 1e-9;

function loadRows(armFilter?: string[]): { rows: Row[]; reports: Report[] } {
  const rows: Row[] = [];
  const reports: Report[] = [];
  for (const dir of readdirSync(JOBS).sort()) {
    if (!dir.includes('__')) continue;
    const [arm, split] = [dir.slice(0, dir.indexOf('__')), dir.slice(dir.indexOf('__') + 2)];
    if (armFilter && !armFilter.includes(arm)) continue;
    const p = join(JOBS, dir, 'report.json');
    if (!existsSync(p)) continue;
    const r = JSON.parse(readFileSync(p, 'utf-8')) as Report;
    reports.push(r);
    const tasks = readTasks(BENCH, split);
    for (const t of r.qa?.tasks ?? []) {
      const meta = tasks.get(t.id);
      // Deterministic outcomes are recomputed from the stored answers rather
      // than read out of the report, so a grader repair never costs a re-run.
      // Judge verdicts cannot be recomputed — they were model calls — so those
      // are taken as recorded.
      const passRate = meta && meta.check.type !== 'judge'
        ? t.attempts.filter((a) => (a.error && !a.answer ? false : gradeDeterministicV2(meta.check, a.answer, t.question).pass)).length /
          Math.max(1, t.attempts.length)
        : t.passRate;
      rows.push({
        arm, split, id: t.id, template: t.template,
        stratum: (meta?.stratum ?? 'canary') as Stratum,
        paraphraseGroup: meta?.paraphraseGroup,
        canary: t.canary, passRate, solved: solvedBy(passRate),
        emptyAnswer: t.attempts.every((a) => (a.answer ?? '').trim() === ''),
        errored: t.attempts.some((a) => !!a.error),
        question: t.question,
      });
    }
  }
  return { rows, reports };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

// ---------------------------------------------------------------------------
// Re-grade mode
// ---------------------------------------------------------------------------

function regrade(dirs: string[]) {
  for (const dir of dirs) {
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf-8')) as Report;
    // bench/jobs/<x> -> bench ; verification_bench/jobs/<x> -> verification_bench
    const root = dirname(dirname(dir));
    const checks = new Map<string, Check>();
    const p = join(root, 'tasks', `${report.split}.jsonl`);
    for (const line of readFileSync(p, 'utf-8').trim().split('\n')) {
      const t = JSON.parse(line) as { id: string; check: Check };
      checks.set(t.id, t.check);
    }

    let flips = 0;
    const changed: string[] = [];
    const before: number[] = [];
    const after: number[] = [];
    let canaryBefore = true;
    let canaryAfter = true;
    for (const t of report.qa?.tasks ?? []) {
      const check = checks.get(t.id);
      if (!check || check.type === 'judge') {
        if (t.canary) { canaryBefore &&= t.passRate === 1; canaryAfter &&= t.passRate === 1; }
        continue;
      }
      let passes = 0;
      for (const a of t.attempts) {
        const now = a.error && !a.answer ? false : gradeDeterministicV2(check, a.answer).pass;
        const was = a.error && !a.answer ? false : gradeDeterministic(check, a.answer).pass;
        if (now !== was) {
          flips++;
          changed.push(`    ${t.id} ${t.template}: ${was} -> ${now}  ${JSON.stringify(a.answer.slice(-90))}`);
        }
        if (now) passes++;
      }
      const rate = passes / t.attempts.length;
      if (t.kind !== 'semantic') { before.push(t.passRate); after.push(rate); }
      if (t.canary) { canaryBefore &&= t.passRate === 1; canaryAfter &&= rate === 1; }
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    console.log(`\n${basename(dir)}  (${report.split}, ${report.qa?.tasks.length ?? 0} tasks)`);
    console.log(`  deterministic: ${pct(mean(before))} -> ${pct(mean(after))}   attempts flipped: ${flips}`);
    console.log(`  canaryPass:    ${canaryBefore} -> ${canaryAfter}`);
    for (const c of changed) console.log(c);
  }
}

// ---------------------------------------------------------------------------
// Main report
// ---------------------------------------------------------------------------

function report(armFilter?: string[]) {
  const { rows, reports } = loadRows(armFilter);
  if (rows.length === 0) {
    console.log('No v2 jobs found. Jobs must be named <arm>__<split>, e.g. A-baseline__skl-dev.');
    return;
  }
  const arms = [...new Set(rows.map((r) => r.arm))].sort();
  const splits = [...new Set(rows.map((r) => r.split))].sort();

  // --- integrity ----------------------------------------------------------
  console.log('='.repeat(78));
  console.log('INTEGRITY');
  console.log('='.repeat(78));
  for (const r of reports) {
    const flags: string[] = [];
    if (!r.valid) flags.push(`INVALID: ${r.invalidReason}`);
    if (r.config.stage === 'qa' && !r.graphProvenance) flags.push('QA-only run with NO graph provenance');
    if (r.qa && !(r.score?.canaryPass as boolean)) flags.push('CANARY FAILED — harness broken, not the agent');
    console.log(`  ${r.job.padEnd(30)} sut=${r.sut.hash} stage=${r.config.stage.padEnd(6)} ` +
      `graphFrom=${r.graphProvenance?.sutHash ?? '(self)'}  ${flags.length ? '!! ' + flags.join('; ') : 'ok'}`);
  }
  // A true-zero question passes by NOT citing an issue, so a silent arm could
  // ace the exact stratum built to catch it. grade-v2 rejects silence; this
  // names any that slipped through anyway.
  const suspicious = rows.filter((r) => r.stratum === 'true_zero' && r.solved && (r.emptyAnswer || r.errored));
  if (suspicious.length) {
    console.log(`\n  !! ${suspicious.length} true_zero pass(es) came from an empty or errored answer:`);
    for (const s of suspicious) console.log(`     ${s.arm} ${s.split} ${s.id}`);
  }

  // --- per-arm, per-stratum ----------------------------------------------
  console.log(`\n${'='.repeat(78)}`);
  console.log(`PER-STRATUM ACCURACY  (solved = majority of attempts; Wilson 95% CI)`);
  console.log('='.repeat(78));
  const head = ['stratum'.padEnd(14), ...arms.map((a) => a.padEnd(22))].join(' ');
  console.log(head);
  for (const s of STRATA) {
    const cells = arms.map((a) => {
      const xs = rows.filter((r) => r.arm === a && r.stratum === s);
      if (xs.length === 0) return '—'.padEnd(22);
      const k = xs.filter((r) => r.solved).length;
      const [lo, hi] = wilson(k, xs.length);
      return `${pct(k / xs.length).padStart(7)} [${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}] n=${xs.length}`.padEnd(22);
    });
    console.log([s.padEnd(14), ...cells].join(' '));
  }
  const overall = arms.map((a) => {
    const xs = rows.filter((r) => r.arm === a);
    return `${pct(xs.filter((r) => r.solved).length / xs.length).padStart(7)} n=${xs.length}`.padEnd(22);
  });
  console.log(['OVERALL'.padEnd(14), ...overall].join(' '));

  // --- contrasts ----------------------------------------------------------
  console.log(`\n${'='.repeat(78)}`);
  console.log('PAIRED CONTRASTS');
  console.log('='.repeat(78));
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const [x, y] = [arms[i], arms[j]];
      const keyed = (arm: string) => new Map(rows.filter((r) => r.arm === arm).map((r) => [`${r.split}/${r.id}`, r]));
      const [mx, my] = [keyed(x), keyed(y)];
      const keys = [...mx.keys()].filter((k) => my.has(k)).sort();
      if (keys.length === 0) continue;

      const ax: number[] = keys.map((k) => (mx.get(k)!.solved ? 1 : 0));
      const ay: number[] = keys.map((k) => (my.get(k)!.solved ? 1 : 0));
      const gained = keys.filter((k) => !mx.get(k)!.solved && my.get(k)!.solved);
      const lost = keys.filter((k) => mx.get(k)!.solved && !my.get(k)!.solved);
      const p = mcnemarExact(lost.length, gained.length);
      const [lo, hi] = pairedBootstrap(ax, ay);
      const d = ay.reduce((a, b) => a + b, 0) / keys.length - ax.reduce((a, b) => a + b, 0) / keys.length;

      console.log(`\n  ${x}  ->  ${y}      (${keys.length} paired questions)`);
      console.log(`    accuracy ${pct(ax.reduce((a, b) => a + b, 0) / keys.length)} -> ` +
        `${pct(ay.reduce((a, b) => a + b, 0) / keys.length)}   ` +
        `diff ${(d * 100 >= 0 ? '+' : '')}${(d * 100).toFixed(2)}pp  ` +
        `[${(lo * 100).toFixed(2)}, ${(hi * 100).toFixed(2)}] bootstrap 95%`);
      console.log(`    McNemar exact: gained ${gained.length}, lost ${lost.length}, p = ${p < 1e-4 ? p.toExponential(2) : p.toFixed(4)}`);

      const byStratum = new Map<string, { g: number; l: number }>();
      for (const k of gained) {
        const s = my.get(k)!.stratum;
        byStratum.set(s, { g: (byStratum.get(s)?.g ?? 0) + 1, l: byStratum.get(s)?.l ?? 0 });
      }
      for (const k of lost) {
        const s = mx.get(k)!.stratum;
        byStratum.set(s, { g: byStratum.get(s)?.g ?? 0, l: (byStratum.get(s)?.l ?? 0) + 1 });
      }
      if (byStratum.size) {
        console.log(`    flips by stratum: ${[...byStratum].sort()
          .map(([s, v]) => `${s} +${v.g}/-${v.l}`).join('  ')}`);
      }
      for (const k of [...gained, ...lost].slice(0, 20)) {
        const dir = gained.includes(k) ? 'FIXED     ' : 'REGRESSED ';
        const r = my.get(k)!;
        console.log(`      ${dir} [${r.stratum}] ${k} ${r.template} — ${r.question.slice(0, 62)}`);
      }
    }
  }

  // --- paraphrase ---------------------------------------------------------
  const groups = [...new Set(rows.filter((r) => r.paraphraseGroup).map((r) => r.paraphraseGroup!))].sort();
  if (groups.length) {
    console.log(`\n${'='.repeat(78)}`);
    console.log('PARAPHRASE SENSITIVITY  (same question, different words)');
    console.log('='.repeat(78));
    for (const arm of arms) {
      let disagreeing = 0;
      let total = 0;
      for (const split of splits) {
        for (const g of groups) {
          const xs = rows.filter((r) => r.arm === arm && r.split === split && r.paraphraseGroup === g);
          if (xs.length < 2) continue;
          total++;
          if (new Set(xs.map((r) => r.solved)).size > 1) disagreeing++;
        }
      }
      console.log(`  ${arm.padEnd(24)} ${disagreeing}/${total} groups where wording changed the outcome`);
    }
  }

  // --- cost ---------------------------------------------------------------
  const spend = reports.reduce((s, r) => s + (r.cost?.sutTotalUsd ?? 0) + (r.cost?.judgeUsd ?? 0), 0);
  console.log(`\ntotal metered spend across ${reports.length} run(s): $${spend.toFixed(2)}\n`);
}

// ---------------------------------------------------------------------------

const ri = process.argv.indexOf('--regrade');
if (ri >= 0) {
  regrade(process.argv.slice(ri + 1).filter((a) => !a.startsWith('--')));
} else {
  const ai = process.argv.indexOf('--arms');
  report(ai >= 0 ? process.argv[ai + 1].split(',') : undefined);
}

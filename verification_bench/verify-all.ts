/**
 * The gate for verification_bench. Free checks in the ONE order that works,
 * then optionally a scored run.
 *
 *   bun verification_bench/verify-all.ts
 *   bun verification_bench/verify-all.ts --job head --attempts 3
 *
 * Same ordering hazard as bench/: `bun test bench/` resets the graph, so it
 * must run BEFORE the checks that need an ingested one.
 *
 * What is NOT re-checked here, deliberately: the runner's own plumbing
 * (verify-offline / verify-paths in bench/). run.ts and preflight.ts here are
 * mechanically derived from bench/'s, which those checks already cover, and
 * step 1 proves the copies have not drifted. What IS new — the corpus, the
 * question set, its oracles, and SUT_DIR switching — is checked below.
 *
 * Stops at the first failure. A non-zero exit means do not trust any score.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');

const argv = process.argv.slice(2);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const job = value('--job');
const attempts = value('--attempts');
const split = value('--split') ?? 'dev';

interface Step {
  name: string;
  cmd: string[];
  why: string;
  env?: Record<string, string>;
}

/**
 * Historical versions live in git, not in duplicate folders. Materialise the
 * one you want to score and its steps switch on automatically:
 *
 *   git worktree add .worktrees/baseline <baseline commit>
 *
 * Steps for a tree that is not present are skipped with a note rather than
 * failing — you only gate what you intend to run.
 */
const BASELINE = '.worktrees/baseline/github_issue';
const haveBaseline = existsSync(join(ROOT, BASELINE, 'package.json'));

const steps: Step[] = [
  {
    name: 'derived',
    cmd: ['bun', join(HERE, 'derive.ts'), '--check'],
    why: 'the files copied from bench/ have not drifted',
  },
  {
    name: 'sut-pinning',
    cmd: ['bun', join(HERE, 'verify-sut-switch.ts')],
    why: 'SUT_DIR selects two distinct trees, both matching the campaign fingerprints',
  },
  {
    name: 'typecheck:head',
    cmd: ['bun', 'x', 'tsc', '--noEmit', '-p', join(ROOT, 'github_issue', 'tsconfig.json')],
    why: 'the working tree must compile',
  },
  ...(haveBaseline
    ? [
        {
          name: 'typecheck:baseline',
          cmd: ['bun', 'x', 'tsc', '--noEmit', '-p', join(ROOT, BASELINE, 'tsconfig.json')],
          why: 'the baseline worktree must compile',
        },
      ]
    : []),
  {
    name: 'typecheck:bench',
    cmd: ['bun', 'x', 'tsc', '--noEmit', '-p', join(HERE, 'tsconfig.json')],
    why: 'this harness must compile',
  },
  {
    name: 'test:harness',
    cmd: ['bun', 'test', join(ROOT, 'bench')],
    why: 'the shared meters, graders and integrity checks — RESETS THE GRAPH',
  },
  ...(haveBaseline
    ? [
        {
          name: 'smoke:baseline',
          cmd: ['bun', join(HERE, 'smoke.ts'), '--split', split],
          why: 'the baseline ingests this corpus correctly (serial writes)',
          env: { SUT_DIR: `../${BASELINE}` },
        },
        {
          name: 'oracles:baseline',
          cmd: ['bun', join(HERE, 'verify-oracles.ts'), '--split', split],
          why: 'every frozen answer re-derives from the baseline-built graph',
          env: { SUT_DIR: `../${BASELINE}` },
        },
      ]
    : []),
  {
    name: 'smoke:head',
    cmd: ['bun', join(HERE, 'smoke.ts'), '--split', split],
    why: 'the working tree ingests this corpus correctly — leaves it ingested',
    env: { SUT_DIR: '../github_issue' },
  },
  {
    name: 'oracles:head',
    cmd: ['bun', join(HERE, 'verify-oracles.ts'), '--split', split],
    why: 'every frozen answer re-derives from the graph it built',
    env: { SUT_DIR: '../github_issue' },
  },
];

if (job) {
  steps.push({
    name: 'scored-run',
    cmd: [
      'bun',
      join(HERE, 'run.ts'),
      '--split',
      split,
      '--job',
      job,
      ...(attempts ? ['--attempts', attempts] : []),
    ],
    why: 'the measurement itself — costs money',
  });
}

if (!haveBaseline) {
  console.log(`note: ${BASELINE} not materialised — baseline steps skipped.`);
  console.log('      git worktree add .worktrees/baseline <baseline commit>\n');
}
console.log(`gate: ${steps.length} steps${job ? ` then a scored run "${job}"` : ' (free only)'}\n`);

const results: { name: string; ok: boolean; ms: number }[] = [];
let failed: Step | null = null;

for (const step of steps) {
  process.stdout.write(`▶ ${step.name.padEnd(18)} ${step.why}\n`);
  const t0 = performance.now();
  const proc = Bun.spawn(step.cmd, {
    cwd: ROOT,
    env: { ...process.env, ...(step.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  const ms = performance.now() - t0;
  const ok = code === 0;
  results.push({ name: step.name, ok, ms });

  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${step.name} (${(ms / 1000).toFixed(1)}s)`);
  if (!ok) {
    console.log(`\n--- ${step.name} output (tail) ---`);
    console.log(`${out.trim().split('\n').slice(-40).join('\n')}`);
    if (err.trim()) console.log(`--- stderr ---\n${err.trim().slice(-2000)}`);
    failed = step;
    break;
  }
}

console.log('\n────────────────────────────────');
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(18)} ${(r.ms / 1000).toFixed(1)}s`);
if (failed) {
  console.log(`\ngate FAILED at "${failed.name}" — no score from this cycle is trustworthy.`);
  process.exit(1);
}
console.log(
  job
    ? `\ngate PASSED and "${job}" measured. Read it:\n  bun bench/summarize.ts ../verification_bench/jobs/${job}`
    : '\ngate PASSED. Nothing was spent; add --job <name> to measure.',
);

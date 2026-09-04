/**
 * The gate. Runs every free check in the ONE order that works, then optionally
 * a scored run.
 *
 *   bun bench/verify-all.ts                   # free gate only (~4 min, $0)
 *   bun bench/verify-all.ts --deep            # + the slower path checks
 *   bun bench/verify-all.ts --job h1          # gate, then a scored dev run
 *   bun bench/verify-all.ts --job h1 --attempts 3
 *
 * Order matters and is not obvious: `bun test bench/` resets the graph, so it
 * has to run BEFORE the checks that need an ingested one. Running them the
 * other way round produces a confident wall of failures that look like SUT
 * regressions. That is the whole reason this script exists — run it instead of
 * remembering the order.
 *
 * Stops at the first failure. A non-zero exit means do not trust any score.
 */

import { join } from 'node:path';

const BENCH = import.meta.dirname;
const ROOT = join(BENCH, '..');

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

interface Step {
  name: string;
  cmd: string[];
  why: string;
}

const job = value('--job');
const attempts = value('--attempts');

const steps: Step[] = [
  {
    name: 'typecheck:sut',
    cmd: ['bun', 'x', 'tsc', '--noEmit', '-p', join(ROOT, 'github_issue', 'tsconfig.json')],
    why: 'the system under test must compile',
  },
  {
    name: 'typecheck:bench',
    cmd: ['bun', 'x', 'tsc', '--noEmit', '-p', join(BENCH, 'tsconfig.json')],
    why: 'the harness must compile',
  },
  {
    name: 'test:sut',
    cmd: ['bun', 'run', 'test:unit'],
    why: "the SUT's own unit tests",
  },
  {
    name: 'test:harness',
    cmd: ['bun', 'test', 'bench/'],
    why: 'meters, graders and integrity checks — RESETS THE GRAPH',
  },
  {
    name: 'smoke',
    cmd: ['bun', join(BENCH, 'smoke.ts')],
    why: 'real pipeline vs the corpus, analysis off — leaves dev ingested',
  },
  {
    name: 'oracles',
    cmd: ['bun', join(BENCH, 'verify-oracles.ts')],
    why: 'every frozen answer re-derived from the graph (needs the ingest above)',
  },
  {
    name: 'offline-e2e',
    cmd: ['bun', join(BENCH, 'verify-offline.ts')],
    why: 'the real runner end to end against a mock LLM',
  },
];

if (flag('--deep')) {
  steps.push({
    name: 'paths',
    cmd: ['bun', join(BENCH, 'verify-paths.ts')],
    why: '--attempts, holdout, --stage, agent-failure handling',
  });
}

if (job) {
  steps.push({
    name: `scored:${job}`,
    cmd: [
      'bun',
      join(BENCH, 'run.ts'),
      '--split',
      value('--split') ?? 'dev',
      '--job',
      job,
      ...(attempts ? ['--attempts', attempts] : []),
    ],
    why: 'the measurement itself — costs money',
  });
}

console.log(`gate: ${steps.length} steps${job ? ` then a scored run "${job}"` : ' (free only)'}\n`);

const results: { name: string; ok: boolean; ms: number }[] = [];
let failed: Step | null = null;

for (const step of steps) {
  process.stdout.write(`▶ ${step.name.padEnd(16)} ${step.why}\n`);
  const t0 = performance.now();
  const proc = Bun.spawn(step.cmd, {
    cwd: step.name === 'test:sut' ? join(ROOT, 'github_issue') : ROOT,
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
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s`);
if (failed) {
  console.log(`\ngate FAILED at "${failed.name}" — no score from this cycle is trustworthy.`);
  process.exit(1);
}
console.log(
  job
    ? `\ngate PASSED and "${job}" measured. Read it:\n  bun bench/summarize.ts jobs/${job}`
    : '\ngate PASSED. Nothing was spent; add --job <name> to measure.',
);

/**
 * Render a benchmark report, or diff two of them.
 *
 *   bun bench/summarize.ts jobs/baseline
 *   bun bench/summarize.ts jobs/baseline jobs/h1     # before -> after, with flips
 *
 * The flip fingerprint (which tasks went fail->pass vs pass->fail) is the part
 * that actually tells you whether a hypothesis worked or whether the score
 * moved for unrelated reasons.
 */

import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const BENCH = import.meta.dirname;

interface TaskRecord {
  id: string;
  template: string;
  kind: string;
  canary: boolean;
  question: string;
  oracle: string;
  passRate: number;
  attempts: { pass: boolean; reason: string; answer: string; toolCalls: unknown[]; ms: number; error?: string }[];
}

interface Report {
  job: string;
  split: string;
  valid: boolean;
  invalidReason: string | null;
  config: Record<string, unknown>;
  sut?: { hash: string; files: number };
  ingest?: {
    durationMs: number;
    pipeline: Record<string, unknown>;
    github: { requests: number; maxConcurrent: number; issueRequests: number; listingRequests: number };
    neo4j: { queries: number; sessions: number; transactions: number; samples: string[] };
    openai: { requests: number; byModel: Record<string, any>; costUsd: number };
  };
  integrity?: { name: string; pass: boolean; expected: string; actual: string; info?: boolean }[];
  qa?: { tasks: TaskRecord[]; neo4j: { queries: number }; openai: { requests: number; costUsd: number }; judgeCostUsd: number };
  score?: Record<string, any>;
  cost?: Record<string, number>;
  trace?: { files: string[]; spans: number; byName: Record<string, { count: number; totalMs: number; maxMs: number; errors: number }> } | null;
}

function load(p: string): Report {
  const path = isAbsolute(p) ? p : join(BENCH, p.replace(/^bench\//, ''));
  const file = path.endsWith('.json') ? path : join(path, 'report.json');
  return JSON.parse(readFileSync(file, 'utf-8')) as Report;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(4)}`;

function renderOne(r: Report) {
  console.log(`# ${r.job} — split \`${r.split}\`${r.valid ? '' : '  **INVALID**'}`);
  if (!r.valid) console.log(`\n> INVALID: ${r.invalidReason}\n`);
  if (r.sut) console.log(`\nSUT fingerprint \`${r.sut.hash}\` (${r.sut.files} files)`);

  if (r.score) {
    console.log('\n## Score\n');
    console.log('| Metric | Value |');
    console.log('|---|---|');
    console.log(`| **overall** | **${pct(r.score.overall)}** |`);
    console.log(`| deterministic (structural+retrieval) | ${pct(r.score.deterministic)} |`);
    console.log(`| semantic (judge) | ${pct(r.score.semantic)} |`);
    console.log(`| solved on every attempt | ${r.score.solvedAllAttempts}/${r.score.totalTasks} |`);
    console.log(`| solved on ≥1 attempt | ${r.score.solvedAnyAttempt}/${r.score.totalTasks} |`);
    console.log(`| canaries | ${r.score.canaryPass ? 'pass' : '**FAIL**'} |`);
    console.log(`| tool-use rate | ${pct(r.score.toolUseRate)} |`);
    console.log(`| agent error rate | ${pct(r.score.agentErrorRate)} |`);
  }

  if (r.ingest) {
    const g = r.ingest.github;
    console.log('\n## Ingestion\n');
    console.log('| Metric | Value |');
    console.log('|---|---|');
    console.log(`| wall clock | ${(r.ingest.durationMs / 1000).toFixed(1)}s |`);
    console.log(`| GitHub requests | ${g.requests} (listing ${g.listingRequests}, issue ${g.issueRequests}) |`);
    console.log(`| fetch max concurrency | ${g.maxConcurrent}${g.maxConcurrent === 1 ? ' (fully serial)' : ''} |`);
    console.log(`| Neo4j statements | ${r.ingest.neo4j.queries} (sessions ${r.ingest.neo4j.sessions}, tx ${r.ingest.neo4j.transactions}) |`);
    console.log(`| OpenAI requests | ${r.ingest.openai.requests} |`);
    for (const [m, u] of Object.entries(r.ingest.openai.byModel)) {
      console.log(`| — ${m} | ${u.requests} reqs, ${u.promptTokens.toLocaleString()} in / ${u.completionTokens.toLocaleString()} out |`);
    }
    console.log(`| ingestion cost | ${usd(r.ingest.openai.costUsd)} |`);
    const p = r.ingest.pipeline as any;
    console.log(`| pipeline errors | ${(p?.errors?.length ?? 0)} |`);
  }

  if (r.cost) {
    console.log('\n## Cost\n');
    console.log(`ingest ${usd(r.cost.ingestUsd)} + QA ${usd(r.cost.qaUsd)} = **SUT ${usd(r.cost.sutTotalUsd)}**  (judge overhead ${usd(r.cost.judgeUsd)}, not charged to the SUT)`);
  }

  if (r.integrity) {
    const failed = r.integrity.filter((c) => !c.pass && !c.info);
    console.log(`\n## Integrity — ${failed.length === 0 ? 'all pass' : `**${failed.length} FAILING**`}\n`);
    if (failed.length) {
      console.log('| Check | Expected | Actual |');
      console.log('|---|---|---|');
      for (const c of failed) console.log(`| \`${c.name}\` | ${c.expected} | ${c.actual} |`);
    }
    const info = r.integrity.filter((c) => c.info);
    if (info.length) {
      console.log('\nGraph shape: ' + info.map((c) => `${c.name}=${c.actual}`).join(', '));
    }
  }

  if (r.trace) {
    console.log(`\n## Trace — ${r.trace.spans} spans\n`);
    console.log('| Operation | Calls | Total | Max | Errors |');
    console.log('|---|---|---|---|---|');
    for (const [name, v] of Object.entries(r.trace.byName)) {
      console.log(`| \`${name}\` | ${v.count} | ${(v.totalMs / 1000).toFixed(2)}s | ${v.maxMs}ms | ${v.errors || ''} |`);
    }
    // The SUT's own tracing and the harness meter count GitHub calls
    // independently; the harness makes none of its own, so they must agree.
    const traced = r.trace.byName['github.graphql']?.count;
    const metered = r.ingest?.github.requests;
    if (traced !== undefined && metered !== undefined && traced !== metered) {
      console.log(
        `\n> **Instrumentation disagreement**: tracing saw ${traced} GitHub calls, the harness meter saw ${metered}. One of them is wrong — do not trust this run's ingestion numbers.`,
      );
    }
  }

  if (r.qa) {
    console.log('\n## Tasks\n');
    console.log('| Task | Template | Kind | Pass | Expected | Failure reason |');
    console.log('|---|---|---|---|---|---|');
    for (const t of r.qa.tasks) {
      const mark = t.passRate === 1 ? '✅' : t.passRate === 0 ? '❌' : `⚠️ ${pct(t.passRate)}`;
      const reason = t.passRate === 1 ? '' : (t.attempts.find((a) => !a.pass)?.reason ?? '').slice(0, 90);
      console.log(`| \`${t.id}\`${t.canary ? ' 🐤' : ''} | ${t.template} | ${t.kind} | ${mark} | ${t.oracle.slice(0, 40)} | ${reason} |`);
    }

    const failing = r.qa.tasks.filter((t) => t.passRate < 1);
    if (failing.length) {
      console.log('\n## Failing task details\n');
      for (const t of failing) {
        const a = t.attempts.find((x) => !x.pass)!;
        console.log(`### \`${t.id}\` ${t.template}`);
        console.log(`- **Q**: ${t.question}`);
        console.log(`- **Expected**: ${t.oracle}`);
        console.log(`- **Why it failed**: ${a.reason}`);
        const cypher = a.toolCalls
          .map((c: any) => (typeof c?.input?.cypher === 'string' ? c.input.cypher.replace(/\s+/g, ' ').trim() : null))
          .filter(Boolean);
        if (cypher.length) console.log(`- **Cypher run**: \`${cypher.join('` / `')}\``);
        if (a.error) console.log(`- **Agent error**: ${a.error}`);
        console.log(`- **Answer**: ${a.answer.replace(/\n/g, ' ').slice(0, 300)}`);
        console.log('');
      }
    }
  }
}

function renderDiff(before: Report, after: Report) {
  console.log(`# ${before.job} → ${after.job}\n`);
  if (!before.valid || !after.valid) {
    console.log('> One of these runs is INVALID; the comparison is meaningless.\n');
  }

  const rows: [string, string, string, string][] = [];
  const cmp = (label: string, b: number | undefined, a: number | undefined, fmt: (n: number) => string, lowerBetter = false) => {
    if (b === undefined || a === undefined) return;
    const d = a - b;
    const better = lowerBetter ? d < 0 : d > 0;
    const arrow = d === 0 ? '=' : better ? '▲' : '▼';
    rows.push([label, fmt(b), fmt(a), `${arrow} ${d > 0 ? '+' : ''}${fmt(d)}`]);
  };

  cmp('score (overall)', before.score?.overall, after.score?.overall, pct);
  cmp('score (deterministic)', before.score?.deterministic, after.score?.deterministic, pct);
  cmp('score (semantic)', before.score?.semantic, after.score?.semantic, pct);
  cmp('ingest wall clock (s)', before.ingest && before.ingest.durationMs / 1000, after.ingest && after.ingest.durationMs / 1000, (n) => n.toFixed(1), true);
  cmp('GitHub requests', before.ingest?.github.requests, after.ingest?.github.requests, String, true);
  cmp('fetch max concurrency', before.ingest?.github.maxConcurrent, after.ingest?.github.maxConcurrent, String);
  cmp('Neo4j statements (ingest)', before.ingest?.neo4j.queries, after.ingest?.neo4j.queries, String, true);
  cmp('OpenAI requests (ingest)', before.ingest?.openai.requests, after.ingest?.openai.requests, String, true);
  cmp('ingest cost', before.ingest?.openai.costUsd, after.ingest?.openai.costUsd, usd, true);
  cmp('SUT total cost', before.cost?.sutTotalUsd, after.cost?.sutTotalUsd, usd, true);
  for (const op of ['pipeline.ingest', 'pipeline.fetch', 'pipeline.analyzeIssue', 'neo4j.query']) {
    cmp(
      `trace: ${op} total (s)`,
      before.trace?.byName[op] && before.trace.byName[op].totalMs / 1000,
      after.trace?.byName[op] && after.trace.byName[op].totalMs / 1000,
      (n) => n.toFixed(2),
      true,
    );
  }

  console.log('| Metric | Before | After | Δ |');
  console.log('|---|---|---|---|');
  for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);

  const bMap = new Map((before.qa?.tasks ?? []).map((t) => [t.id, t]));
  const aMap = new Map((after.qa?.tasks ?? []).map((t) => [t.id, t]));
  const fixed: string[] = [];
  const broken: string[] = [];
  const stillFailing: string[] = [];
  for (const [id, a] of aMap) {
    const b = bMap.get(id);
    if (!b) continue;
    if (b.passRate < 1 && a.passRate === 1) fixed.push(`${id} (${a.template})`);
    else if (b.passRate === 1 && a.passRate < 1) broken.push(`${id} (${a.template})`);
    else if (b.passRate < 1 && a.passRate < 1) stillFailing.push(`${id} (${a.template})`);
  }

  console.log('\n## Flip fingerprint\n');
  console.log(`- **fixed (${fixed.length})**: ${fixed.join(', ') || '—'}`);
  console.log(`- **regressed (${broken.length})**: ${broken.join(', ') || '—'}`);
  console.log(`- **still failing (${stillFailing.length})**: ${stillFailing.join(', ') || '—'}`);
  if (broken.length > 0) {
    console.log('\n> A net gain with regressions needs an n≥3 re-run before you keep it — at this sample size single flips are noise.');
  }

  const bad = (after.integrity ?? []).filter((c) => !c.pass && !c.info);
  if (bad.length) {
    console.log(`\n## Integrity regressions in ${after.job}\n`);
    for (const c of bad) console.log(`- \`${c.name}\`: expected ${c.expected}, got ${c.actual}`);
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: bun bench/summarize.ts jobs/<name> [jobs/<other>]');
  process.exit(1);
} else if (argv.length === 1) {
  renderOne(load(argv[0]));
} else {
  renderDiff(load(argv[0]), load(argv[1]));
}

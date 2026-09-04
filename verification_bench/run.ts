/**
 * GitHub Issue Analyzer benchmark runner.
 *
 *   SUT_DIR=../github_issue bun verification_bench/run.ts --split dev --job head --attempts 3
 *   SUT_DIR=../.worktrees/baseline/github_issue bun verification_bench/run.ts --split dev --job base --attempts 3
 *
 * DERIVED FROM bench/run.ts BY verification_bench/derive.ts — DO NOT EDIT.
 *
 * Measures the system in github_issue/ end to end:
 *   ingestion  — latency, GitHub requests, fetch concurrency, Neo4j roundtrips,
 *                OpenAI calls and cost, graph integrity
 *   agent QA   — accuracy on a frozen question set with computed answers
 *
 * Writes verification_bench/jobs/<job>/report.json. Nothing in github_issue/ is modified.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import type { Corpus } from '../bench/scripts/build-corpus';
import type { Task } from '../bench/scripts/build-tasks';
import { startFakeGitHub } from '../bench/harness/fake-github';
import { costOf, installOpenAIMeter, meterDriver, priceOf, type OpenAIStats } from '../bench/harness/instrument';
import { createJudge, gradeDeterministic, type Grade } from '../bench/harness/grade';
import { checkIntegrity, resetDatabase, startNeo4j, BOLT_URI, type IntegrityCheck } from './neo4j';
import { loadEnv, preflight, reportPreflight } from './preflight';

const BENCH = import.meta.dirname;
// Which implementation is under test. Defaults to the champion tree so a
// bare invocation behaves like bench/; set SUT_DIR to score another copy.
const SUT = resolve(BENCH, process.env.SUT_DIR ?? join('..', 'github_issue'));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function args() {
  const a = process.argv.slice(2);
  const get = (flag: string, dflt?: string) => {
    const i = a.indexOf(flag);
    return i === -1 ? dflt : a[i + 1];
  };
  const has = (flag: string) => a.includes(flag);
  return {
    split: get('--split', 'dev')!,
    job: get('--job', `run-${Date.now()}`)!,
    stage: get('--stage', 'all') as 'all' | 'ingest' | 'qa',
    attempts: Number(get('--attempts', '1')),
    latencyMs: Number(get('--latency-ms', '120')),
    qaConcurrency: Number(get('--qa-concurrency', '3')),
    keepGraph: has('--keep-graph'),
    noTypecheck: has('--no-typecheck'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash of every SUT source file, so a score can be tied to exact code. */
function fingerprintSut(): { hash: string; files: number } {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
        walk(p);
      } else if (/\.(ts|json|yml)$/.test(entry)) {
        files.push(p);
      }
    }
  };
  for (const d of ['src', 'agent', 'ingestion']) walk(join(SUT, d));
  // package.json pins "latest" for the Mastra packages, so the lockfile is the
  // only record of which agent framework a score was measured against.
  for (const f of ['package.json', 'bun.lock']) {
    if (existsSync(join(SUT, f))) files.push(join(SUT, f));
  }
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(SUT, f));
    h.update(readFileSync(f));
  }
  return { hash: h.digest('hex').slice(0, 16), files: files.length };
}

const snapshot = (s: OpenAIStats) => JSON.parse(JSON.stringify(s)) as OpenAIStats;

/**
 * Fold this run's spans into per-operation totals. The counts come from the
 * SUT's own tracing, independently of the harness meters — if the two ever
 * disagree, one of them is wrong and the run deserves a look.
 */
function summarizeTrace(dir: string): Record<string, unknown> | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) return null;

  const byName = new Map<string, { count: number; totalMs: number; errors: number; max: number }>();
  let spans = 0;
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let rec: { name: string; durationMs: number; status: string };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      spans++;
      const e = byName.get(rec.name) ?? { count: 0, totalMs: 0, errors: 0, max: 0 };
      e.count++;
      e.totalMs += rec.durationMs;
      e.max = Math.max(e.max, rec.durationMs);
      if (rec.status === 'ERROR') e.errors++;
      byName.set(rec.name, e);
    }
  }

  return {
    files,
    spans,
    byName: Object.fromEntries(
      [...byName.entries()]
        .sort((a, b) => b[1].totalMs - a[1].totalMs)
        .map(([name, v]) => [
          name,
          { count: v.count, totalMs: Math.round(v.totalMs), maxMs: Math.round(v.max), errors: v.errors },
        ]),
    ),
  };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

interface AttemptRecord {
  pass: boolean;
  reason: string;
  answer: string;
  toolCalls: { tool: string; input: unknown }[];
  usage: { input: number; output: number } | null;
  ms: number;
  error?: string;
}

interface TaskRecord {
  id: string;
  template: string;
  kind: Task['kind'];
  canary: boolean;
  question: string;
  oracle: string;
  attempts: AttemptRecord[];
  passRate: number;
}

// ---------------------------------------------------------------------------

async function main() {
  const opt = args();
  const jobDir = join(BENCH, 'jobs', opt.job);
  mkdirSync(jobDir, { recursive: true });
  const startedAt = new Date().toISOString();

  console.log('========================================');
  console.log(` benchmark: ${opt.job}  split=${opt.split}  stage=${opt.stage}  attempts=${opt.attempts}`);
  console.log('========================================');

  // Install the meter before anything else can make a request.
  const meter = installOpenAIMeter();
  const envPath = loadEnv();
  console.log(`  env: ${envPath ?? 'no github_issue/.env found'}`);

  const corpus = JSON.parse(
    readFileSync(join(BENCH, 'corpus', `${opt.split}.json`), 'utf-8'),
  ) as Corpus;
  const tasks = readFileSync(join(BENCH, 'tasks', `${opt.split}.jsonl`), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Task);

  console.log('\nPreflight:');
  const pre = await preflight({ split: opt.split, meter, typecheck: !opt.noTypecheck });
  if (!reportPreflight(pre)) {
    writeFileSync(
      join(jobDir, 'report.json'),
      JSON.stringify({ job: opt.job, valid: false, invalidReason: 'preflight failed', preflight: pre }, null, 2),
    );
    console.error('\nPreflight FAILED — aborting before spending anything. See report.json.');
    process.exit(2);
  }
  meter.reset();

  const sut = fingerprintSut();
  console.log(`\n  SUT fingerprint: ${sut.hash} (${sut.files} files)`);

  // Keep each run's spans with its report, so a score and the trace that
  // produced it never drift apart. Clear first: re-running a job name
  // overwrites report.json, so leaving old trace files behind would make
  // .trace double-count across runs that no longer exist.
  const traceDir = join(jobDir, 'traces');
  rmSync(traceDir, { recursive: true, force: true });
  process.env.TRACE_DIR = traceDir;

  // --- environment the SUT will see ---------------------------------------
  await startNeo4j();
  process.env.NEO4J_URI = BOLT_URI;
  process.env.NEO4J_AUTH = 'none';
  process.env.GITHUB_TOKEN ||= 'bench-fixture-token';

  const github = startFakeGitHub(corpus, { latencyMs: opt.latencyMs });
  process.env.GITHUB_API_URL = github.url;
  console.log(`  fake GitHub: ${github.url} (+${opt.latencyMs}ms/request)`);

  // Imported after env is set — src/services/github.ts reads GITHUB_API_URL at
  // module load, and the driver singleton must be metered from its first use.
  const { getDriver, closeDriver } = await import(join(SUT, 'src/services/neo4j.ts'));
  const { runPipeline } = await import(join(SUT, 'src/services/pipeline.ts'));
  const { INSTRUCTIONS, MODEL, TOOLS } = await import(join(SUT, 'agent/config.ts'));
  const { Agent } = await import('@mastra/core/agent');

  const driver = getDriver();
  const neo = meterDriver(driver);

  const report: Record<string, unknown> = {
    job: opt.job,
    split: opt.split,
    startedAt,
    valid: true,
    invalidReason: null as string | null,
    config: { ...opt, model: MODEL, judgeModel: 'gpt-4o', corpusIssues: corpus.issues.length, tasks: tasks.length },
    sut,
    preflight: pre,
  };

  try {
    // =====================================================================
    // Ingestion
    // =====================================================================
    if (opt.stage === 'all' || opt.stage === 'ingest') {
      if (!opt.keepGraph) {
        console.log('\nResetting graph...');
        await resetDatabase(driver);
      }
      neo.reset();
      github.reset();
      meter.reset();

      console.log(`\nIngesting ${corpus.issues.length} issues...`);
      const t0 = performance.now();
      let pipelineResult: Record<string, unknown>;
      try {
        pipelineResult = await runPipeline({
          owner: corpus.meta.owner,
          repo: corpus.meta.repo,
          state: 'all',
          limit: 0,
          analyze: true,
          fullSync: true,
        });
      } catch (err) {
        report.valid = false;
        report.invalidReason = `pipeline threw: ${err instanceof Error ? err.message : String(err)}`;
        throw err;
      }
      const durationMs = performance.now() - t0;

      report.ingest = {
        durationMs: Math.round(durationMs),
        pipeline: pipelineResult,
        github: { ...github.stats, busyMs: Math.round(github.stats.busyMs) },
        neo4j: { ...neo.stats, samples: neo.stats.samples.slice(0, 200) },
        openai: { ...snapshot(meter.stats), costUsd: meter.costUsd() },
      };
      console.log(
        `  ingest: ${(durationMs / 1000).toFixed(1)}s | github reqs=${github.stats.requests} maxConcurrent=${github.stats.maxConcurrent} | ` +
          `neo4j queries=${neo.stats.queries} | openai reqs=${meter.stats.requests} $${meter.costUsd().toFixed(4)}`,
      );

      // Stamp which code built this graph, so a later `--stage qa --keep-graph`
      // run can say what it is scoring instead of assuming.
      const stamp = driver.session();
      try {
        await stamp.run(
          `MERGE (m:BenchMeta {key: 'ingest'})
           SET m.sutHash = $hash, m.split = $split, m.job = $job, m.at = $at`,
          { hash: sut.hash, split: opt.split, job: opt.job, at: new Date().toISOString() },
        );
      } finally {
        await stamp.close();
      }
    }

    // =====================================================================
    // Integrity
    // =====================================================================
    const provSession = driver.session();
    try {
      const prov = await provSession.run(
        "MATCH (m:BenchMeta {key: 'ingest'}) RETURN m.sutHash AS hash, m.split AS split, m.job AS job, m.at AS at",
      );
      const rec = prov.records[0];
      report.graphProvenance = rec
        ? { sutHash: rec.get('hash'), split: rec.get('split'), job: rec.get('job'), at: rec.get('at') }
        : null;
      if (opt.stage === 'qa') {
        const p = report.graphProvenance as { sutHash?: string; job?: string } | null;
        console.log(
          p
            ? `\n  graph built by job "${p.job}" from SUT ${p.sutHash}${p.sutHash === sut.hash ? '' : ` (current SUT is ${sut.hash})`}`
            : '\n  WARNING: graph has no provenance stamp — it was not built by this harness.',
        );
      }
    } finally {
      await provSession.close();
    }

    console.log('\nIntegrity:');
    const integrity: IntegrityCheck[] = await checkIntegrity(driver, corpus);
    report.integrity = integrity;
    for (const c of integrity) {
      const tag = c.info ? 'info' : c.pass ? 'ok  ' : 'FAIL';
      console.log(`  ${tag} ${c.name.padEnd(26)} expected=${c.expected} actual=${c.actual}`);
    }

    // A near-empty graph means the run measured nothing — that is a broken run,
    // not a bad score. Duplicates and wrong counts, by contrast, ARE real SUT
    // regressions and must stay in the score.
    const loaded = Number(integrity.find((c) => c.name === 'issue_count')?.actual ?? 0);
    if (loaded < corpus.issues.length * 0.9) {
      report.valid = false;
      report.invalidReason = `graph holds ${loaded}/${corpus.issues.length} issues — nothing meaningful to query`;
    }

    // =====================================================================
    // Agent QA
    // =====================================================================
    if ((opt.stage === 'all' || opt.stage === 'qa') && report.valid) {
      neo.reset();
      const qaOpenAIBefore = meter.costUsd();
      meter.reset();

      console.log(`\nQA: ${tasks.length} tasks x ${opt.attempts} attempt(s), concurrency ${opt.qaConcurrency}`);
      const jobs = tasks.flatMap((t) => Array.from({ length: opt.attempts }, (_, k) => ({ task: t, attempt: k })));

      const raw = await pool(jobs, opt.qaConcurrency, async ({ task }) => {
        const t0 = performance.now();
        const agent = new Agent({
          id: 'bench-github-issue-analyzer',
          name: 'bench-github-issue-analyzer',
          instructions: INSTRUCTIONS,
          model: MODEL,
          tools: TOOLS,
        });
        try {
          const out = await agent.generate(task.question);
          const toolCalls = (out.toolCalls ?? []).map((c: any) => ({
            tool: c.toolName ?? c.payload?.toolName ?? 'unknown',
            input: c.args ?? c.input ?? c.payload?.args ?? null,
          }));
          return {
            answer: String(out.text ?? ''),
            toolCalls,
            usage: out.totalUsage
              ? { input: out.totalUsage.inputTokens ?? 0, output: out.totalUsage.outputTokens ?? 0 }
              : null,
            ms: Math.round(performance.now() - t0),
            error: out.error ? String(out.error) : undefined,
          };
        } catch (err) {
          return {
            answer: '',
            toolCalls: [],
            usage: null,
            ms: Math.round(performance.now() - t0),
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });

      // Token usage is read off the wire, but a streaming model returns SSE and
      // no usage block — which would report QA cost as $0 and read as a huge
      // win. The agent SDK reports authoritative per-run totals, so prefer
      // those whenever the wire came back unmetered.
      const wireCostUsd = meter.costUsd();
      const wireTokens = Object.values(meter.stats.byModel).reduce(
        (t, u) => t + u.promptTokens + u.completionTokens,
        0,
      );
      const unmetered = Object.values(meter.stats.byModel).reduce((t, u) => t + u.unmetered, 0);
      const reported = raw.reduce(
        (acc, r) => ({ input: acc.input + (r.usage?.input ?? 0), output: acc.output + (r.usage?.output ?? 0) }),
        { input: 0, output: 0 },
      );
      const reportedCost = costOf(MODEL, reported.input, reported.output);
      const useReported = wireTokens === 0 && reported.input + reported.output > 0 && reportedCost !== null;
      const qaCostUsd = useReported ? reportedCost! : wireCostUsd;
      const usageSource = useReported ? 'agent-reported (model streamed)' : 'wire';
      if (wireTokens === 0 && !useReported && meter.stats.requests > 0) {
        console.warn(
          `  WARNING: ${meter.stats.requests} QA requests but no token usage from either the wire or the agent — QA cost is not trustworthy.`,
        );
      }
      if (priceOf(MODEL) === null) {
        console.warn(`  WARNING: no price for agent model "${MODEL}" — QA cost undercounted. Add it to PRICES.`);
      }

      const qaOpenAI = { ...snapshot(meter.stats), unmetered, usageSource, reportedTokens: reported };
      const qaNeo = { ...neo.stats, samples: neo.stats.samples.slice(0, 200) };

      // Deterministic grading first (free), judge second (metered separately).
      meter.reset();
      const judge = createJudge('gpt-4o');
      const graded: Grade[] = [];
      for (let i = 0; i < jobs.length; i++) {
        const { task } = jobs[i];
        const r = raw[i];
        if (r.error && !r.answer) {
          graded.push({ pass: false, reason: `agent error: ${r.error}` });
        } else if (task.check.type === 'judge') {
          try {
            graded.push(await judge.grade(task, r.answer));
          } catch (err) {
            graded.push({ pass: false, reason: `judge error: ${err instanceof Error ? err.message : err}` });
          }
        } else {
          graded.push(gradeDeterministic(task.check, r.answer));
        }
      }
      const judgeCostUsd = meter.costUsd();

      const byId = new Map<string, TaskRecord>();
      for (const t of tasks) {
        byId.set(t.id, {
          id: t.id,
          template: t.template,
          kind: t.kind,
          canary: !!t.canary,
          question: t.question,
          oracle: t.oracle,
          attempts: [],
          passRate: 0,
        });
      }
      for (let i = 0; i < jobs.length; i++) {
        const rec = byId.get(jobs[i].task.id)!;
        rec.attempts.push({
          pass: graded[i].pass,
          reason: graded[i].reason,
          answer: raw[i].answer.slice(0, 4000),
          toolCalls: raw[i].toolCalls,
          usage: raw[i].usage,
          ms: raw[i].ms,
          error: raw[i].error,
        });
      }
      for (const rec of byId.values()) {
        rec.passRate = rec.attempts.filter((a) => a.pass).length / rec.attempts.length;
      }

      const records = [...byId.values()];
      const mean = (rs: TaskRecord[]) => (rs.length ? rs.reduce((s, r) => s + r.passRate, 0) / rs.length : 0);
      const deterministic = records.filter((r) => r.kind !== 'semantic');
      const semantic = records.filter((r) => r.kind === 'semantic');
      const canaries = records.filter((r) => r.canary);
      const allAttempts = records.flatMap((r) => r.attempts);

      report.qa = {
        tasks: records,
        openai: { ...qaOpenAI, costUsd: qaCostUsd },
        neo4j: qaNeo,
        judgeCostUsd,
      };
      report.score = {
        overall: mean(records),
        deterministic: mean(deterministic),
        semantic: mean(semantic),
        byKind: {
          structural: mean(records.filter((r) => r.kind === 'structural')),
          retrieval: mean(records.filter((r) => r.kind === 'retrieval')),
          semantic: mean(semantic),
        },
        solvedAllAttempts: records.filter((r) => r.passRate === 1).length,
        solvedAnyAttempt: records.filter((r) => r.passRate > 0).length,
        totalTasks: records.length,
        canaryPass: canaries.every((r) => r.passRate === 1),
        toolUseRate: allAttempts.filter((a) => a.toolCalls.length > 0).length / Math.max(1, allAttempts.length),
        agentErrorRate: allAttempts.filter((a) => a.error).length / Math.max(1, allAttempts.length),
      };
      // A run where most attempts threw measured nothing. Reporting that as a
      // score is precisely how a whole benchmark job gets mistaken for a
      // regression — treat it as a broken run instead.
      const errorRate = (report.score as any).agentErrorRate as number;
      if (errorRate >= 0.5) {
        report.valid = false;
        report.invalidReason = `${Math.round(errorRate * 100)}% of QA attempts threw — the agent could not run, so the score is meaningless`;
      }

      report.cost = {
        ingestUsd: (report.ingest as any)?.openai?.costUsd ?? 0,
        qaUsd: qaCostUsd,
        judgeUsd: judgeCostUsd,
        sutTotalUsd: ((report.ingest as any)?.openai?.costUsd ?? 0) + qaCostUsd,
      };
      void qaOpenAIBefore;
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.trace = summarizeTrace(traceDir);
    writeFileSync(join(jobDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await github.stop();
    try {
      await closeDriver();
    } catch {
      /* already closed */
    }
    meter.uninstall();
  }

  const score = report.score as any;
  console.log('\n========================================');
  if (!report.valid) {
    console.log(` INVALID RUN — ${report.invalidReason}`);
  } else if (score) {
    console.log(` score: ${(score.overall * 100).toFixed(1)}%  (deterministic ${(score.deterministic * 100).toFixed(1)}%, semantic ${(score.semantic * 100).toFixed(1)}%)`);
    console.log(` solved ${score.solvedAllAttempts}/${score.totalTasks} on every attempt, ${score.solvedAnyAttempt}/${score.totalTasks} on at least one`);
    console.log(` canaries: ${score.canaryPass ? 'PASS' : 'FAIL — investigate the harness/graph before trusting this score'}`);
    console.log(` tool use: ${(score.toolUseRate * 100).toFixed(0)}%   agent errors: ${(score.agentErrorRate * 100).toFixed(0)}%`);
  }
  console.log(` report: ${join(jobDir, 'report.json')}`);
  console.log('========================================');

  process.exit(report.valid ? 0 : 3);
}

main();

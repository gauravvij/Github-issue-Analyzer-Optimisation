/**
 * End-to-end verification of `bench/run.ts` against a mock LLM. Costs nothing.
 *
 *   bun bench/verify-offline.ts
 *
 * Runs the REAL runner as a subprocess — the same command the optimisation
 * loop uses — and asserts the report it produces is internally consistent:
 * ingestion metered, both usage shapes parsed, cost attributed, integrity
 * checked, the agent tool loop actually executed, grading applied.
 *
 * It proves plumbing, not quality. Scores from this run are meaningless and
 * the job directory is marked MOCK so nobody mistakes it for a baseline.
 *
 * WARNING: resets the benchmark Neo4j graph.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMockOpenAI } from './mock-openai';

const BENCH = import.meta.dirname;
const JOB = '_offline-verify';
const jobDir = join(BENCH, 'jobs', JOB);

let failures = 0;
function assert(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
}

const mock = startMockOpenAI();
console.log(`mock OpenAI: ${mock.baseUrl}\nrunning the real runner as a subprocess...\n`);

const proc = Bun.spawn(
  ['bun', join(BENCH, 'run.ts'), '--split', 'dev', '--job', JOB, '--qa-concurrency', '4'],
  {
    cwd: join(BENCH, '..'),
    env: {
      ...process.env,
      OPENAI_API_KEY: 'sk-mock-offline-verification',
      OPENAI_BASE_URL: mock.baseUrl,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
);
const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;
await mock.stop();

const tail = stdout.trim().split('\n').slice(-14).join('\n');
console.log(`--- runner tail (exit ${exitCode}) ---\n${tail}\n`);
if (stderr.trim()) console.log(`--- stderr ---\n${stderr.trim().slice(-1500)}\n`);

console.log('assertions:');
assert('runner exited 0', exitCode === 0, `exit=${exitCode}`);

const reportPath = join(jobDir, 'report.json');
if (!existsSync(reportPath)) {
  assert('report.json written', false, reportPath);
  process.exit(1);
}
const r = JSON.parse(readFileSync(reportPath, 'utf-8'));
writeFileSync(join(jobDir, 'MOCK'), 'Produced by bench/verify-offline.ts against a mock LLM. Not a score.\n');

assert('run marked valid', r.valid === true, r.invalidReason ?? '');
assert('preflight fully passed', (r.preflight ?? []).every((p: any) => p.pass),
  (r.preflight ?? []).filter((p: any) => !p.pass).map((p: any) => p.name).join(',') || 'all');
assert('SUT fingerprint recorded', typeof r.sut?.hash === 'string' && r.sut.hash.length === 16, r.sut?.hash);

// --- ingestion ------------------------------------------------------------
const ing = r.ingest;
assert('ingest section present', !!ing);
assert('all issues fetched', ing?.pipeline?.issuesFetched === 60, `${ing?.pipeline?.issuesFetched}`);
assert('all issues analyzed', ing?.pipeline?.issuesAnalyzed === 60, `${ing?.pipeline?.issuesAnalyzed}`);
assert('no pipeline errors', (ing?.pipeline?.errors ?? []).length === 0,
  (ing?.pipeline?.errors ?? []).slice(0, 2).join(' | '));
assert('github requests counted', ing?.github?.requests === 121, `${ing?.github?.requests}`);
assert('fetch concurrency observed as serial', ing?.github?.maxConcurrent === 1, `${ing?.github?.maxConcurrent}`);
assert('neo4j statements counted', ing?.neo4j?.queries > 0, `${ing?.neo4j?.queries}`);

// The bug this catches: the openai shim capturing fetch before the meter is
// installed, which silently reports every ingestion call as free.
assert('ingest OpenAI requests metered', ing?.openai?.requests >= 60, `${ing?.openai?.requests}`);
const ingestTokens = Object.values(ing?.openai?.byModel ?? {}).reduce(
  (t: number, u: any) => t + u.promptTokens + u.completionTokens, 0);
assert('ingest tokens read from the wire', ingestTokens > 0, `${ingestTokens} tokens`);
assert('ingest cost is non-zero', ing?.openai?.costUsd > 0, `$${ing?.openai?.costUsd}`);
assert('no unpriced ingest models', (ing?.openai?.unpricedModels ?? []).length === 0,
  (ing?.openai?.unpricedModels ?? []).join(','));

// --- integrity ------------------------------------------------------------
const failed = (r.integrity ?? []).filter((c: any) => !c.pass && !c.info);
assert('all integrity checks pass', failed.length === 0,
  failed.map((c: any) => `${c.name}(exp ${c.expected} got ${c.actual})`).join(', '));
assert('integrity ran every check', (r.integrity ?? []).length >= 20, `${(r.integrity ?? []).length} checks`);

// --- QA -------------------------------------------------------------------
const qa = r.qa;
assert('every task attempted', qa?.tasks?.length === 40, `${qa?.tasks?.length}`);
assert('no agent errors', r.score?.agentErrorRate === 0, `${r.score?.agentErrorRate}`);
assert('agent tool loop executed', r.score?.toolUseRate === 1, `toolUseRate=${r.score?.toolUseRate}`);
assert('QA hit Neo4j through the tool', qa?.neo4j?.queries > 0, `${qa?.neo4j?.queries}`);

// The second silent-$0 bug: /v1/responses reports input_tokens/output_tokens,
// not prompt_tokens/completion_tokens.
const qaTokens = Object.values(qa?.openai?.byModel ?? {}).reduce(
  (t: number, u: any) => t + u.promptTokens + u.completionTokens, 0);
assert('QA tokens parsed from the Responses API shape', qaTokens > 0, `${qaTokens} tokens`);
assert('QA cost is non-zero', r.cost?.qaUsd > 0, `$${r.cost?.qaUsd}`);
assert('judge cost tracked separately from the SUT', typeof r.cost?.judgeUsd === 'number',
  `judge=$${r.cost?.judgeUsd} sut=$${r.cost?.sutTotalUsd}`);

// A canned model cannot answer well, but grading must still have RUN — a
// grader that silently passes everything would look identical to a good agent.
const passRates = (qa?.tasks ?? []).map((t: any) => t.passRate);
assert('grading produced verdicts', passRates.length === 40 && passRates.every((p: number) => p === 0 || p === 1));
assert('a canned agent does NOT score highly', r.score?.deterministic < 0.5,
  `deterministic=${r.score?.deterministic}`);
assert('every attempt carries a reason', (qa?.tasks ?? []).every((t: any) => t.attempts.every((a: any) => !!a.reason)));
assert('failing attempts record the Cypher run', (qa?.tasks ?? [])
  .filter((t: any) => t.passRate === 0)
  .every((t: any) => t.attempts[0].toolCalls.length > 0));

// --- summarize ------------------------------------------------------------
const sum = Bun.spawnSync(['bun', join(BENCH, 'summarize.ts'), `jobs/${JOB}`], { cwd: join(BENCH, '..') });
const sumOut = new TextDecoder().decode(sum.stdout);
// Re-running a job name must not accumulate traces from the previous run.
assert('exactly one trace file per run', (r.trace?.files ?? []).length === 1,
  `${(r.trace?.files ?? []).length} files`);
assert('trace captured spans', (r.trace?.spans ?? 0) > 0, `${r.trace?.spans} spans`);
assert('trace saw the agent tool loop', (r.trace?.byName?.['tool.queryNeo4j']?.count ?? 0) > 0);
assert('trace and meter agree on GitHub calls',
  r.trace?.byName?.['github.graphql']?.count === r.ingest?.github?.requests,
  `trace=${r.trace?.byName?.['github.graphql']?.count} meter=${r.ingest?.github?.requests}`);

assert('summarize renders', sum.exitCode === 0 && sumOut.includes('## Score'),
  sum.exitCode === 0 ? `${sumOut.split('\n').length} lines` : new TextDecoder().decode(sum.stderr).slice(0, 200));
const diff = Bun.spawnSync(['bun', join(BENCH, 'summarize.ts'), `jobs/${JOB}`, `jobs/${JOB}`], { cwd: join(BENCH, '..') });
assert('summarize diffs two runs', diff.exitCode === 0 &&
  new TextDecoder().decode(diff.stdout).includes('Flip fingerprint'));

console.log(
  `\nmock served: ${mock.stats.chatCompletions} chat/completions, ${mock.stats.responses} responses, ` +
    `${mock.stats.toolCallsIssued} tool calls issued`,
);
console.log(failures === 0 ? '\nverify-offline: PASS\n' : `\nverify-offline: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);

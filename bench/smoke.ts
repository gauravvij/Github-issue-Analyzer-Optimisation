/**
 * Harness self-test. Costs nothing: runs the real ingestion pipeline against
 * the fake GitHub server with OpenAI analysis DISABLED, then asserts the graph
 * matches the corpus exactly.
 *
 *   bun bench/smoke.ts [--split dev]
 *
 * Run this after any change to bench/ or to github_issue/src/services. If it
 * fails, no paid run will be trustworthy. It deliberately does NOT touch the
 * benchmark graph used by scored runs — it resets and re-ingests from scratch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Corpus } from './scripts/build-corpus';
import { startFakeGitHub } from './harness/fake-github';
import { meterDriver } from './harness/instrument';
import { checkIntegrity, resetDatabase, startNeo4j, BOLT_URI } from './harness/neo4j';
import { loadEnv } from './harness/preflight';

const BENCH = import.meta.dirname;
const SUT = join(BENCH, '..', 'github_issue');

const split = process.argv.includes('--split') ? process.argv[process.argv.indexOf('--split') + 1] : 'dev';

let failures = 0;
function assert(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
}

const corpus = JSON.parse(readFileSync(join(BENCH, 'corpus', `${split}.json`), 'utf-8')) as Corpus;

loadEnv();
await startNeo4j();
process.env.NEO4J_URI = BOLT_URI;
process.env.NEO4J_AUTH = 'none';
process.env.GITHUB_TOKEN ||= 'bench-fixture-token';

const github = startFakeGitHub(corpus, { latencyMs: 5 });
process.env.GITHUB_API_URL = github.url;

const { getDriver, closeDriver } = await import(join(SUT, 'src/services/neo4j.ts'));
const { runPipeline } = await import(join(SUT, 'src/services/pipeline.ts'));

const driver = getDriver();
const neo = meterDriver(driver);

console.log(`\nsmoke: ${split} split, ${corpus.issues.length} issues, analysis disabled\n`);
await resetDatabase(driver);
neo.reset();
github.reset();

const t0 = performance.now();
const result = await runPipeline({
  owner: corpus.meta.owner,
  repo: corpus.meta.repo,
  state: 'all',
  limit: 0,
  analyze: false,
  fullSync: true,
});
const seconds = (performance.now() - t0) / 1000;

console.log('\nassertions:');
assert('pipeline had no errors', result.errors.length === 0, result.errors.slice(0, 3).join(' | '));
assert('all issues fetched', result.issuesFetched === corpus.issues.length, `${result.issuesFetched}/${corpus.issues.length}`);
assert('all issues ingested', result.issuesIngested === corpus.issues.length, `${result.issuesIngested}/${corpus.issues.length}`);
assert('no OpenAI calls when analyze=false', result.issuesAnalyzed === 0);
assert('fake GitHub served requests', github.stats.requests > 0, `${github.stats.requests} requests`);
assert('Neo4j meter counted statements', neo.stats.queries > 0, `${neo.stats.queries} statements`);

// Snapshot before integrity checks, which run their own queries through the meter.
const ingestStats = { ...neo.stats };
const integrity = await checkIntegrity(driver, corpus);
for (const c of integrity.filter((x) => !x.info)) {
  assert(`integrity:${c.name}`, c.pass, `expected=${c.expected} actual=${c.actual}`);
}

// Analysis is off, so nothing should have produced analysis nodes. If these are
// non-zero the graph was not actually reset.
for (const name of ['solution_nodes', 'workaround_nodes', 'category_nodes', 'competitor_nodes']) {
  const c = integrity.find((x) => x.name === name)!;
  assert(`clean:${name}`, c.actual === '0', c.actual);
}

console.log(
  `\nbaseline shape (analysis off): ${seconds.toFixed(1)}s, ${github.stats.requests} GitHub requests, ` +
    `max concurrency ${github.stats.maxConcurrent}, ${ingestStats.queries} Neo4j statements, ` +
    `${ingestStats.sessions} sessions, ${ingestStats.transactions} transactions`,
);

await github.stop();
await closeDriver();

console.log(failures === 0 ? '\nsmoke: PASS\n' : `\nsmoke: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);

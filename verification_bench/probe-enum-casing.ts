/**
 * Focused probe for the Issue.state enum-casing defect.
 *
 * The graph stores 'OPEN'/'CLOSED'. GitHub's UI and REST API use lowercase, so
 * a model that has to guess writes `i.state = 'open'`, gets zero rows, and
 * answers "there are no open issues" — a confident zero from a broken query.
 * That single defect is the entire accuracy difference between the campaign's
 * baseline and its champion, on two independent corpora.
 *
 * A full scored run costs ~$1 and spends 39/40 of it on unrelated questions.
 * This asks only the two questions that expose the defect, many times, and
 * reports what the model actually wrote — so the fix is measured, not asserted.
 *
 * Truth comes from the live graph, so it works with whatever split is ingested.
 *
 *   SUT_DIR=../.worktrees/baseline/github_issue bun verification_bench/probe-enum-casing.ts --n 10
 */

import { join, resolve } from 'node:path';
import { startNeo4j, BOLT_URI } from './neo4j';
import { loadEnv } from './preflight';

const HERE = import.meta.dirname;
const SUT = resolve(HERE, process.env.SUT_DIR ?? join('..', 'github_issue'));

const argv = process.argv.slice(2);
const N = Number(argv[argv.indexOf('--n') + 1]) || 10;

loadEnv();
await startNeo4j();
process.env.NEO4J_URI = BOLT_URI;
process.env.NEO4J_AUTH = 'none';

const { getDriver, closeDriver } = await import(join(SUT, 'src/services/neo4j.ts'));
const { INSTRUCTIONS, MODEL, TOOLS } = await import(join(SUT, 'agent/config.ts'));
const { Agent } = await import('@mastra/core/agent');

// Ground truth straight from the graph.
const session = getDriver().session();
const truth: Record<string, number> = {};
for (const state of ['OPEN', 'CLOSED']) {
  const r = await session.run('MATCH (i:Issue) WHERE i.state = $s RETURN count(i) AS c', { s: state });
  truth[state] = r.records[0].get('c').toNumber();
}
const total = (await session.run('MATCH (i:Issue) RETURN count(i) AS c')).records[0].get('c').toNumber();
await session.close();

if (total === 0) {
  console.error('No issues in the graph. Ingest one first:  bun verification_bench/smoke.ts --split dev');
  process.exit(2);
}

const QUESTIONS = [
  { q: 'How many issues are currently open?', want: truth.OPEN, state: 'OPEN' },
  { q: 'How many issues are closed?', want: truth.CLOSED, state: 'CLOSED' },
];

console.log(`SUT: ${SUT}`);
console.log(`graph: ${total} issues (${truth.OPEN} OPEN / ${truth.CLOSED} CLOSED), ${N} trials per question\n`);

let correct = 0;
let attempted = 0;
let rightCasing = 0;
let confidentZero = 0;

for (const { q, want, state } of QUESTIONS) {
  const wrong: string[] = [];
  let ok = 0;
  let cased = 0;
  for (let i = 0; i < N; i++) {
    const agent = new Agent({
      id: 'probe-github-issue-analyzer',
      name: 'probe-github-issue-analyzer',
      instructions: INSTRUCTIONS,
      model: MODEL,
      tools: TOOLS,
    });
    const out = await agent.generate(q);
    const text: string = out.text ?? '';
    // Same unwrapping bench/run.ts:375 uses — Mastra nests args differently by version.
    const cyphers = ((out.toolCalls ?? []) as unknown[])
      .map((t) => {
        const c = t as {
          args?: { cypher?: string };
          input?: { cypher?: string };
          payload?: { args?: { cypher?: string } };
        };
        return c.args?.cypher ?? c.input?.cypher ?? c.payload?.args?.cypher ?? '';
      })
      .filter(Boolean);

    // Did the FIRST state-comparison it wrote use the stored casing?
    const first = cyphers.find((c) => /state/i.test(c)) ?? '';
    const usedRight = new RegExp(`['"]${state}['"]`).test(first);
    const usedWrong = new RegExp(`['"]${state.toLowerCase()}['"]`).test(first);
    if (usedRight) cased++;

    // Grading matches bench/harness/grade.ts: the number must appear, stripped
    // of code blocks so a `LIMIT 60` cannot score a free point.
    const hay = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    const hit = new RegExp(`(?<![\\d.,])${want}(?![\\d.,])`).test(hay);
    if (hit) ok++;
    else {
      wrong.push(`${usedWrong ? "wrote lowercase" : 'other'}: ${first.slice(0, 72) || '(no state query)'}`);
      if (/\bno\b|\bzero\b|\b0\b/i.test(hay)) confidentZero++;
    }
    attempted++;
  }
  correct += ok;
  rightCasing += cased;
  console.log(`  "${q}"  want ${want}`);
  console.log(`    correct answer   : ${ok}/${N}`);
  console.log(`    stored casing '${state}' in first state query : ${cased}/${N}`);
  for (const w of wrong.slice(0, 3)) console.log(`    MISS  ${w}`);
  console.log();
}

console.log(`TOTAL correct ${correct}/${attempted}   right casing ${rightCasing}/${attempted}   confident-zero answers ${confidentZero}`);
await closeDriver();
process.exit(correct === attempted ? 0 : 1);

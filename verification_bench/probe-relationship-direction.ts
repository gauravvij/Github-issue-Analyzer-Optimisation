/**
 * Standalone, auditable probe for AUTHORED_BY relationship direction.
 *
 * The graph stores Issue -> User and Comment -> User edges. This probe asks
 * four author-traversal questions, records every raw answer/tool call, and
 * derives correctness, backwards-traversal, and confident-zero counters.
 * It never edits the graph or benchmark resources.
 *
 * Example:
 *   SUT_DIR=../.worktrees/champion/github_issue bun verification_bench/probe-relationship-direction.ts --label pre-4o --n 10
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { startNeo4j, BOLT_URI } from './neo4j';
import { loadEnv } from './preflight';

const HERE = import.meta.dirname;
const SUT = resolve(HERE, process.env.SUT_DIR ?? join('..', 'github_issue'));
const argv = process.argv.slice(2);
const value = (flag: string, fallback: string) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1] ?? fallback;
};
const N = Number(value('--n', '10')) || 10;
const label = value('--label', `relationship-${Date.now()}`);
const outPath = resolve(value('--out', join(HERE, 'probes', `${label}.json`)));

loadEnv();
await startNeo4j();
process.env.NEO4J_URI = BOLT_URI;
process.env.NEO4J_AUTH = 'none';
const { getDriver, closeDriver } = await import(join(SUT, 'src/services/neo4j.ts'));
const { INSTRUCTIONS, MODEL, TOOLS } = await import(join(SUT, 'agent/config.ts'));
const { Agent } = await import('@mastra/core/agent');

const session = getDriver().session();
const count = async (cypher: string, key: string) => (await session.run(cypher)).records[0].get(key).toNumber();
const distinctIssueAuthors = await count('MATCH (i:Issue)-[:AUTHORED_BY]->(u:User) RETURN count(DISTINCT u) AS c', 'c');
const top = await session.run('MATCH (i:Issue)-[:AUTHORED_BY]->(u:User) RETURN u.login AS login, count(i) AS c ORDER BY c DESC, login ASC LIMIT 1');
const topLogin = String(top.records[0].get('login'));
const topCount = top.records[0].get('c').toNumber();
const distinctCommentAuthors = await count('MATCH (c:Comment)-[:AUTHORED_BY]->(u:User) RETURN count(DISTINCT u) AS c', 'c');
const authoredIssueRelationships = await count('MATCH (i:Issue)-[:AUTHORED_BY]->(u:User) RETURN count(i) AS c', 'c');
const topComment = await session.run('MATCH (c:Comment)-[:AUTHORED_BY]->(u:User) RETURN u.login AS login, count(c) AS c ORDER BY c DESC, login ASC LIMIT 1');
const topCommentLogin = String(topComment.records[0].get('login'));
const topCommentCount = topComment.records[0].get('c').toNumber();
await session.close();

const questions = [
  { id: 'distinct-issue-authors', q: 'How many distinct users have authored issues in the knowledge graph?', expected: String(distinctIssueAuthors), kind: 'number' },
  { id: 'top-issue-author', q: 'Which user has authored the most issues, and how many did they author?', expected: `${topLogin} (${topCount})`, kind: 'contains' },
  { id: 'distinct-comment-authors', q: 'How many distinct users have authored comments in the knowledge graph?', expected: String(distinctCommentAuthors), kind: 'number' },
  { id: 'top-comment-author', q: 'Which user has authored the most comments, and how many comments did they author?', expected: `${topCommentLogin} (${topCommentCount})`, kind: 'contains' },
];

const records: unknown[] = [];
let correct = 0;
let backwardsTrials = 0;
let backwardsToolCalls = 0;
let authoredCypherCalls = 0;
let confidentZero = 0;
let total = 0;
const backwardPattern = /\(\s*\w+\s*:\s*(?:User|u)\s*\)\s*(?:-|<-)\s*\[\s*:AUTHORED_BY\s*\]\s*-\s*>\s*\(\s*\w+\s*:\s*(?:Issue|Comment)\s*\)/i;
const extractCyphers = (calls: unknown[]) => calls.map((raw) => {
  const t = raw as { input?: { cypher?: string }; args?: { cypher?: string }; payload?: { args?: { cypher?: string } } };
  return t.input?.cypher ?? t.args?.cypher ?? t.payload?.args?.cypher ?? '';
}).filter(Boolean);

for (const task of questions) {
  for (let trial = 1; trial <= N; trial++) {
    const agent = new Agent({ id: 'probe-relationship-direction', name: 'probe-relationship-direction', instructions: INSTRUCTIONS, model: MODEL, tools: TOOLS });
    const out = await agent.generate(task.q);
    const answer = out.text ?? '';
    const toolCalls = (out.toolCalls ?? []) as unknown[];
    const cyphers = extractCyphers(toolCalls);
    const authoredCyphers = cyphers.filter((c) => /AUTHORED_BY/i.test(c));
    const backwardsCyphers = authoredCyphers.filter((c) => backwardPattern.test(c));
    const taskBackwards = backwardsCyphers.length > 0;
    const hay = answer.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    const expectedNumber = task.expected.match(/\d+/)?.[0] ?? '';
    const hit = task.kind === 'contains'
      ? hay.toLowerCase().includes(task.expected.split(' ')[0].toLowerCase()) && hay.includes(expectedNumber)
      : new RegExp(`(?<![\\d.,])${task.expected}(?![\\d.,])`).test(hay);
    const zero = /\b(?:no|none|zero|0)\b/i.test(hay);
    if (hit) correct++;
    if (taskBackwards) backwardsTrials++;
    backwardsToolCalls += backwardsCyphers.length;
    authoredCypherCalls += authoredCyphers.length;
    if (zero && !hit) confidentZero++;
    total++;
    records.push({ task: task.id, question: task.q, expected: task.expected, trial, model: MODEL, answer, toolCalls, cyphers, authoredCyphers, backwardsCyphers, correct: hit, backwards: taskBackwards, confidentZero: zero && !hit });
  }
}

const result = {
  label,
  sut: SUT,
  model: MODEL,
  graph: { distinctIssueAuthors, topLogin, topCount, distinctCommentAuthors, authoredIssueRelationships, topCommentLogin, topCommentCount },
  trialsPerTask: N,
  tasks: questions,
  summary: {
    correct,
    total,
    correctRate: correct / total,
    backwardsTrials,
    backwardsTrialRate: backwardsTrials / total,
    backwardsToolCalls,
    authoredCypherCalls,
    backwardsToolCallRate: authoredCypherCalls ? backwardsToolCalls / authoredCypherCalls : 0,
    confidentZero,
  },
  records,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ label, model: MODEL, output: outPath, ...result.summary }, null, 2));
await closeDriver();

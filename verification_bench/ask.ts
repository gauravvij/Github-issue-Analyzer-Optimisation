/**
 * Talk to the analyzer locally, without deploying it.
 *
 * The shipped agent (`github_issue/agent/index.ts`) ends in `serve(agent)` — it
 * exposes itself over gRPC to the Astropods messaging service, which supplies
 * the chat UI. That means you cannot simply `bun run start` and get a prompt.
 *
 * This builds the SAME agent in-process — same instructions, same model, same
 * tool registry, imported from the tree under test — and asks it a question
 * against whatever graph is currently loaded in the benchmark Neo4j. It is the
 * same construction `verification_bench/run.ts` scores, so what you see here is
 * what the benchmark measures.
 *
 *   # load a graph first (free, no OpenAI spend):
 *   bun verification_bench/smoke.ts --split dev
 *
 *   # then ask either version anything:
 *   bun verification_bench/ask.ts "How many issues are open?"
 *   SUT_DIR=../.worktrees/baseline/github_issue bun verification_bench/ask.ts "How many issues are open?"
 *
 *   # or stay in a prompt:
 *   bun verification_bench/ask.ts --repl
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { startNeo4j, BOLT_URI } from './neo4j';
import { loadEnv } from './preflight';

const HERE = import.meta.dirname;
const SUT = resolve(HERE, process.env.SUT_DIR ?? join('..', 'github_issue'));

const argv = process.argv.slice(2);
const repl = argv.includes('--repl');
const question = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!repl && !question) {
  console.error('usage: bun verification_bench/ask.ts "your question"   [--repl]');
  process.exit(1);
}

/** Same algorithm bench/run.ts records with every score, so you know what you are talking to. */
function fingerprint(sut: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
        walk(p);
      } else if (/\.(ts|json|yml)$/.test(entry)) files.push(p);
    }
  };
  for (const d of ['src', 'agent', 'ingestion']) walk(join(sut, d));
  for (const f of ['package.json', 'bun.lock']) if (existsSync(join(sut, f))) files.push(join(sut, f));
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(sut, f));
    h.update(readFileSync(f));
  }
  return h.digest('hex').slice(0, 16);
}

// Credentials belong to the checkout, not to the version under test: a git
// worktree of an older commit has no .env of its own. Load the SUT's if it has
// one, then always top up from the primary tree.
loadEnv();
if (!process.env.OPENAI_API_KEY) {
  const primary = join(HERE, '..', 'github_issue', '.env');
  if (existsSync(primary)) {
    for (const line of readFileSync(primary, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not found. Put it in github_issue/.env or export it.');
  process.exit(2);
}

await startNeo4j();
process.env.NEO4J_URI = BOLT_URI;
process.env.NEO4J_AUTH = 'none';

const { getDriver, closeDriver } = await import(join(SUT, 'src/services/neo4j.ts'));
const { INSTRUCTIONS, MODEL, TOOLS } = await import(join(SUT, 'agent/config.ts'));
const { Agent } = await import('@mastra/core/agent');

const session = getDriver().session();
const counts = await session.run(
  'MATCH (i:Issue) WITH count(i) AS issues MATCH (c:Comment) RETURN issues, count(c) AS comments',
);
await session.close();
const issues = counts.records[0]?.get('issues')?.toNumber() ?? 0;
const comments = counts.records[0]?.get('comments')?.toNumber() ?? 0;

if (issues === 0) {
  console.error('The graph is empty. Load one first:\n  bun verification_bench/smoke.ts --split dev');
  await closeDriver();
  process.exit(2);
}

console.log(`SUT   ${SUT}`);
console.log(`      fingerprint ${fingerprint(SUT)}   model ${MODEL}`);
console.log(`graph ${issues} issues, ${comments} comments  (${BOLT_URI})\n`);

async function ask(q: string): Promise<void> {
  const agent = new Agent({
    id: 'ask-github-issue-analyzer',
    name: 'ask-github-issue-analyzer',
    instructions: INSTRUCTIONS,
    model: MODEL,
    tools: TOOLS,
  });
  const t0 = performance.now();
  const out = await agent.generate(q);
  const ms = Math.round(performance.now() - t0);

  for (const raw of (out.toolCalls ?? []) as unknown[]) {
    const c = raw as {
      toolName?: string;
      args?: { cypher?: string };
      input?: { cypher?: string };
      payload?: { toolName?: string; args?: { cypher?: string } };
    };
    const tool = c.toolName ?? c.payload?.toolName ?? 'tool';
    const cypher = c.args?.cypher ?? c.input?.cypher ?? c.payload?.args?.cypher;
    console.log(`  \x1b[2m[${tool}]\x1b[0m ${cypher ? cypher.replace(/\s+/g, ' ').trim() : '(no cypher)'}`);
  }
  console.log(`\n${out.text ?? ''}\n\x1b[2m(${ms} ms)\x1b[0m\n`);
}

if (repl) {
  console.log('Ask anything. Ctrl-C to quit.\n');
  for await (const line of console) {
    const q = line.trim();
    if (!q) continue;
    await ask(q).catch((e) => console.error(`error: ${e instanceof Error ? e.message : String(e)}`));
  }
} else {
  await ask(question);
}
await closeDriver();

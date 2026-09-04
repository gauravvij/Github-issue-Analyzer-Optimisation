/**
 * Are the benchmark questions actually answerable, and are the frozen answers
 * right?
 *
 *   bun bench/verify-oracles.ts [--split dev]
 *
 * For every question template, this writes the Cypher a competent agent would
 * write and checks that the graph's answer equals the frozen oracle — which
 * was computed from the corpus JSON by completely different code. Two
 * independent derivations agreeing is decent evidence both are right; a
 * disagreement means the question is unfair (unanswerable as asked) or the
 * oracle is wrong. Either way the loop would be optimising toward noise.
 *
 * Requires an ingested graph (run `bun bench/smoke.ts` or any ingest first).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Corpus } from '../bench/scripts/build-corpus';
import type { Task } from '../bench/scripts/build-tasks';
import { startNeo4j, BOLT_URI } from './neo4j';
import { loadEnv } from './preflight';

const BENCH = import.meta.dirname;
// Which implementation is under test. Defaults to the champion tree so a
// bare invocation behaves like bench/; set SUT_DIR to score another copy.
const SUT = resolve(BENCH, process.env.SUT_DIR ?? join('..', 'github_issue'));
const split = process.argv.includes('--split') ? process.argv[process.argv.indexOf('--split') + 1] : 'dev';

const corpus = JSON.parse(readFileSync(join(BENCH, 'corpus', `${split}.json`), 'utf-8')) as Corpus;
const tasks = readFileSync(join(BENCH, 'tasks', `${split}.jsonl`), 'utf-8')
  .trim().split('\n').map((l) => JSON.parse(l) as Task);

loadEnv();
await startNeo4j(() => {});
process.env.NEO4J_URI = BOLT_URI;
process.env.NEO4J_AUTH = 'none';
const { getDriver, closeDriver } = await import(join(SUT, 'src/services/neo4j.ts'));
const session = getDriver().session();

const n = (v: any) => (v && typeof v === 'object' && 'toNumber' in v ? v.toNumber() : v);
async function col<T = any>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const r = await session.run(cypher, params);
  return r.records.map((rec: { get: (i: number) => unknown }) => n(rec.get(0)) as T);
}
const one = async (cypher: string, p: Record<string, unknown> = {}) => (await col(cypher, p))[0];

// Without this the first missing node surfaces as a TypeError halfway through,
// which reads like a harness bug rather than "you forgot to ingest".
const loaded = await one('MATCH (i:Issue) RETURN count(i)');
if (loaded !== corpus.issues.length) {
  console.error(
    `\nGraph holds ${loaded} issues, expected ${corpus.issues.length} for the "${split}" split.\n` +
      `Ingest first:  bun bench/smoke.ts --split ${split}\n` +
      `(\`bun test bench/\` resets the graph, so run it BEFORE this, not after.)\n`,
  );
  await session.close();
  await closeDriver();
  process.exit(2);
}

let failures = 0;
let checked = 0;
function expect(task: Task, actual: unknown, expected: unknown) {
  checked++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`  FAIL ${task.id} ${task.template}`);
    console.log(`       Q: ${task.question}`);
    console.log(`       frozen oracle: ${e}`);
    console.log(`       graph says:    ${a}`);
  }
}

/** Pull the numeric/set answer out of a frozen check. */
function expectedOf(task: Task): unknown {
  const c = task.check;
  if (c.type === 'number') return c.value;
  if (c.type === 'issue_set') return [...c.expect].sort((x, y) => x - y);
  if (c.type === 'contains_all') return c.values;
  return null;
}

/** Extract a quoted argument from the question text, e.g. label or login. */
const quoted = (q: string) => q.match(/"([^"]+)"/)?.[1] ?? '';
const issueNo = (q: string) => Number(q.match(/#(\d+)/)?.[1]);

console.log(`\nverifying ${tasks.length} ${split} oracles against independently written Cypher\n`);

const unverified: string[] = [];

for (const task of tasks) {
  const exp = expectedOf(task);
  switch (task.template) {
    case 'total_issues':
      expect(task, await one('MATCH (i:Issue) RETURN count(i)'), exp);
      break;
    case 'total_comments':
      expect(task, await one('MATCH (c:Comment) RETURN count(c)'), exp);
      break;
    case 'open_count':
      expect(task, await one("MATCH (i:Issue) WHERE i.state = 'OPEN' RETURN count(i)"), exp);
      break;
    case 'closed_count':
      expect(task, await one("MATCH (i:Issue) WHERE i.state = 'CLOSED' RETURN count(i)"), exp);
      break;
    case 'distinct_labels':
      expect(task, await one('MATCH (l:Label) RETURN count(DISTINCT l.name)'), exp);
      break;
    case 'distinct_authors':
      expect(task, await one('MATCH (:Issue)-[:AUTHORED_BY]->(u:User) RETURN count(DISTINCT u.login)'), exp);
      break;
    case 'zero_comment_count':
      expect(task, await one('MATCH (i:Issue) WHERE NOT (i)-[:HAS_COMMENT]->() RETURN count(i)'), exp);
      break;
    case 'most_comments':
      expect(task, await col(
        'MATCH (i:Issue) OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c) WITH i, count(c) AS n ORDER BY n DESC LIMIT 1 RETURN i.number',
      ), exp);
      break;
    case 'most_reactions':
      expect(task, await col(
        'MATCH (i:Issue) OPTIONAL MATCH (i)-[:HAS_REACTION]->(r) WITH i, count(r) AS n ORDER BY n DESC LIMIT 1 RETURN i.number',
      ), exp);
      break;
    case 'recent_5':
      expect(task, (await col('MATCH (i:Issue) RETURN i.number ORDER BY i.createdAt DESC LIMIT 5'))
        .sort((a, b) => a - b), exp);
      break;
    case 'label_count':
      expect(task, await one(
        'MATCH (i:Issue)-[:HAS_LABEL]->(l:Label {name: $name}) RETURN count(DISTINCT i)', { name: quoted(task.question) },
      ), exp);
      break;
    case 'label_members':
      expect(task, (await col(
        'MATCH (i:Issue)-[:HAS_LABEL]->(:Label {name: $name}) RETURN i.number', { name: quoted(task.question) },
      )).sort((a, b) => a - b), exp);
      break;
    case 'month_count': {
      const month = task.question.match(/in (\d{4}-\d{2})/)?.[1] ?? '';
      expect(task, await one(
        'MATCH (i:Issue) WHERE i.createdAt STARTS WITH $m RETURN count(i)', { m: month },
      ), exp);
      break;
    }
    case 'author_issues':
      expect(task, (await col(
        'MATCH (i:Issue)-[:AUTHORED_BY]->(:User {login: $l}) RETURN i.number', { l: quoted(task.question) },
      )).sort((a, b) => a - b), exp);
      break;
    case 'top_author': {
      const row = await session.run(
        'MATCH (i:Issue)-[:AUTHORED_BY]->(u:User) WITH u.login AS l, count(i) AS c ORDER BY c DESC LIMIT 1 RETURN l, c',
      );
      expect(task, [row.records[0].get('l'), String(n(row.records[0].get('c')))], exp);
      break;
    }
    case 'issue_comment_count':
      expect(task, await one(
        'MATCH (i:Issue {number: $no}) OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c) RETURN count(c)', { no: issueNo(task.question) },
      ), exp);
      break;
    case 'issue_author':
      expect(task, [await one(
        'MATCH (i:Issue {number: $no})-[:AUTHORED_BY]->(u:User) RETURN u.login', { no: issueNo(task.question) },
      )], exp);
      break;
    case 'issue_title': {
      const title: string = await one('MATCH (i:Issue {number: $no}) RETURN i.title', { no: issueNo(task.question) });
      const terms = exp as string[];
      const missing = terms.filter((t) => !title.toLowerCase().includes(t.toLowerCase()));
      expect(task, missing, []);
      break;
    }
    case 'mentions_term': {
      const term = quoted(task.question);
      expect(task, (await col(
        'MATCH (i:Issue) WHERE i.title CONTAINS $t OR i.bodyText CONTAINS $t RETURN i.number', { t: term },
      )).sort((a, b) => a - b), exp);
      // The agent may reasonably lowercase; the term was selected so both agree.
      const ci = (await col(
        'MATCH (i:Issue) WHERE toLower(i.title) CONTAINS toLower($t) OR toLower(i.bodyText) CONTAINS toLower($t) RETURN i.number',
        { t: term },
      )).sort((a, b) => a - b);
      expect({ ...task, id: `${task.id}(case-insensitive)` }, ci, exp);
      break;
    }
    case 'summarize_issue': {
      // Judge-graded: assert only that the referenced issue and its comments
      // are present, i.e. the question is answerable at all.
      const no = issueNo(task.question);
      const c = await one('MATCH (i:Issue {number: $no})-[:HAS_COMMENT]->(x) RETURN count(x)', { no });
      const src = corpus.issues.find((i) => i.number === no)!;
      expect(task, c, src.totalComments);
      break;
    }
    default:
      unverified.push(task.template);
  }
}

await session.close();
await closeDriver();

if (unverified.length) {
  console.log(`  NOTE: no Cypher written for template(s): ${[...new Set(unverified)].join(', ')}`);
}
console.log(
  failures === 0
    ? `\nverify-oracles: PASS — ${checked} oracle(s) reproduced from the graph\n`
    : `\nverify-oracles: ${failures}/${checked} MISMATCH\n`,
);
process.exit(failures === 0 ? 0 : 1);

/**
 * Are the v2 questions answerable, and are the frozen answers right?
 *
 *   bun verification_bench/verify-oracles-v2.ts --split skl-dev
 *   bun verification_bench/verify-oracles-v2.ts --all
 *
 * Same contract as verify-oracles.ts: for every template, write the Cypher a
 * competent agent would write and check the graph's answer equals the frozen
 * oracle, which was computed from the corpus JSON by entirely different code.
 * Two independent derivations agreeing is decent evidence both are right.
 *
 * One deliberate difference: an unrecognised template THROWS instead of being
 * collected into a note. In verify-oracles.ts an unknown template lands in
 * `unverified[]` and the run still says PASS — which means a new question type
 * can be added, never checked, and quietly score noise. That is the exact
 * failure this file exists to prevent, so it is made fatal.
 *
 * Requires an ingested graph: `bun verification_bench/smoke.ts --split <split>`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Corpus } from '../bench/scripts/build-corpus';
import type { TaskV2 } from './scripts/build-tasks-v2';
import { startNeo4j, BOLT_URI } from './neo4j';
import { loadEnv } from './preflight';

const BENCH = import.meta.dirname;
const SUT = resolve(BENCH, process.env.SUT_DIR ?? join('..', 'github_issue'));

const flag = (f: string) => process.argv.indexOf(f);
const splits: string[] = flag('--all') >= 0
  ? readdirSync(join(BENCH, 'tasks'))
      .filter((f) => f.endsWith('.jsonl') && !['dev.jsonl', 'holdout.jsonl'].includes(f))
      .map((f) => f.replace(/\.jsonl$/, '')).sort()
  : [process.argv[flag('--split') + 1] ?? 'dev'];

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
const asc = (xs: number[]) => [...xs].sort((a, b) => a - b);

let failures = 0;
let checked = 0;
function expect(task: TaskV2, actual: unknown, expected: unknown, note = '') {
  checked++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`  FAIL ${task.id} ${task.template}${note}`);
    console.log(`       Q: ${task.question}`);
    console.log(`       frozen oracle: ${e}`);
    console.log(`       graph says:    ${a}`);
  }
}

function expectedOf(task: TaskV2): unknown {
  const c = task.check;
  if (c.type === 'number') return c.value;
  if (c.type === 'issue_set') return asc([...c.expect]);
  if (c.type === 'contains_all') return c.values;
  return null;
}

const quoted = (q: string) => q.match(/"([^"]+)"/)?.[1] ?? '';
const issueNo = (q: string) => Number(q.match(/#(\d+)/)?.[1]);
const dates = (q: string) => [...q.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);

const COUNT_LABEL = 'MATCH (i:Issue)-[:HAS_LABEL]->(l:Label {name: $name}) RETURN count(DISTINCT i)';
const LABEL_MEMBERS = 'MATCH (i:Issue)-[:HAS_LABEL]->(:Label {name: $name}) RETURN i.number';
const CLOSED_COUNT = "MATCH (i:Issue) WHERE i.state = 'CLOSED' RETURN count(i)";
const AUTHOR_COUNT = 'MATCH (:Issue)-[:AUTHORED_BY]->(u:User) RETURN count(DISTINCT u.login)';
const AUTHOR_ISSUES = 'MATCH (i:Issue)-[:AUTHORED_BY]->(:User {login: $l}) RETURN i.number';
const MENTIONS = 'MATCH (i:Issue) WHERE i.title CONTAINS $t OR i.bodyText CONTAINS $t RETURN i.number';
const MENTIONS_CI =
  'MATCH (i:Issue) WHERE toLower(i.title) CONTAINS toLower($t) OR toLower(i.bodyText) CONTAINS toLower($t) RETURN i.number';

async function verify(split: string) {
  const corpus = JSON.parse(readFileSync(join(BENCH, 'corpus', `${split}.json`), 'utf-8')) as Corpus;
  const tasks = readFileSync(join(BENCH, 'tasks', `${split}.jsonl`), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l) as TaskV2);

  const loaded = await one('MATCH (i:Issue) RETURN count(i)');
  if (loaded !== corpus.issues.length) {
    throw new Error(
      `Graph holds ${loaded} issues, expected ${corpus.issues.length} for "${split}". ` +
      `Ingest first: bun verification_bench/smoke.ts --split ${split}`,
    );
  }
  console.log(`\nverifying ${tasks.length} ${split} oracles against independently written Cypher\n`);

  for (const task of tasks) {
    const exp = expectedOf(task);
    switch (task.template) {
      // --- canary ---------------------------------------------------------
      case 'total_issues':
        expect(task, await one('MATCH (i:Issue) RETURN count(i)'), exp); break;
      case 'total_comments':
        expect(task, await one('MATCH (c:Comment) RETURN count(c)'), exp); break;

      // --- enum_state -----------------------------------------------------
      case 'open_count':
        expect(task, await one("MATCH (i:Issue) WHERE i.state = 'OPEN' RETURN count(i)"), exp); break;
      case 'closed_count':
      case 'closed_count_paraphrase':
        expect(task, await one(CLOSED_COUNT), exp); break;
      case 'state_of_issue': {
        const state: string = await one('MATCH (i:Issue {number: $no}) RETURN i.state', { no: issueNo(task.question) });
        expect(task, [state.toLowerCase()], exp); break;
      }
      case 'open_label_count':
        expect(task, await one(
          "MATCH (i:Issue)-[:HAS_LABEL]->(:Label {name: $name}) WHERE i.state = 'OPEN' RETURN count(DISTINCT i)",
          { name: quoted(task.question) }), exp); break;
      case 'open_with_label':
        expect(task, asc(await col(
          "MATCH (i:Issue)-[:HAS_LABEL]->(:Label {name: $name}) WHERE i.state = 'OPEN' RETURN i.number",
          { name: quoted(task.question) })), exp); break;

      // --- label ----------------------------------------------------------
      case 'distinct_labels':
        expect(task, await one('MATCH (l:Label) RETURN count(DISTINCT l.name)'), exp); break;
      case 'label_count':
        expect(task, await one(COUNT_LABEL, { name: quoted(task.question) }), exp); break;
      case 'label_members':
        expect(task, asc(await col(LABEL_MEMBERS, { name: quoted(task.question) })), exp); break;
      case 'label_natural_casing':
        // The question uses the casing a human types; the graph stores another.
        // Matching case-insensitively is the whole point of the question.
        expect(task, await one(
          'MATCH (i:Issue)-[:HAS_LABEL]->(l:Label) WHERE toLower(l.name) = toLower($name) RETURN count(DISTINCT i)',
          { name: quoted(task.question) }), exp); break;

      // --- author ---------------------------------------------------------
      case 'distinct_authors':
      case 'distinct_authors_paraphrase':
        expect(task, await one(AUTHOR_COUNT), exp); break;
      case 'top_author': {
        const row = await session.run(
          'MATCH (i:Issue)-[:AUTHORED_BY]->(u:User) WITH u.login AS l, count(i) AS c ORDER BY c DESC LIMIT 1 RETURN l, c');
        expect(task, [row.records[0].get('l'), String(n(row.records[0].get('c')))], exp); break;
      }
      case 'author_issues':
        expect(task, asc(await col(AUTHOR_ISSUES, { l: quoted(task.question) })), exp); break;
      case 'issue_author':
        expect(task, [await one(
          'MATCH (i:Issue {number: $no})-[:AUTHORED_BY]->(u:User) RETURN u.login', { no: issueNo(task.question) })], exp);
        break;
      case 'commenter_count':
        expect(task, await one(
          'MATCH (i:Issue {number: $no})-[:HAS_COMMENT]->(:Comment)-[:AUTHORED_BY]->(u:User) RETURN count(DISTINCT u.login)',
          { no: issueNo(task.question) }), exp); break;

      // --- date_range -----------------------------------------------------
      case 'month_count': {
        const m = task.question.match(/in (\d{4}-\d{2})/)?.[1] ?? '';
        expect(task, await one('MATCH (i:Issue) WHERE i.createdAt STARTS WITH $m RETURN count(i)', { m }), exp); break;
      }
      case 'created_before':
        expect(task, await one('MATCH (i:Issue) WHERE i.createdAt < $d RETURN count(i)', { d: dates(task.question)[0] }), exp);
        break;
      case 'created_after':
        expect(task, await one('MATCH (i:Issue) WHERE i.createdAt > $d RETURN count(i)', { d: dates(task.question)[0] }), exp);
        break;
      case 'created_between': {
        const [a, b] = dates(task.question);
        expect(task, await one(
          'MATCH (i:Issue) WHERE i.createdAt > $a AND i.createdAt < $b RETURN count(i)', { a, b }), exp); break;
      }

      // --- aggregation ----------------------------------------------------
      case 'zero_comment_count':
        expect(task, await one('MATCH (i:Issue) WHERE NOT (i)-[:HAS_COMMENT]->() RETURN count(i)'), exp); break;
      case 'most_comments':
        expect(task, await col(
          'MATCH (i:Issue) OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c) WITH i, count(c) AS k ORDER BY k DESC LIMIT 1 RETURN i.number'),
          exp); break;
      case 'most_reactions':
        expect(task, await col(
          'MATCH (i:Issue) OPTIONAL MATCH (i)-[:HAS_REACTION]->(r) WITH i, count(r) AS k ORDER BY k DESC LIMIT 1 RETURN i.number'),
          exp); break;
      case 'issues_with_ge_n_comments': {
        const k = Number(task.question.match(/at least (\d+)/)?.[1]);
        expect(task, await one(
          'MATCH (i:Issue) OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c) WITH i, count(c) AS m WHERE m >= $k RETURN count(i)',
          { k }), exp); break;
      }
      case 'issue_comment_count':
        expect(task, await one(
          'MATCH (i:Issue {number: $no}) OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c) RETURN count(c)',
          { no: issueNo(task.question) }), exp); break;

      // --- text_search ----------------------------------------------------
      case 'issue_title': {
        const title: string = await one('MATCH (i:Issue {number: $no}) RETURN i.title', { no: issueNo(task.question) });
        expect(task, (exp as string[]).filter((t) => !title.toLowerCase().includes(t.toLowerCase())), []); break;
      }
      case 'mentions_term': {
        const t = quoted(task.question);
        expect(task, asc(await col(MENTIONS, { t })), exp);
        expect(task, asc(await col(MENTIONS_CI, { t })), exp, ' (case-insensitive)'); break;
      }

      // --- multi_hop ------------------------------------------------------
      case 'commenters_on_label':
        expect(task, (await col<string>(
          'MATCH (:Label {name: $name})<-[:HAS_LABEL]-(:Issue)-[:HAS_COMMENT]->(:Comment)-[:AUTHORED_BY]->(u:User) ' +
          'RETURN DISTINCT u.login', { name: quoted(task.question) })).sort(), exp); break;
      case 'labels_cooccurring':
        expect(task, (await col<string>(
          'MATCH (:Label {name: $name})<-[:HAS_LABEL]-(:Issue)-[:HAS_LABEL]->(o:Label) WHERE o.name <> $name ' +
          'RETURN DISTINCT o.name', { name: quoted(task.question) })).sort(), exp); break;
      case 'author_of_most_commented':
        expect(task, await col(
          'MATCH (i:Issue) OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c) WITH i, count(c) AS k ORDER BY k DESC LIMIT 1 ' +
          'MATCH (i)-[:AUTHORED_BY]->(u:User) RETURN u.login'), exp); break;
      case 'author_of_most_reacted':
        expect(task, await col(
          'MATCH (i:Issue) OPTIONAL MATCH (i)-[:HAS_REACTION]->(r) WITH i, count(r) AS k ORDER BY k DESC LIMIT 1 ' +
          'MATCH (i)-[:AUTHORED_BY]->(u:User) RETURN u.login'), exp); break;

      // --- true_zero ------------------------------------------------------
      // Each of these must be zero BOTH exactly and case-insensitively —
      // otherwise the "correct" answer depends on how the agent cased its query.
      case 'absent_label_count':
        expect(task, await one(COUNT_LABEL, { name: quoted(task.question) }), exp);
        expect(task, await one(
          'MATCH (i:Issue)-[:HAS_LABEL]->(l:Label) WHERE toLower(l.name) = toLower($name) RETURN count(DISTINCT i)',
          { name: quoted(task.question) }), exp, ' (case-insensitive)'); break;
      case 'absent_label_members':
        expect(task, asc(await col(LABEL_MEMBERS, { name: quoted(task.question) })), exp); break;
      case 'absent_term': {
        const t = quoted(task.question);
        expect(task, asc(await col(MENTIONS, { t })), exp);
        expect(task, asc(await col(MENTIONS_CI, { t })), exp, ' (case-insensitive)'); break;
      }
      case 'absent_author_issues':
        expect(task, asc(await col(AUTHOR_ISSUES, { l: quoted(task.question) })), exp); break;
      case 'absent_month_count': {
        const m = task.question.match(/in (\d{4}-\d{2})/)?.[1] ?? '';
        expect(task, await one('MATCH (i:Issue) WHERE i.createdAt STARTS WITH $m RETURN count(i)', { m }), exp); break;
      }

      // --- semantic -------------------------------------------------------
      case 'summarize_issue': {
        // Judge-graded, so assert only that the question is answerable at all:
        // the issue and its whole comment thread are in the graph.
        const no = issueNo(task.question);
        expect(task, await one('MATCH (i:Issue {number: $no})-[:HAS_COMMENT]->(x) RETURN count(x)', { no }),
          corpus.issues.find((i) => i.number === no)!.totalComments); break;
      }

      default:
        throw new Error(
          `no Cypher written for template "${task.template}" (${task.id}). ` +
          `Every v2 template must be independently verifiable — add a case above.`,
        );
    }
  }
}

try {
  for (const split of splits) await verify(split);
} finally {
  await session.close();
  await closeDriver();
}

console.log(
  failures === 0
    ? `\nverify-oracles-v2: PASS — ${checked} oracle(s) reproduced from the graph\n`
    : `\nverify-oracles-v2: ${failures}/${checked} MISMATCH\n`,
);
process.exit(failures === 0 ? 0 : 1);

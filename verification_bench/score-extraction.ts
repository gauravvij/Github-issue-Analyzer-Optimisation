/**
 * Grade the extraction stage — the one cost bucket nobody could optimise.
 *
 * `README.md` states the gap plainly: extraction is ~29% of run cost, and it
 * "cannot be optimised safely yet because nothing grades extraction quality.
 * No benchmark question reads the extracted nodes, so a cheaper extraction
 * model would show 'cost down, score unchanged' whether or not it got worse."
 *
 * It is worse than ungraded — it is unauditable. Extracted text reaches Neo4j
 * as a Cypher PARAMETER, and the harness records statements without parameters,
 * so no artifact in this repo contains a single extracted string. Step 1 below
 * fixes that regardless of whether the metrics are believed.
 *
 * Two proxies, both computed from a loaded graph with no API spend:
 *
 *   GROUNDING PRECISION — the share of extracted strings whose words actually
 *   occur in the issue. Extraction is meant to condense the issue, not invent;
 *   a cheaper model that starts inventing shows up here.
 *
 *   PATCH-MODULE RECALL — SWE-bench links each issue to the PR that fixed it,
 *   so the gold patch names the modules that turned out to matter. Recall is
 *   measured ONLY over issues where a gold module token also appears in the
 *   issue text: the extractor never sees the patch, so anything else would be
 *   scoring clairvoyance. On the sympy corpus that covers 39 of 60 issues.
 *
 * Both are proxies for grounding and topical recall. Neither says an extracted
 * solution is CORRECT — no oracle in this repo can.
 *
 * READ PATCH-MODULE RECALL AS A COMPARISON, NOT A GRADE. It is lexical, and
 * extraction names concepts where a patch names files: on psf/requests it
 * produced "CaseInsensitiveDict" for issue #649 while the gold patch touched
 * `requests/structures.py` — the same answer in two vocabularies, scored as a
 * miss. The absolute number therefore runs low by construction. What it is for
 * is holding the corpus and the metric fixed while moving the extraction model,
 * which is precisely the experiment the repo says it cannot currently run.
 * Grounding precision is the directly readable one.
 *
 *   bun verification_bench/score-extraction.ts --split skl-dev --job A-baseline__skl-dev
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Corpus, CorpusIssue } from '../bench/scripts/build-corpus';
import { startNeo4j, BOLT_URI } from './neo4j';
import { loadEnv } from './preflight';

const BENCH = import.meta.dirname;
const SUT = resolve(BENCH, process.env.SUT_DIR ?? join('..', 'github_issue'));
const arg = (f: string, d?: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const split = arg('--split', 'dev')!;
const job = arg('--job');

interface SwePair { pr: number; issue: number; files?: string[] }

/** `sympy/printing/latex.py` -> printing, latex. The package name is dropped:
 *  it is in every path, so it would score a point for saying nothing. */
function moduleTokens(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.replace(/\.[a-z]+$/i, '').split('/');
    for (const p of parts.slice(1)) {
      const t = p.toLowerCase();
      if (t.length > 3 && !['test', 'tests', 'src', 'lib', 'init', '__init__'].includes(t)) out.add(t);
    }
  }
  return out;
}

const words = (s: string) => (s.toLowerCase().match(/[a-z_][a-z0-9_.]{2,}/g) ?? []);

loadEnv();
await startNeo4j(() => {});
process.env.NEO4J_URI = BOLT_URI;
process.env.NEO4J_AUTH = 'none';
const { getDriver, closeDriver } = await import(join(SUT, 'src/services/neo4j.ts'));
const session = getDriver().session();

const corpusPath = join(BENCH, 'corpus', `${split}.json`);
const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8')) as Corpus & {
  meta: { swebench?: { pairs: SwePair[] } };
};
const byNumber = new Map<number, CorpusIssue>(corpus.issues.map((i) => [i.number, i]));

const num = (v: any) => (v && typeof v === 'object' && 'toNumber' in v ? v.toNumber() : v);

// --- 1. dump ---------------------------------------------------------------
// One query per label so a schema change surfaces as an empty bucket rather
// than a silent miss.
const SOURCES: [string, string][] = [
  ['Solution', 'MATCH (i:Issue)-[:HAS_SOLUTION]->(n:Solution) RETURN i.number AS num, n.solutionText AS text'],
  ['Workaround', 'MATCH (i:Issue)-[:HAS_WORKAROUND]->(n:Workaround) RETURN i.number AS num, n.workaroundText AS text'],
  ['Category', 'MATCH (i:Issue)-[:BELONGS_TO_CATEGORY]->(n:Category) RETURN i.number AS num, n.name AS text'],
  ['Competitor', 'MATCH (i:Issue)-[:MENTIONS_COMPETITOR]->(n:Competitor) RETURN i.number AS num, n.name AS text'],
  // Keywords hang off solutions/workarounds, which hang off the issue or one of
  // its comments — so the path is walked rather than assumed.
  ['Keyword', `MATCH (i:Issue)-[:HAS_COMMENT|HAS_SOLUTION|HAS_WORKAROUND*1..2]->(x)-[:HAS_KEYWORD]->(k:Keyword)
               RETURN DISTINCT i.number AS num, k.name AS text`],
];

const extracted = new Map<number, { label: string; text: string }[]>();
for (const [label, cypher] of SOURCES) {
  const res = await session.run(cypher);
  for (const rec of res.records) {
    const n = num(rec.get('num'));
    const text = rec.get('text');
    if (n == null || !text) continue;
    if (!extracted.has(n)) extracted.set(n, []);
    extracted.get(n)!.push({ label, text: String(text) });
  }
}

// --- 2. grounding precision -----------------------------------------------
let grounded = 0;
let totalStrings = 0;
const ungroundedExamples: string[] = [];
for (const [number, items] of extracted) {
  const issue = byNumber.get(number);
  if (!issue) continue;
  const hay = new Set(words(`${issue.title}\n${issue.bodyText}\n${issue.comments.map((c) => c.bodyText).join('\n')}`));
  for (const it of items) {
    totalStrings++;
    const ws = words(it.text);
    // "Grounded" = at least half its content words are in the issue. A summary
    // legitimately adds connective words; it should not invent the nouns.
    const hits = ws.filter((w) => hay.has(w)).length;
    if (ws.length === 0 || hits / ws.length >= 0.5) grounded++;
    else if (ungroundedExamples.length < 5) ungroundedExamples.push(`#${number} ${it.label}: ${it.text.slice(0, 90)}`);
  }
}

// --- 3. patch-module recall ------------------------------------------------
const pairs = corpus.meta.swebench?.pairs ?? [];
const goldByIssue = new Map<number, Set<string>>();
for (const p of pairs) {
  if (!p.files?.length) continue;
  const t = moduleTokens(p.files);
  if (!goldByIssue.has(p.issue)) goldByIssue.set(p.issue, new Set());
  for (const x of t) goldByIssue.get(p.issue)!.add(x);
}

let gradeable = 0;
let recalled = 0;
const missed: string[] = [];
for (const [number, gold] of goldByIssue) {
  const issue = byNumber.get(number);
  if (!issue) continue;
  const issueText = `${issue.title}\n${issue.bodyText}\n${issue.comments.map((c) => c.bodyText).join('\n')}`.toLowerCase();
  // Only fair if the extractor could have seen the token at all.
  const visible = [...gold].filter((t) => issueText.includes(t));
  if (visible.length === 0) continue;
  gradeable++;
  const mine = (extracted.get(number) ?? []).map((x) => x.text.toLowerCase()).join(' ');
  if (visible.some((t) => mine.includes(t))) recalled++;
  else if (missed.length < 5) missed.push(`#${number} expected one of [${visible.join(', ')}]`);
}

const result = {
  split,
  job: job ?? null,
  at: new Date().toISOString(),
  issuesWithExtraction: extracted.size,
  corpusIssues: corpus.issues.length,
  extractedStrings: totalStrings,
  groundingPrecision: totalStrings ? grounded / totalStrings : 0,
  patchModuleRecall: gradeable ? recalled / gradeable : 0,
  patchGradeableIssues: gradeable,
  patchLinkedIssues: goldByIssue.size,
  ungroundedExamples,
  missedExamples: missed,
  extraction: [...extracted.entries()].sort((a, b) => a[0] - b[0]).map(([number, items]) => ({ number, items })),
};

if (job) {
  const dir = join(BENCH, 'jobs', job);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'extraction.json');
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`  -> ${out}`);
}

console.log(`\nextraction on ${split}${job ? ` (${job})` : ''}`);
console.log(`  issues with any extracted node: ${extracted.size}/${corpus.issues.length}`);
console.log(`  extracted strings:              ${totalStrings}`);
console.log(`  grounding precision:            ${(result.groundingPrecision * 100).toFixed(1)}%  (words present in the issue)`);
console.log(`  patch-module recall:            ${(result.patchModuleRecall * 100).toFixed(1)}%  ` +
  `(${recalled}/${gradeable} gradeable of ${goldByIssue.size} SWE-bench-linked)`);
for (const e of ungroundedExamples) console.log(`    ungrounded: ${e}`);
for (const e of missed) console.log(`    missed:     ${e}`);
if (!existsSync(corpusPath)) console.log('  (no corpus?)');

await session.close();
await closeDriver();

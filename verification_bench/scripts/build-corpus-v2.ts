/**
 * Build one v2 corpus: real GitHub issues from one repo, for the stratified
 * multi-repo benchmark.
 *
 * Two changes from scripts/build-corpus.ts, whose GitHub plumbing this reuses:
 *
 * 1. STATE BALANCE. SWE-bench only contains issues a merged PR resolved, so a
 *    corpus built purely from it is ~100% closed — measured across the full
 *    SWE-bench test split: matplotlib 187/187, astropy 91/91, scikit-learn
 *    211/212. That makes `open_count` a true-zero question everywhere and
 *    leaves the one defect this whole campaign is about untestable. So a
 *    corpus is ~60% SWE-bench-linked (which keeps the patch oracle) and ~40%
 *    OPEN issues sampled from the same repo by the same seeded LCG.
 *
 *    Open candidates are sampled from the repo's ENTIRE open history, not the
 *    most recent page — taking the newest N would put every open issue in one
 *    or two months and flatten the date-range questions.
 *
 * 2. PATCH PROVENANCE. `meta.swebench.pairs[].files` records the files the gold
 *    patch touched, which is what score-extraction.ts grades extraction against.
 *
 * One corpus per invocation; the split name is the file name, and `run.ts`
 * takes it as `--split`.
 *
 *   GITHUB_TOKEN=... bun verification_bench/scripts/build-corpus-v2.ts \
 *     --repo scikit-learn/scikit-learn --split skl-dev
 *
 * Run ONCE per corpus. Output is frozen and pinned in SPLITS.sha256.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Corpus, CorpusIssue } from '../../bench/scripts/build-corpus';
import {
  chunk,
  describe,
  fetchIssues,
  fetchRetry,
  graphql,
  issueChars,
  lcg,
  MAX_CHARS,
  MIN_CHARS,
  resolveIssueNumbers,
  stratify,
  toCorpusIssue,
} from './build-corpus';

const SWEBENCH = 'SWE-bench/SWE-bench';
const SWEBENCH_SPLIT = 'test';
const ROWS_URL = 'https://datasets-server.huggingface.co/rows';
const OUT_DIR = join(import.meta.dirname, '..', 'corpus');

/** `citedIssueNumbers` in the grader only matches `#\d{2,6}`, so a one-digit
 *  issue number could never be cited and its questions would be unscoreable. */
const MIN_ISSUE_NUMBER = 10;

const arg = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`missing required ${flag}`);
  return v ?? fallback!;
};

// ---------------------------------------------------------------------------
// SWE-bench: PR numbers and the files their gold patch touched
// ---------------------------------------------------------------------------

async function swebenchPatches(repo: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  let offset = 0;
  for (;;) {
    const url = `${ROWS_URL}?dataset=${encodeURIComponent(SWEBENCH)}&config=default&split=${SWEBENCH_SPLIT}&offset=${offset}&length=100&columns=instance_id,repo,patch`;
    const json = (await (await fetchRetry(url)).json()) as {
      rows: { row: { instance_id: string; repo: string; patch: string } }[];
      num_rows_total: number;
    };
    for (const { row } of json.rows) {
      if (row.repo !== repo) continue;
      const pr = Number(row.instance_id.split('-').pop());
      if (!Number.isFinite(pr)) continue;
      const files = [...(row.patch ?? '').matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
      out.set(pr, files);
    }
    offset += 100;
    process.stdout.write(`\r  scanned ${Math.min(offset, json.num_rows_total)}/${json.num_rows_total} rows, ${out.size} ${repo} instances`);
    if (offset >= json.num_rows_total) break;
  }
  console.log();
  return out;
}

// ---------------------------------------------------------------------------
// The OPEN supplement
// ---------------------------------------------------------------------------

/** Every open issue number, cheaply — numbers only, 100 per request. */
async function openIssueNumbers(owner: string, repo: string): Promise<number[]> {
  const numbers: number[] = [];
  let cursor: string | null = null;
  for (;;) {
    const after: string = cursor ? `, after: "${cursor}"` : '';
    const data = await graphql<{
      repository: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { number: number }[] } };
    }>(
      `query { repository(owner: "${owner}", name: "${repo}") {
         issues(states: OPEN, first: 100${after}, orderBy: {field: CREATED_AT, direction: ASC}) {
           pageInfo { hasNextPage endCursor } nodes { number } } } }`,
    );
    const page = data.repository.issues;
    for (const n of page.nodes) numbers.push(n.number);
    process.stdout.write(`\r  listed ${numbers.length} open issue numbers`);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  console.log();
  return numbers;
}

// ---------------------------------------------------------------------------

/** Shared eligibility rules — identical to build-corpus.ts, plus the number floor. */
function eligible(issue: CorpusIssue, statedComments: number, rejected: Record<string, number>): boolean {
  const reject = (why: string) => {
    rejected[why] = (rejected[why] ?? 0) + 1;
    return false;
  };
  if (issue.number < MIN_ISSUE_NUMBER) return reject('lowNumber');
  if (!issue.author) return reject('noAuthor');
  const n = issueChars(issue);
  if (n < MIN_CHARS) return reject('tooSmall');
  if (n > MAX_CHARS) return reject('tooBig');
  // A truncated thread would make every comment-count oracle wrong.
  if (issue.comments.length !== statedComments) return reject('truncated');
  return true;
}

async function main() {
  const repoArg = arg('--repo');
  const split = arg('--split');
  const size = Number(arg('--size', '60'));
  const openFrac = Number(arg('--open-frac', '0.4'));
  const seed = Number(arg('--seed', '20260905'));
  const [owner, repo] = repoArg.split('/');
  if (!owner || !repo) throw new Error(`--repo must be owner/name, got ${repoArg}`);

  const outPath = join(OUT_DIR, `${split}.json`);
  if (existsSync(outPath) && !process.argv.includes('--force')) {
    throw new Error(`${outPath} exists — corpora are frozen. Pass --force only to rebuild deliberately.`);
  }

  const wantOpen = Math.round(size * openFrac);
  const wantLinked = size - wantOpen;
  console.log(`Building ${split}: ${size} issues from ${repoArg} (${wantLinked} SWE-bench-linked + ${wantOpen} open)\n`);

  // --- SWE-bench-linked half ------------------------------------------------
  console.log(`Selecting ${repoArg} instances from ${SWEBENCH} (${SWEBENCH_SPLIT})...`);
  const patches = await swebenchPatches(repoArg);
  const prs = [...patches.keys()].sort((a, b) => a - b);
  console.log(`  ${prs.length} distinct resolving PRs`);

  console.log('\nResolving each PR to the issue it closed...');
  const pairs = await resolveIssueNumbers(prs, owner, repo);
  const linkedNumbers = [...new Set(pairs.map((p) => p.issue))].sort((a, b) => a - b);
  console.log(`  ${linkedNumbers.length} distinct referenced issue numbers`);

  console.log('\nFetching those issues from GitHub...');
  const linkedRaw = await fetchIssues(linkedNumbers, owner, repo);

  const rejected: Record<string, number> = { lowNumber: 0, noAuthor: 0, tooSmall: 0, tooBig: 0, truncated: 0 };
  const linked: CorpusIssue[] = [];
  for (const [, g] of [...linkedRaw.entries()].sort((a, b) => a[0] - b[0])) {
    const issue = toCorpusIssue(g);
    if (eligible(issue, g.comments.totalCount, rejected)) linked.push(issue);
  }
  console.log(`  ${linked.length} eligible linked issues (rejected ${JSON.stringify(rejected)})`);

  // --- OPEN supplement ------------------------------------------------------
  console.log('\nListing open issues...');
  const allOpen = await openIssueNumbers(owner, repo);
  const linkedSet = new Set(linked.map((i) => i.number));
  const candidates = allOpen.filter((n) => n >= MIN_ISSUE_NUMBER && !linkedSet.has(n));

  // Sample across the WHOLE open history, not the newest page — otherwise every
  // open issue lands in one or two months and the date questions go degenerate.
  const rand = lcg(seed);
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Over-fetch: some will fail the filters, and stratify wants room to choose.
  const probe = shuffled.slice(0, Math.min(shuffled.length, Math.max(wantOpen * 3, size + 30)));
  console.log(`  ${candidates.length} open candidates, fetching ${probe.length}`);
  const openRaw = await fetchIssues(probe.sort((a, b) => a - b), owner, repo);

  const openRejected: Record<string, number> = { lowNumber: 0, noAuthor: 0, tooSmall: 0, tooBig: 0, truncated: 0 };
  const open: CorpusIssue[] = [];
  for (const [, g] of [...openRaw.entries()].sort((a, b) => a[0] - b[0])) {
    const issue = toCorpusIssue(g);
    if (issue.state !== 'OPEN') continue;
    if (eligible(issue, g.comments.totalCount, openRejected)) open.push(issue);
  }
  console.log(`  ${open.length} eligible open issues (rejected ${JSON.stringify(openRejected)})`);

  // --- Compose --------------------------------------------------------------
  // The linked half can itself contain open issues (a PR referenced an issue
  // that was never actually closed); count those toward the open quota rather
  // than double-counting them.
  const linkedOpen = linked.filter((i) => i.state === 'OPEN');
  const linkedClosed = linked.filter((i) => i.state === 'CLOSED');
  const takeClosed = stratify(linkedClosed, lcg(seed)).slice(0, wantLinked);
  const openPool = stratify([...linkedOpen, ...open], lcg(seed + 1));
  const takeOpen = openPool.slice(0, Math.max(0, size - takeClosed.length));

  const issues = [...takeClosed, ...takeOpen].sort((a, b) => a.number - b.number);
  if (issues.length < size) {
    throw new Error(`only ${issues.length} issues available for ${split}, need ${size} ` +
      `(${takeClosed.length} closed + ${takeOpen.length} open)`);
  }

  const picked = new Set(issues.map((i) => i.number));
  const provenance = pairs
    .filter((p) => picked.has(p.issue))
    .map((p) => ({ ...p, files: patches.get(p.pr) ?? [] }));

  mkdirSync(OUT_DIR, { recursive: true });
  const corpus: Corpus & { meta: Record<string, unknown> } = {
    meta: {
      source: `${SWEBENCH}:${SWEBENCH_SPLIT} + open-issue supplement -> github.com/${repoArg} (live GraphQL)`,
      builtAt: new Date().toISOString(),
      seed,
      owner,
      repo,
      split,
      count: issues.length,
      composition: {
        swebenchLinked: issues.filter((i) => picked.has(i.number) && linkedSet.has(i.number)).length,
        openSupplement: issues.filter((i) => !linkedSet.has(i.number)).length,
        open: issues.filter((i) => i.state === 'OPEN').length,
        closed: issues.filter((i) => i.state === 'CLOSED').length,
      },
      swebench: { dataset: SWEBENCH, split: SWEBENCH_SPLIT, pairs: provenance },
    },
    issues,
  } as never;

  writeFileSync(outPath, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(`\n${describe(split, issues)}`);
  console.log(`  swebench-linked=${(corpus.meta.composition as any).swebenchLinked} ` +
    `openSupplement=${(corpus.meta.composition as any).openSupplement} ` +
    `gradeableForExtraction=${provenance.filter((p) => p.files.length > 0).length} pairs`);
  console.log(`  -> ${outPath}`);
}

if (import.meta.main) await main();

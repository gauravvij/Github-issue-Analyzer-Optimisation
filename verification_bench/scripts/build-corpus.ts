/**
 * Build the frozen verification corpus: real `sympy/sympy` GitHub issues,
 * selected by SWE-bench.
 *
 * SWE-bench's role here is SELECTION, not content. Each SWE-bench instance id
 * (`sympy__sympy-<pr>`) names a merged PR; GitHub's `closingIssuesReferences`
 * gives the issue that PR resolved, and the issue itself is then fetched from
 * GitHub in the exact shape `src/services/github.ts` returns — so the fake
 * GitHub server can serve it with no transformation and the SUT needs no
 * change. Unlike bench/'s corpus (scraped, comment authors and per-user
 * reactions synthesised) every field here is real.
 *
 * django was the obvious first choice — it has the most SWE-bench instances —
 * but django/django has GitHub Issues DISABLED (bugs live in Trac), so its
 * SWE-bench problem statements have no GitHub issue behind them at all. sympy
 * is the largest SWE-bench repo that actually uses GitHub Issues.
 *
 * Run ONCE. The output is frozen and pinned in SPLITS.sha256; rebuilding
 * invalidates every score recorded against the old splits.
 *
 *   GITHUB_TOKEN=... bun verification_bench/scripts/build-corpus.ts
 *
 * The GitHub plumbing below is additionally EXPORTED for build-corpus-v2.ts,
 * which builds the multi-repo v2 corpora. That is the only reason anything here
 * is exported or takes an owner/repo argument; `main()` and the sympy corpus it
 * produced are unchanged, and corpus/{dev,holdout}.json still match SPLITS.sha256.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Corpus, CorpusComment, CorpusIssue } from '../../bench/scripts/build-corpus';

const SWEBENCH = 'SWE-bench/SWE-bench';
const SWEBENCH_SPLIT = 'test';
const ROWS_URL = 'https://datasets-server.huggingface.co/rows';
const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com/graphql';
const OWNER = 'sympy';
const REPO = 'sympy';
const OUT_DIR = join(import.meta.dirname, '..', 'corpus');

const DEV_SIZE = 60;
const HOLDOUT_SIZE = 40;
const SEED = 20260904;

/** Same bounds as bench/: too big blows the per-run budget, too small has nothing to extract. */
export const MAX_CHARS = 30_000;
export const MIN_CHARS = 200;

// ---------------------------------------------------------------------------
// SWE-bench selection
// ---------------------------------------------------------------------------

async function swebenchPrNumbers(): Promise<number[]> {
  const prs: number[] = [];
  let offset = 0;
  for (;;) {
    const url = `${ROWS_URL}?dataset=${encodeURIComponent(SWEBENCH)}&config=default&split=${SWEBENCH_SPLIT}&offset=${offset}&length=100&columns=instance_id,repo`;
    const res = await fetchRetry(url);
    const json = (await res.json()) as {
      rows: { row: { instance_id: string; repo: string } }[];
      num_rows_total: number;
    };
    for (const { row } of json.rows) {
      if (row.repo !== `${OWNER}/${REPO}`) continue;
      const n = Number(row.instance_id.split('-').pop());
      if (Number.isFinite(n)) prs.push(n);
    }
    offset += 100;
    process.stdout.write(`\r  scanned ${Math.min(offset, json.num_rows_total)}/${json.num_rows_total} rows, ${prs.length} ${OWNER}/${REPO} instances`);
    if (offset >= json.num_rows_total) break;
  }
  console.log();
  return [...new Set(prs)].sort((a, b) => a - b);
}

export async function fetchRetry(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`fetch failed after retries: ${url}`);
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * PR -> issue resolution.
 *
 * `closingIssuesReferences` is GitHub's own "this PR closes that issue" link,
 * but it is only populated when the PR used a closing keyword in a form GitHub
 * linked at the time. On a 40-PR sample of sympy that covered 45%; another 45%
 * state the same thing in the body with the same keywords GitHub itself parses
 * ("Fixes #123"), and 10% reference no issue at all. Both forms are used, so
 * the corpus is not biased toward PRs that happened to use the modern linking.
 *
 * Batched with aliases — resolution asks only for numbers, so 25 PRs fit in one
 * request; the full issue fetch is heavier and goes 10 at a time.
 */
export const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d{3,6})/gi;

export const ISSUE_FIELDS = `
  id
  number
  title
  bodyText
  createdAt
  updatedAt
  closedAt
  state
  author { login ... on User { name company } }
  labels(first: 50) { nodes { name description color } }
  reactions(first: 100) { totalCount nodes { content user { login } } }
  comments(first: 100) {
    totalCount
    nodes {
      id
      bodyText
      createdAt
      author { login }
      reactions(first: 100) { totalCount nodes { content user { login } } }
    }
  }`;

export interface GqlIssue {
  id: string;
  number: number;
  title: string;
  bodyText: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  state: string;
  author: { login: string; name?: string | null; company?: string | null } | null;
  labels: { nodes: { name: string; description: string | null; color: string | null }[] };
  reactions: { totalCount: number; nodes: { content: string; user: { login: string } | null }[] };
  comments: {
    totalCount: number;
    nodes: {
      id: string;
      bodyText: string;
      createdAt: string;
      author: { login: string } | null;
      reactions: { totalCount: number; nodes: { content: string; user: { login: string } | null }[] };
    }[];
  };
}

export async function graphql<T>(query: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required to build the corpus (GitHub GraphQL needs auth)');
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(GITHUB_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: T; errors?: { message: string; type?: string }[] };
      // A missing PR/issue comes back as a NOT_FOUND error next to usable data.
      const fatal = (json.errors ?? []).filter((e) => e.type !== 'NOT_FOUND');
      if (fatal.length) throw new Error(`GraphQL: ${JSON.stringify(fatal)}`);
      return json.data as T;
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      if (!/rate limit|secondary/i.test(body)) throw new Error(`GitHub HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error('GitHub GraphQL: max retries exceeded');
}

export const chunk = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** For each PR, the issue numbers it closed. */
export async function resolveIssueNumbers(
  prs: number[],
  owner = OWNER,
  repo = REPO,
): Promise<{ pr: number; issue: number }[]> {
  const pairs: { pr: number; issue: number }[] = [];
  let done = 0;
  for (const batch of chunk(prs, 25)) {
    const parts = batch
      .map((n) => `p${n}: pullRequest(number: ${n}) { bodyText closingIssuesReferences(first: 5) { nodes { number } } }`)
      .join('\n      ');
    const data = await graphql<{
      repository: Record<string, { bodyText: string | null; closingIssuesReferences: { nodes: { number: number }[] } } | null>;
    }>(`query { repository(owner: "${owner}", name: "${repo}") { ${parts} } }`);

    for (const n of batch) {
      const node = data.repository?.[`p${n}`];
      if (!node) continue;
      const linked = node.closingIssuesReferences.nodes.map((x) => x.number);
      if (linked.length === 0) {
        for (const m of (node.bodyText ?? '').matchAll(CLOSING_KEYWORD)) linked.push(Number(m[1]));
      }
      for (const issue of new Set(linked)) pairs.push({ pr: n, issue });
    }
    done += batch.length;
    process.stdout.write(`\r  resolved ${done}/${prs.length} PRs -> ${pairs.length} (pr, issue) pairs`);
  }
  console.log();
  return pairs;
}

/** Fetch each issue in the shape src/services/github.ts returns. */
export async function fetchIssues(
  numbers: number[],
  owner = OWNER,
  repo = REPO,
): Promise<Map<number, GqlIssue>> {
  const out = new Map<number, GqlIssue>();
  let done = 0;
  for (const batch of chunk(numbers, 10)) {
    const parts = batch.map((n) => `i${n}: issue(number: ${n}) { ${ISSUE_FIELDS} }`).join('\n      ');
    const data = await graphql<{ repository: Record<string, GqlIssue | null> }>(
      `query { repository(owner: "${owner}", name: "${repo}") { ${parts} } }`,
    );
    for (const n of batch) {
      const g = data.repository?.[`i${n}`];
      // A closing reference can point at a PR, not an issue; those come back null.
      if (g) out.set(n, g);
    }
    done += batch.length;
    process.stdout.write(`\r  fetched ${done}/${numbers.length} issue numbers -> ${out.size} real issues`);
  }
  console.log();
  return out;
}

export function toCorpusIssue(g: GqlIssue): CorpusIssue {
  const comments: CorpusComment[] = g.comments.nodes.map((c) => ({
    id: c.id,
    bodyText: c.bodyText,
    createdAt: c.createdAt,
    // The corpus type models comment authors as null (bench/'s source dataset
    // dropped them). Real logins are preserved instead, which the SUT reads
    // through the same field.
    author: (c.author?.login ? { login: c.author.login } : null) as CorpusComment['author'],
    reactions: {
      nodes: c.reactions.nodes
        .filter((r) => r.user?.login)
        .map((r) => ({ content: r.content, user: { login: r.user!.login } })),
      totalCount: c.reactions.totalCount,
    } as CorpusComment['reactions'],
  }));

  const reactionNodes = g.reactions.nodes
    .filter((r) => r.user?.login)
    .map((r) => ({ content: r.content, user: { login: r.user!.login } }));

  return {
    id: g.id,
    number: g.number,
    title: g.title,
    bodyText: g.bodyText ?? '',
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    closedAt: g.closedAt,
    state: g.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    author: g.author?.login
      ? { login: g.author.login, name: (g.author.name ?? null) as null, company: (g.author.company ?? null) as null }
      : null,
    labels: { nodes: g.labels.nodes },
    reactions: { nodes: reactionNodes, totalCount: reactionNodes.length },
    totalComments: comments.length,
    comments,
  };
}

// ---------------------------------------------------------------------------
// Splitting — same discipline as bench/scripts/build-corpus.ts
// ---------------------------------------------------------------------------

export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function stratify(issues: CorpusIssue[], rand: () => number): CorpusIssue[] {
  const key = (i: CorpusIssue) =>
    `${i.state}|${i.labels.nodes.length > 0 ? 'lbl' : 'nolbl'}|${
      i.totalComments === 0 ? 'q' : i.totalComments < 6 ? 'm' : 'busy'
    }`;

  const buckets = new Map<string, CorpusIssue[]>();
  for (const i of issues) {
    const k = key(i);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(i);
  }
  for (const list of buckets.values()) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  const order = [...buckets.keys()].sort();
  const out: CorpusIssue[] = [];
  let drained = false;
  while (!drained) {
    drained = true;
    for (const k of order) {
      const next = buckets.get(k)!.shift();
      if (next) {
        out.push(next);
        drained = false;
      }
    }
  }
  return out;
}

export function issueChars(i: CorpusIssue): number {
  return i.bodyText.length + i.comments.reduce((s, c) => s + c.bodyText.length, 0);
}

export function describe(split: string, issues: CorpusIssue[]): string {
  const open = issues.filter((i) => i.state === 'OPEN').length;
  const labelled = issues.filter((i) => i.labels.nodes.length > 0).length;
  const comments = issues.reduce((s, i) => s + i.totalComments, 0);
  const labels = new Set(issues.flatMap((i) => i.labels.nodes.map((l) => l.name)));
  const authors = new Set(issues.map((i) => i.author?.login).filter(Boolean));
  const chars = issues.reduce((s, i) => s + issueChars(i), 0);
  return [
    `${split}: ${issues.length} issues (${open} open / ${issues.length - open} closed)`,
    `  labelled=${labelled} distinctLabels=${labels.size} authors=${authors.size}`,
    `  comments=${comments} totalChars=${chars.toLocaleString()} (~${Math.round(chars / 4).toLocaleString()} tokens)`,
  ].join('\n');
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Selecting ${OWNER}/${REPO} instances from ${SWEBENCH} (${SWEBENCH_SPLIT})...`);
  const prs = await swebenchPrNumbers();
  console.log(`  ${prs.length} distinct resolving PRs`);

  console.log('\nResolving each PR to the issue it closed...');
  const pairs = await resolveIssueNumbers(prs);
  const wanted = [...new Set(pairs.map((p) => p.issue))].sort((a, b) => a - b);
  console.log(`  ${wanted.length} distinct referenced issue numbers`);

  console.log('\nFetching those issues from GitHub...');
  const fetched = await fetchIssues(wanted);

  const byNumber = new Map<number, CorpusIssue>();
  const rejected = { noAuthor: 0, tooSmall: 0, tooBig: 0, truncated: 0 };
  for (const [number, g] of [...fetched.entries()].sort((a, b) => a[0] - b[0])) {
    const issue = toCorpusIssue(g);
    if (!issue.author) {
      rejected.noAuthor++;
      continue;
    }
    const n = issueChars(issue);
    if (n < MIN_CHARS) {
      rejected.tooSmall++;
      continue;
    }
    if (n > MAX_CHARS) {
      rejected.tooBig++;
      continue;
    }
    // A truncated thread would make the comment-count oracles wrong.
    if (issue.comments.length !== g.comments.totalCount) {
      rejected.truncated++;
      continue;
    }
    byNumber.set(number, issue);
  }
  const provenance = pairs.filter((p) => byNumber.has(p.issue));
  console.log(
    `  ${byNumber.size} eligible issues (rejected: ${rejected.noAuthor} no author, ` +
      `${rejected.tooSmall} < ${MIN_CHARS} chars, ${rejected.tooBig} > ${MAX_CHARS} chars, ` +
      `${rejected.truncated} with >100 comments)`,
  );

  const eligible = [...byNumber.values()].sort((a, b) => a.number - b.number);
  if (eligible.length < DEV_SIZE + HOLDOUT_SIZE) {
    throw new Error(`only ${eligible.length} eligible issues, need ${DEV_SIZE + HOLDOUT_SIZE}`);
  }

  // Deal across the stratified order instead of slicing a prefix off it.
  // SWE-bench only contains issues that were resolved by a merged PR, so OPEN
  // issues are rare (8 of the first 100 here) and a prefix slice put every one
  // of them in dev, leaving holdout 100% closed — which makes `open_count`
  // degenerate exactly where the champion's one real improvement lives.
  const ordered = stratify(eligible, lcg(SEED));
  const devPick: CorpusIssue[] = [];
  const holdoutPick: CorpusIssue[] = [];
  for (const issue of ordered) {
    if (devPick.length >= DEV_SIZE && holdoutPick.length >= HOLDOUT_SIZE) break;
    // Whichever split is further below its share of what has been dealt so far.
    const devShort = devPick.length / DEV_SIZE;
    const holdoutShort = holdoutPick.length / HOLDOUT_SIZE;
    const toDev = holdoutPick.length >= HOLDOUT_SIZE || (devPick.length < DEV_SIZE && devShort <= holdoutShort);
    (toDev ? devPick : holdoutPick).push(issue);
  }
  const dev = devPick.sort((a, b) => a.number - b.number);
  const holdout = holdoutPick.sort((a, b) => a.number - b.number);

  const overlap = new Set(dev.map((i) => i.number));
  for (const i of holdout) if (overlap.has(i.number)) throw new Error(`split overlap on #${i.number}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const builtAt = new Date().toISOString();
  for (const [split, issues] of [
    ['dev', dev],
    ['holdout', holdout],
  ] as const) {
    const picked = new Set(issues.map((i) => i.number));
    const corpus: Corpus & { meta: { swebench: { dataset: string; split: string; pairs: { pr: number; issue: number }[] } } } = {
      meta: {
        source: `${SWEBENCH}:${SWEBENCH_SPLIT} -> github.com/${OWNER}/${REPO} (live GraphQL)`,
        builtAt,
        seed: SEED,
        owner: OWNER,
        repo: REPO,
        split,
        count: issues.length,
        swebench: {
          dataset: SWEBENCH,
          split: SWEBENCH_SPLIT,
          pairs: provenance.filter((p) => picked.has(p.issue)),
        },
      },
      issues,
    };
    const path = join(OUT_DIR, `${split}.json`);
    writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`);
    console.log(`\n${describe(split, issues)}\n  -> ${path}`);
  }
}

if (import.meta.main) await main();

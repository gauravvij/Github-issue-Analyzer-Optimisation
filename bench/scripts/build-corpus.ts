/**
 * Build the frozen benchmark corpus from the HuggingFace dataset
 * `helmo/github-issues` (7,540 rows scraped from github.com/huggingface/datasets).
 *
 * Output: bench/corpus/dev.json (60 issues) + bench/corpus/holdout.json (40 issues),
 * disjoint, in the exact shape the SUT's GitHub GraphQL client returns — so the
 * fake GitHub server can serve them without any transformation.
 *
 * Run ONCE. The output is committed and frozen; rebuilding invalidates every
 * score ever recorded against the old splits.
 *
 *   bun bench/scripts/build-corpus.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATASET = 'helmo/github-issues';
const ROWS_URL = 'https://datasets-server.huggingface.co/rows';
const OUT_DIR = join(import.meta.dirname, '..', 'corpus');

const DEV_SIZE = 60;
const HOLDOUT_SIZE = 40;
const SEED = 20260903;

/** Issues bigger than this go to OpenAI as-is and blow the per-run budget. */
const MAX_CHARS = 30_000;
/** Below this there is nothing for the analyzer to extract. */
const MIN_CHARS = 200;

// --- dataset row shape (only the fields we use) -----------------------------

interface HfLabel {
  name: string;
  description: string | null;
  color: string | null;
}
interface HfRow {
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: { login: string } | null;
  labels: HfLabel[] | null;
  comments: string[] | null;
  reactions: Record<string, number | string> | null;
  pull_request: unknown | null;
}

// --- corpus shape (mirrors src/services/neo4j.ts GitHubIssue + comments) ----

export interface CorpusComment {
  id: string;
  bodyText: string;
  createdAt: string;
  author: null;
  reactions: { nodes: []; totalCount: 0 };
}

export interface CorpusIssue {
  id: string;
  number: number;
  title: string;
  bodyText: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  state: 'OPEN' | 'CLOSED';
  author: { login: string; name: null; company: null } | null;
  labels: { nodes: HfLabel[] };
  reactions: { nodes: { content: string; user: { login: string } }[]; totalCount: number };
  totalComments: number;
  comments: CorpusComment[];
}

export interface Corpus {
  meta: {
    source: string;
    builtAt: string;
    seed: number;
    owner: string;
    repo: string;
    split: string;
    count: number;
  };
  issues: CorpusIssue[];
}

// GitHub REST reaction keys -> GraphQL ReactionContent enum.
const REACTION_ENUM: Record<string, string> = {
  '+1': 'THUMBS_UP',
  '-1': 'THUMBS_DOWN',
  laugh: 'LAUGH',
  hooray: 'HOORAY',
  confused: 'CONFUSED',
  heart: 'HEART',
  rocket: 'ROCKET',
  eyes: 'EYES',
};

async function fetchRows(offset: number, length: number): Promise<HfRow[]> {
  const url = `${ROWS_URL}?dataset=${encodeURIComponent(DATASET)}&config=default&split=train&offset=${offset}&length=${length}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const json = (await res.json()) as { rows: { row: HfRow }[] };
      return json.rows.map((r) => r.row);
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`datasets-server failed for offset=${offset}`);
}

/** Deterministic PRNG so a rebuild from the same seed yields the same splits. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function issueChars(r: HfRow): number {
  return (r.body ?? '').length + (r.comments ?? []).join('').length;
}

function toCorpusIssue(r: HfRow): CorpusIssue {
  const created = new Date(r.created_at).getTime();

  // The dataset only stores comment *bodies* — no ids, no authors. Synthesise
  // stable ids (the analyzer keys extraction provenance off commentId) and
  // monotonic timestamps. Comment authorship is a known fidelity gap: the
  // benchmark question set never asks who wrote a comment.
  const comments: CorpusComment[] = (r.comments ?? []).map((text, i) => ({
    id: `IC_${r.number}_${i}`,
    bodyText: text,
    createdAt: new Date(created + (i + 1) * 3_600_000).toISOString(),
    author: null,
    reactions: { nodes: [], totalCount: 0 },
  }));

  // The dataset stores aggregate reaction counts, not per-user reactions. The
  // graph models reactions per user, so expand counts into synthetic reactors.
  // Deterministic and internally consistent; the oracle knows the same truth.
  const reactionNodes: { content: string; user: { login: string } }[] = [];
  for (const [key, enumName] of Object.entries(REACTION_ENUM)) {
    const n = Number(r.reactions?.[key] ?? 0);
    for (let i = 0; i < n; i++) {
      reactionNodes.push({ content: enumName, user: { login: `reactor-${r.number}-${key}-${i}` } });
    }
  }

  return {
    id: r.node_id,
    number: r.number,
    title: r.title,
    bodyText: r.body ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
    state: r.state === 'closed' ? 'CLOSED' : 'OPEN',
    author: r.user?.login ? { login: r.user.login, name: null, company: null } : null,
    labels: { nodes: r.labels ?? [] },
    reactions: { nodes: reactionNodes, totalCount: reactionNodes.length },
    totalComments: comments.length,
    comments,
  };
}

/**
 * Interleave issues across strata so both splits contain open+closed, labelled
 * and unlabelled, quiet and busy threads. A flat shuffle leaves whole question
 * templates with no data to ask about.
 */
function stratify(issues: CorpusIssue[], rand: () => number): CorpusIssue[] {
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

function describe(split: string, issues: CorpusIssue[]): string {
  const open = issues.filter((i) => i.state === 'OPEN').length;
  const labelled = issues.filter((i) => i.labels.nodes.length > 0).length;
  const withComments = issues.filter((i) => i.totalComments > 0).length;
  const withReactions = issues.filter((i) => i.reactions.totalCount > 0).length;
  const comments = issues.reduce((s, i) => s + i.totalComments, 0);
  const chars = issues.reduce((s, i) => s + i.bodyText.length + i.comments.reduce((t, c) => t + c.bodyText.length, 0), 0);
  const labels = new Set(issues.flatMap((i) => i.labels.nodes.map((l) => l.name)));
  const authors = new Set(issues.map((i) => i.author?.login).filter(Boolean));
  return [
    `${split}: ${issues.length} issues (${open} open / ${issues.length - open} closed)`,
    `  labelled=${labelled} distinctLabels=${labels.size} authors=${authors.size}`,
    `  comments=${comments} (issues with comments=${withComments}) reactions on ${withReactions} issues`,
    `  total chars=${chars.toLocaleString()} (~${Math.round(chars / 4).toLocaleString()} tokens)`,
  ].join('\n');
}

async function main() {
  console.log(`Fetching candidates from ${DATASET}...`);
  const candidates: HfRow[] = [];
  // 7,540 rows; sample 30 pages of 100 spread evenly for variety across time.
  for (let off = 0; off < 7540; off += 250) {
    candidates.push(...(await fetchRows(off, 100)));
    process.stdout.write(`\r  ${candidates.length} rows`);
  }
  console.log(`\n  ${candidates.length} rows fetched`);

  const seen = new Set<number>();
  const eligible = candidates
    .filter((r) => r.pull_request === null)
    .filter((r) => r.user?.login)
    .filter((r) => {
      const n = issueChars(r);
      return n >= MIN_CHARS && n <= MAX_CHARS;
    })
    .filter((r) => (seen.has(r.number) ? false : (seen.add(r.number), true)))
    .sort((a, b) => a.number - b.number)
    .map(toCorpusIssue);

  console.log(`  ${eligible.length} eligible issues after filtering`);
  if (eligible.length < DEV_SIZE + HOLDOUT_SIZE) {
    throw new Error(`only ${eligible.length} eligible, need ${DEV_SIZE + HOLDOUT_SIZE}`);
  }

  const ordered = stratify(eligible, lcg(SEED));
  const dev = ordered.slice(0, DEV_SIZE).sort((a, b) => a.number - b.number);
  const holdout = ordered.slice(DEV_SIZE, DEV_SIZE + HOLDOUT_SIZE).sort((a, b) => a.number - b.number);

  const overlap = new Set(dev.map((i) => i.number));
  for (const i of holdout) if (overlap.has(i.number)) throw new Error(`split overlap on #${i.number}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const builtAt = new Date().toISOString();
  for (const [split, issues] of [
    ['dev', dev],
    ['holdout', holdout],
  ] as const) {
    const corpus: Corpus = {
      meta: {
        source: DATASET,
        builtAt,
        seed: SEED,
        owner: 'huggingface',
        repo: 'datasets',
        split,
        count: issues.length,
      },
      issues,
    };
    const path = join(OUT_DIR, `${split}.json`);
    writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`);
    console.log(`\n${describe(split, issues)}\n  -> ${path}`);
  }
}

main();

/**
 * In-process fake GitHub GraphQL server backed by a frozen corpus file.
 *
 * Why: running the ingestion pipeline against real github.com makes every
 * measurement depend on network weather and rate limits — the previous
 * auto-research loop lost runs to exactly that ("NET-FLAKE"). Serving the
 * corpus locally makes ingestion latency, request counts and concurrency
 * deterministic and reproducible.
 *
 * It implements only the two queries `src/services/github.ts` actually sends,
 * including comment and reaction pagination, `states` and `since` filters.
 *
 * `latencyMs` is a *fixed* simulated per-request delay. Without it every
 * request costs ~0ms on loopback and the sequential-vs-concurrent fetching
 * difference that plan.md targets would be invisible.
 */

import type { Corpus, CorpusIssue } from '../scripts/build-corpus';

const PAGE_SIZE = 100;

export interface GitHubStats {
  /** Total GraphQL requests served. */
  requests: number;
  /** Requests for the issue-number listing query. */
  listingRequests: number;
  /** Requests for the complete-issue query. */
  issueRequests: number;
  /** High-water mark of concurrent in-flight requests — 1 means fully serial. */
  maxConcurrent: number;
  /** Wall time the server spent with at least one request in flight. */
  busyMs: number;
}

export interface FakeGitHub {
  url: string;
  stats: GitHubStats;
  reset(): void;
  stop(): Promise<void>;
}

function cursorIndex(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(String(cursor).replace('cur:', ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function page<T>(items: T[], after: string | null | undefined) {
  const start = cursorIndex(after);
  const slice = items.slice(start, start + PAGE_SIZE);
  const end = start + slice.length;
  return {
    nodes: slice,
    pageInfo: { hasNextPage: end < items.length, endCursor: `cur:${end}` },
    totalCount: items.length,
  };
}

export function startFakeGitHub(corpus: Corpus, opts: { latencyMs?: number } = {}): FakeGitHub {
  const latencyMs = opts.latencyMs ?? 0;
  const byNumber = new Map<number, CorpusIssue>(corpus.issues.map((i) => [i.number, i]));

  const stats: GitHubStats = {
    requests: 0,
    listingRequests: 0,
    issueRequests: 0,
    maxConcurrent: 0,
    busyMs: 0,
  };
  let inFlight = 0;
  let busyStart = 0;

  function listing(vars: Record<string, unknown>) {
    stats.listingRequests++;
    const states = (vars.states as string[] | undefined) ?? ['OPEN', 'CLOSED'];
    const since = vars.since as string | null | undefined;
    const sinceMs = since ? new Date(since).getTime() : null;

    // GitHub returns issues newest-updated first when filterBy.since is used;
    // it returns them by number ascending otherwise. Number ascending is stable
    // and is what the pipeline's `limit` slicing assumes.
    const matching = corpus.issues
      .filter((i) => states.includes(i.state))
      .filter((i) => sinceMs === null || new Date(i.updatedAt).getTime() >= sinceMs)
      .sort((a, b) => a.number - b.number);

    const p = page(matching, vars.after as string | null);
    return {
      repository: {
        issues: {
          nodes: p.nodes.map((i) => ({
            number: i.number,
            title: i.title,
            createdAt: i.createdAt,
            updatedAt: i.updatedAt,
            state: i.state,
          })),
          pageInfo: p.pageInfo,
          totalCount: p.totalCount,
        },
      },
    };
  }

  function completeIssue(vars: Record<string, unknown>) {
    stats.issueRequests++;
    const issue = byNumber.get(vars.issueNumber as number);
    if (!issue) return { repository: { issue: null } };

    const comments = page(issue.comments, vars.commentsAfter as string | null);
    const reactions = page(issue.reactions.nodes, vars.reactionsAfter as string | null);

    return {
      repository: {
        issue: {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          bodyText: issue.bodyText,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          closedAt: issue.closedAt,
          state: issue.state,
          author: issue.author,
          labels: issue.labels,
          reactions,
          comments: {
            nodes: comments.nodes.map((c) => ({
              id: c.id,
              bodyText: c.bodyText,
              createdAt: c.createdAt,
              author: c.author,
              reactions: c.reactions,
            })),
            pageInfo: comments.pageInfo,
            totalCount: issue.comments.length,
          },
        },
      },
    };
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

      if (inFlight === 0) busyStart = performance.now();
      inFlight++;
      stats.requests++;
      if (inFlight > stats.maxConcurrent) stats.maxConcurrent = inFlight;

      try {
        const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
        if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));

        const vars = body.variables ?? {};
        const data = vars.issueNumber !== undefined ? completeIssue(vars) : listing(vars);
        return Response.json({ data });
      } catch (err) {
        return Response.json({ errors: [{ message: String(err) }] }, { status: 200 });
      } finally {
        inFlight--;
        if (inFlight === 0) stats.busyMs += performance.now() - busyStart;
      }
    },
  });

  return {
    url: `http://localhost:${server.port}/graphql`,
    stats,
    reset() {
      stats.requests = 0;
      stats.listingRequests = 0;
      stats.issueRequests = 0;
      stats.maxConcurrent = 0;
      stats.busyMs = 0;
    },
    async stop() {
      await server.stop(true);
    },
  };
}

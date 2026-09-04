/**
 * GitHub GraphQL API — fetches issue data (issue + comments + reactions + labels).
 */

import type { GitHubComment, GitHubIssue, IssueData } from './neo4j';
import { withSpan } from './tracing';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Overridable so the benchmark harness can point the client at a local fixture
// server. Unset in production -> real GitHub.
const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com/graphql';

function requireToken(): string {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN environment variable is required');
  return GITHUB_TOKEN;
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const ISSUE_NUMBERS_QUERY = `
query ($owner: String!, $repo: String!, $after: String, $states: [IssueState!], $since: DateTime) {
  repository(owner: $owner, name: $repo) {
    issues(first: 100, after: $after, states: $states, filterBy: {since: $since}) {
      nodes { number title createdAt updatedAt state }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
}`;

const COMPLETE_ISSUE_DATA_QUERY = `
query ($owner: String!, $repo: String!, $issueNumber: Int!, $commentsAfter: String, $reactionsAfter: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issueNumber) {
      id number title bodyText createdAt updatedAt closedAt state
      author {
        login
        ... on User { name company }
      }
      labels(first: 50) {
        nodes { name description color }
      }
      reactions(first: 100, after: $reactionsAfter) {
        nodes { content user { login } }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
      comments(first: 100, after: $commentsAfter) {
        nodes {
          id bodyText createdAt
          author {
            login
            ... on User { name company }
          }
          reactions(first: 100) {
            nodes { content user { login } }
            totalCount
          }
        }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5;
const RETRY_STATUS_CODES = new Set([429, 500, 502, 503]);

async function graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = requireToken();

  // One span per logical GraphQL call, with a retry event per attempt, so a
  // slow request is distinguishable from a request that was retried three
  // times — they look identical in a wall-clock number.
  return withSpan(
    'github.graphql',
    {
      'http.request.method': 'POST',
      'url.full': GITHUB_API_URL,
      'github.operation': variables.issueNumber === undefined ? 'listIssues' : 'issueDetail',
      ...(variables.issueNumber !== undefined
        ? { 'github.issue_number': variables.issueNumber as number }
        : {}),
    },
    async (span) => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(GITHUB_API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        span.setAttribute('http.response.status_code', res.status);
        span.setAttribute('http.request.resend_count', attempt);

        if (res.ok) {
          const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
          if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
          return json.data as T;
        }

        if (attempt < MAX_RETRIES && RETRY_STATUS_CODES.has(res.status)) {
          const backoff = Math.min(1000 * 2 ** attempt, 30000);
          span.addEvent('retry', { status: res.status, backoff_ms: backoff, attempt: attempt + 1 });
          console.warn(
            `  GitHub API ${res.status}, retrying in ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        throw new Error(`GitHub API HTTP ${res.status}`);
      }

      throw new Error('GitHub API: max retries exceeded');
    },
  );
}

// ---------------------------------------------------------------------------
// Fetch single issue with pagination
// ---------------------------------------------------------------------------

async function fetchCompleteIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueData> {
  return withSpan(
    'github.fetchCompleteIssue',
    { 'github.issue_number': issueNumber, 'github.repo': `${owner}/${repo}` },
    (span) => fetchCompleteIssueInner(owner, repo, issueNumber, span),
  );
}

async function fetchCompleteIssueInner(
  owner: string,
  repo: string,
  issueNumber: number,
  span: import('@opentelemetry/api').Span,
): Promise<IssueData> {
  let allComments: GitHubComment[] = [];
  let hasNextPage = true;
  let commentsAfter: string | null = null;
  let issueData: GitHubIssue | null = null;

  console.log(`  Fetching issue #${issueNumber} from ${owner}/${repo}...`);

  // Paginate through comments
  while (hasNextPage) {
    const data = await graphql<{ repository: { issue: Record<string, unknown> } }>(
      COMPLETE_ISSUE_DATA_QUERY,
      {
        owner,
        repo,
        issueNumber,
        commentsAfter,
      },
    );

    const issue = data.repository?.issue;
    if (!issue) throw new Error(`Issue #${issueNumber} not found`);

    if (!issueData) {
      const comments = issue.comments as {
        nodes: GitHubComment[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
        totalCount: number;
      };
      issueData = {
        id: issue.id as string,
        number: issue.number as number,
        title: issue.title as string,
        bodyText: issue.bodyText as string,
        createdAt: issue.createdAt as string,
        updatedAt: issue.updatedAt as string,
        closedAt: issue.closedAt as string | null,
        state: issue.state as string,
        author: issue.author as GitHubIssue['author'],
        labels: issue.labels as GitHubIssue['labels'],
        reactions: issue.reactions as GitHubIssue['reactions'],
        totalComments: comments.totalCount,
      };
    }

    const commentsPage = issue.comments as {
      nodes: GitHubComment[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
    allComments = allComments.concat(commentsPage.nodes);
    hasNextPage = commentsPage.pageInfo.hasNextPage;
    commentsAfter = commentsPage.pageInfo.endCursor;
  }

  // Paginate through issue reactions
  let allReactions: { content: string; user: { login: string } | null }[] = [];
  let reactionsHasNextPage = true;
  let reactionsAfter: string | null = null;

  while (reactionsHasNextPage) {
    const data = await graphql<{ repository: { issue: Record<string, unknown> } }>(
      COMPLETE_ISSUE_DATA_QUERY,
      {
        owner,
        repo,
        issueNumber,
        commentsAfter: null,
        reactionsAfter,
      },
    );

    const reactions = data.repository.issue.reactions as {
      nodes: { content: string; user: { login: string } | null }[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
    allReactions = allReactions.concat(reactions.nodes);
    reactionsHasNextPage = reactions.pageInfo.hasNextPage;
    reactionsAfter = reactions.pageInfo.endCursor;
  }

  if (issueData) {
    issueData.reactions = { nodes: allReactions, totalCount: allReactions.length };
  }

  span.setAttribute('github.comments_fetched', allComments.length);
  span.setAttribute('github.reactions_fetched', allReactions.length);

  return { issue: issueData!, comments: allComments };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type IssueState = 'open' | 'closed' | 'all';

const STATE_MAP: Record<IssueState, string[]> = {
  open: ['OPEN'],
  closed: ['CLOSED'],
  all: ['OPEN', 'CLOSED'],
};

export interface IssueListing {
  number: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: string;
}

export async function getAllIssueNumbers(
  owner: string,
  repo: string,
  state: IssueState = 'open',
  limit = 0,
  since?: string | null,
): Promise<{ issueNumbers: number[]; issues: IssueListing[]; total: number }> {
  const states = STATE_MAP[state];
  if (!states) throw new Error(`Invalid state: ${state}`);

  let allIssues: IssueListing[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  const sinceLabel = since ? ` (since: ${since})` : '';
  console.log(
    `Fetching ${state} issues from ${owner}/${repo}${limit > 0 ? ` (limit: ${limit})` : ''}${sinceLabel}...`,
  );

  type IssueNumbersResponse = {
    repository: {
      issues: {
        nodes: IssueListing[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
        totalCount: number;
      };
    };
  };

  while (hasNextPage) {
    const data: IssueNumbersResponse = await graphql<IssueNumbersResponse>(ISSUE_NUMBERS_QUERY, {
      owner,
      repo,
      after,
      states,
      since: since ?? null,
    });

    const page = data.repository.issues;
    allIssues = allIssues.concat(page.nodes);
    hasNextPage = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
    console.log(`  Found ${allIssues.length} issues so far...`);

    // Stop early if we have enough
    if (limit > 0 && allIssues.length >= limit) {
      allIssues = allIssues.slice(0, limit);
      break;
    }
  }

  console.log(`Found ${allIssues.length} total ${state} issues`);
  return {
    issueNumbers: allIssues.map((i) => i.number),
    issues: allIssues,
    total: allIssues.length,
  };
}

export async function getIssuesData(
  owner: string,
  repo: string,
  issueNumbers: number[],
): Promise<{ results: IssueData[]; errors: { issueNumber: number; error: string }[] }> {
  // Fetch complete issues concurrently, while keeping output order stable for
  // callers. The worker pool is deliberately bounded so a large repository
  // cannot create an unbounded burst of GraphQL requests.
  const configuredConcurrency = Number.parseInt(process.env.GITHUB_FETCH_CONCURRENCY ?? '1', 10);
  const concurrency = Math.max(
    1,
    Math.min(issueNumbers.length || 1, Number.isFinite(configuredConcurrency) ? configuredConcurrency : 4),
  );
  const resultsByIndex: (IssueData | undefined)[] = new Array(issueNumbers.length);
  const errorsByIndex: ({ issueNumber: number; error: string } | undefined)[] = new Array(
    issueNumbers.length,
  );
  let nextIndex = 0;

  console.log(`Fetching ${issueNumbers.length} issues from ${owner}/${repo} (concurrency ${concurrency})...`);

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= issueNumbers.length) return;

      const num = issueNumbers[index];
      try {
        console.log(`[${index + 1}/${issueNumbers.length}] Issue #${num}...`);
        resultsByIndex[index] = await fetchCompleteIssue(owner, repo, num);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Failed #${num}: ${msg}`);
        errorsByIndex[index] = { issueNumber: num, error: msg };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const results = resultsByIndex.filter((result): result is IssueData => result !== undefined);
  const errors = errorsByIndex.filter(
    (error): error is { issueNumber: number; error: string } => error !== undefined,
  );
  console.log(`Fetch complete: ${results.length} ok, ${errors.length} failed`);
  return { results, errors };
}

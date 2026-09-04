/**
 * Harness self-tests: does the referee actually measure what it claims?
 *
 *   bun test bench/
 *
 * WARNING: these tests reset the benchmark Neo4j database. Do not run them
 * between a `--stage ingest` and a `--stage qa --keep-graph` run.
 *
 * The paths tested here are the ones a wrong number would be discovered late
 * on: transaction-based Neo4j counting (nothing in the SUT uses it *yet* —
 * plan.md H2 will, and its headline metric depends on this counter), integrity
 * checks that must FAIL on a corrupted graph, and graders that must reject
 * near-miss answers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Corpus, CorpusIssue } from './scripts/build-corpus';
import { startFakeGitHub } from './harness/fake-github';
import { costOf, installOpenAIMeter, meterDriver, priceOf, PRICES } from './harness/instrument';
import { citedIssueNumbers, gradeDeterministic } from './harness/grade';
import { checkIntegrity, resetDatabase, startNeo4j, BOLT_URI } from './harness/neo4j';

const SUT = join(import.meta.dirname, '..', 'github_issue');

// ---------------------------------------------------------------------------
// Synthetic corpus exercising the edges the real corpus does not reach
// ---------------------------------------------------------------------------

function makeIssue(n: number, over: Partial<CorpusIssue> = {}): CorpusIssue {
  return {
    id: `ID_${n}`,
    number: n,
    title: `issue ${n}`,
    bodyText: `body ${n}`,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-06-01T00:00:00Z',
    closedAt: null,
    state: 'OPEN',
    author: { login: `user${n}`, name: null, company: null },
    labels: { nodes: [] },
    reactions: { nodes: [], totalCount: 0 },
    totalComments: 0,
    comments: [],
    ...over,
  };
}

const BIG_COMMENTS = 250; // > 2 pages of 100 — the real corpus maxes out at 18
const BIG_REACTIONS = 150;

const synthetic: Corpus = {
  meta: { source: 'synthetic', builtAt: '', seed: 0, owner: 'o', repo: 'r', split: 'test', count: 4 },
  issues: [
    makeIssue(1, {
      totalComments: BIG_COMMENTS,
      comments: Array.from({ length: BIG_COMMENTS }, (_, i) => ({
        id: `IC_1_${i}`,
        bodyText: `comment ${i}`,
        createdAt: new Date(Date.UTC(2024, 0, 1, i)).toISOString(),
        author: null as null,
        reactions: { nodes: [] as [], totalCount: 0 as 0 },
      })),
    }),
    makeIssue(2, {
      reactions: {
        nodes: Array.from({ length: BIG_REACTIONS }, (_, i) => ({
          content: 'THUMBS_UP',
          user: { login: `r${i}` },
        })),
        totalCount: BIG_REACTIONS,
      },
    }),
    makeIssue(3, { state: 'CLOSED', closedAt: '2024-05-01T00:00:00Z', updatedAt: '2024-05-01T00:00:00Z' }),
    makeIssue(4, { updatedAt: '2025-01-01T00:00:00Z' }),
  ],
};

// The SUT reads GITHUB_API_URL at module load, so the server must exist first.
const github = startFakeGitHub(synthetic, { latencyMs: 1 });
process.env.GITHUB_API_URL = github.url;
process.env.GITHUB_TOKEN ||= 'test-token';

// ---------------------------------------------------------------------------

describe('fake GitHub server', () => {
  test('paginates comments beyond one page', async () => {
    const { getIssuesData } = await import(join(SUT, 'src/services/github.ts'));
    const { results, errors } = await getIssuesData('o', 'r', [1]);
    expect(errors).toHaveLength(0);
    expect(results[0].comments).toHaveLength(BIG_COMMENTS);
    expect(results[0].comments[0].id).toBe('IC_1_0');
    expect(results[0].comments[BIG_COMMENTS - 1].id).toBe(`IC_1_${BIG_COMMENTS - 1}`);
    expect(new Set(results[0].comments.map((c: { id: string }) => c.id)).size).toBe(BIG_COMMENTS);
  });

  test('paginates reactions beyond one page', async () => {
    const { getIssuesData } = await import(join(SUT, 'src/services/github.ts'));
    const { results } = await getIssuesData('o', 'r', [2]);
    expect(results[0].issue.reactions.nodes).toHaveLength(BIG_REACTIONS);
  });

  test('honours the states filter', async () => {
    const { getAllIssueNumbers } = await import(join(SUT, 'src/services/github.ts'));
    expect((await getAllIssueNumbers('o', 'r', 'open')).issueNumbers).toEqual([1, 2, 4]);
    expect((await getAllIssueNumbers('o', 'r', 'closed')).issueNumbers).toEqual([3]);
    expect((await getAllIssueNumbers('o', 'r', 'all')).issueNumbers).toEqual([1, 2, 3, 4]);
  });

  test('honours the since filter used by incremental sync', async () => {
    const { getAllIssueNumbers } = await import(join(SUT, 'src/services/github.ts'));
    const r = await getAllIssueNumbers('o', 'r', 'all', 0, '2024-12-01T00:00:00Z');
    expect(r.issueNumbers).toEqual([4]);
  });

  test('honours the limit used by ISSUE_LIMIT', async () => {
    const { getAllIssueNumbers } = await import(join(SUT, 'src/services/github.ts'));
    expect((await getAllIssueNumbers('o', 'r', 'all', 2)).issueNumbers).toEqual([1, 2]);
  });

  test('reports a missing issue as an error rather than silently succeeding', async () => {
    const { getIssuesData } = await import(join(SUT, 'src/services/github.ts'));
    const { results, errors } = await getIssuesData('o', 'r', [999]);
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  test('concurrency counter reads 1 for serial and >1 for parallel', async () => {
    const { getIssuesData } = await import(join(SUT, 'src/services/github.ts'));
    github.reset();
    await getIssuesData('o', 'r', [3, 4]);
    // The SUT fetches strictly serially today; this is the number plan.md H8
    // must move. If the counter itself were broken it could never read 1.
    expect(github.stats.maxConcurrent).toBe(1);

    github.reset();
    const body = JSON.stringify({ query: 'q', variables: { issueNumber: 3 } });
    await Promise.all(
      Array.from({ length: 5 }, () => fetch(github.url, { method: 'POST', body })),
    );
    expect(github.stats.maxConcurrent).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI meter', () => {
  test('counts requests, attributes the model, and reads usage', async () => {
    const meter = installOpenAIMeter();
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
    });
    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: 'k', baseURL: `http://localhost:${srv.port}/v1` });
      await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(meter.stats.requests).toBe(1);
      expect(meter.stats.byModel['gpt-4o-mini'].promptTokens).toBe(1000);
      expect(meter.stats.byModel['gpt-4o-mini'].completionTokens).toBe(500);
      expect(meter.stats.byEndpoint['/chat/completions']).toBe(1);
      const p = PRICES['gpt-4o-mini'];
      expect(meter.costUsd()).toBeCloseTo((1000 / 1e6) * p.in + (500 / 1e6) * p.out, 10);
    } finally {
      meter.uninstall();
      await srv.stop(true);
    }
  });

  test('flags a model with no price instead of silently costing zero', async () => {
    const meter = installOpenAIMeter();
    const srv = Bun.serve({
      port: 0,
      fetch: () => Response.json({ model: 'some-new-model', usage: { prompt_tokens: 9, completion_tokens: 9 } }),
    });
    try {
      await fetch(`http://localhost:${srv.port}/v1/openai/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'some-new-model' }),
      });
      expect(meter.costUsd()).toBe(0);
      expect(meter.stats.unpricedModels).toContain('some-new-model');
    } finally {
      meter.uninstall();
      await srv.stop(true);
    }
  });

  test('meters a proxied base URL, not just api.openai.com', async () => {
    // Detecting by hostname silently metered $0 through any proxy; a
    // cost-driven loop reads $0 as a win. Detection is by request shape now.
    const meter = installOpenAIMeter();
    const srv = Bun.serve({
      port: 0,
      fetch: () => Response.json({ model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    });
    try {
      await fetch(`http://localhost:${srv.port}/proxy/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
      });
      expect(meter.stats.requests).toBe(1);
      expect(meter.stats.byModel['gpt-4o'].promptTokens).toBe(10);
      expect(meter.stats.byHost[`localhost:${srv.port}`]).toBe(1);
      expect(meter.costUsd()).toBeGreaterThan(0);
    } finally {
      meter.uninstall();
      await srv.stop(true);
    }
  });

  test('counts a streamed response but marks it unmetered rather than $0', async () => {
    const meter = installOpenAIMeter();
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    try {
      await fetch(`http://localhost:${srv.port}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o', stream: true }),
      });
      expect(meter.stats.requests).toBe(1);
      expect(meter.stats.byModel['gpt-4o'].unmetered).toBe(1);
      expect(meter.stats.byModel['gpt-4o'].promptTokens).toBe(0);
    } finally {
      meter.uninstall();
      await srv.stop(true);
    }
  });

  // Regression: OpenAI answers a request for "gpt-4o-mini" with the dated
  // snapshot "gpt-4o-mini-2024-07-18". Bucketing request and response
  // separately counted one call twice and left an empty bucket under the
  // requested name — which is what preflight was checking, so every scored run
  // aborted with a false "meter_reads_usage" failure.
  test('attributes a dated snapshot response to ONE bucket', async () => {
    const meter = installOpenAIMeter();
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ model: 'gpt-4o-mini-2024-07-18', usage: { prompt_tokens: 8, completion_tokens: 1 } }),
    });
    try {
      await fetch(`http://localhost:${srv.port}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o-mini' }),
      });
      expect(meter.stats.requests).toBe(1);
      expect(Object.keys(meter.stats.byModel)).toEqual(['gpt-4o-mini-2024-07-18']);
      const perModel = Object.values(meter.stats.byModel).reduce((t, u) => t + u.requests, 0);
      expect(perModel).toBe(1);
      expect(meter.stats.byModel['gpt-4o-mini-2024-07-18'].promptTokens).toBe(8);
      expect(meter.costUsd()).toBeGreaterThan(0);
    } finally {
      meter.uninstall();
      await srv.stop(true);
    }
  });

  test('prices a provider-prefixed model name', () => {
    expect(priceOf('openai/gpt-4o')).toEqual(PRICES['gpt-4o']);
    expect(priceOf('gpt-4o-2024-08-06')).toEqual(PRICES['gpt-4o']);
    expect(priceOf('nope/nope')).toBeNull();
    expect(costOf('openai/gpt-4o-mini', 1e6, 0)).toBeCloseTo(PRICES['gpt-4o-mini'].in, 10);
  });

  test('ignores a POST to a non-inference path', async () => {
    const meter = installOpenAIMeter();
    const srv = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      await fetch(`http://localhost:${srv.port}/v1/files`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o' }),
      });
      expect(meter.stats.requests).toBe(0);
    } finally {
      meter.uninstall();
      await srv.stop(true);
    }
  });

  test('no harness module statically imports openai', async () => {
    // A top-level `import ... from "openai"` anywhere in bench/ loads the SDK
    // before installOpenAIMeter() runs; its shim then captures the unpatched
    // fetch and every cost silently reports $0. Keep such imports lazy.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) {
          if (e !== 'jobs' && e !== 'node_modules' && e !== 'corpus' && e !== 'tasks') walk(full);
        } else if (e.endsWith('.ts')) {
          for (const line of readFileSync(full, 'utf-8').split('\n')) {
            if (/^\s*import\s.*from\s+['"]openai['"]/.test(line)) offenders.push(`${full}: ${line.trim()}`);
          }
        }
      }
    };
    walk(join(import.meta.dirname));
    expect(offenders).toEqual([]);
  });

  test('ignores non-OpenAI traffic', async () => {
    const meter = installOpenAIMeter();
    try {
      await fetch(github.url, { method: 'POST', body: JSON.stringify({ query: 'q', variables: {} }) });
      expect(meter.stats.requests).toBe(0);
    } finally {
      meter.uninstall();
    }
  });
});

// ---------------------------------------------------------------------------

describe('graders', () => {
  const n = (value: number, forbid?: number[]) => ({ type: 'number' as const, value, forbid });

  test('accepts a plainly stated number', () => {
    expect(gradeDeterministic(n(60), 'There are 60 issues in total.').pass).toBe(true);
    expect(gradeDeterministic(n(1234), 'A total of 1,234 comments.').pass).toBe(true);
  });

  test('rejects a missing or near-miss number', () => {
    expect(gradeDeterministic(n(60), 'There are 59 issues.').pass).toBe(false);
    expect(gradeDeterministic(n(60), 'There are 600 issues.').pass).toBe(false);
    expect(gradeDeterministic(n(60, [120]), 'I found 60, though 120 rows came back.').pass).toBe(false);
  });

  test('does not award a point for a number inside Cypher or an issue reference', () => {
    expect(gradeDeterministic(n(60), 'I ran ```MATCH (i:Issue) RETURN i LIMIT 60```').pass).toBe(false);
    expect(gradeDeterministic(n(60), 'See issue #60 for details.').pass).toBe(false);
    expect(gradeDeterministic(n(60), 'Ran `LIMIT 60` and found nothing.').pass).toBe(false);
  });

  test('extracts issue numbers from prose, links and URLs', () => {
    const cited = citedIssueNumbers(
      'See [#7509](https://github.com/huggingface/datasets/issues/7509) and https://github.com/o/r/issues/4310',
    );
    expect([...cited].sort((a, b) => a - b)).toEqual([4310, 7509]);
  });

  test('issue_set exact rejects extra citations, superset allows them', () => {
    const answer = 'Issues #10, #20 and #30 match.';
    expect(gradeDeterministic({ type: 'issue_set', expect: [10, 20], mode: 'exact' }, answer).pass).toBe(false);
    expect(gradeDeterministic({ type: 'issue_set', expect: [10, 20], mode: 'superset' }, answer).pass).toBe(true);
    expect(gradeDeterministic({ type: 'issue_set', expect: [10, 20, 30], mode: 'exact' }, answer).pass).toBe(true);
  });

  test('issue_set rejects a missing citation', () => {
    expect(
      gradeDeterministic({ type: 'issue_set', expect: [10, 20], mode: 'exact' }, 'Only #10.').pass,
    ).toBe(false);
  });

  test('contains_all is case-insensitive and honours forbid', () => {
    expect(gradeDeterministic({ type: 'contains_all', values: ['lhoestq'] }, 'Opened by LHoestQ.').pass).toBe(true);
    expect(gradeDeterministic({ type: 'contains_all', values: ['a', 'b'] }, 'only a').pass).toBe(false);
    expect(
      gradeDeterministic({ type: 'contains_all', values: ['a'], forbid: ['nope'] }, 'a but nope').pass,
    ).toBe(false);
  });

  test('an empty answer never passes', () => {
    expect(gradeDeterministic(n(60), '').pass).toBe(false);
    expect(gradeDeterministic({ type: 'issue_set', expect: [1], mode: 'exact' }, '').pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('Neo4j meter and integrity (requires docker)', () => {
  let driver: any;
  let closeDriver: () => Promise<void>;

  beforeAll(async () => {
    await startNeo4j(() => {});
    process.env.NEO4J_URI = BOLT_URI;
    process.env.NEO4J_AUTH = 'none';
    const mod = await import(join(SUT, 'src/services/neo4j.ts'));
    driver = mod.getDriver();
    closeDriver = mod.closeDriver;
    await resetDatabase(driver);
  }, 180_000);

  afterAll(async () => {
    if (driver) await resetDatabase(driver);
    await closeDriver?.();
    await github.stop();
  });

  test('counts plain session.run', async () => {
    const meter = meterDriver(driver);
    const s = driver.session();
    await s.run('RETURN 1');
    await s.run('RETURN 2');
    await s.close();
    expect(meter.stats.queries).toBe(2);
    expect(meter.stats.sessions).toBe(1);
  });

  // plan.md H2 moves writes into executeWrite. If this counter missed
  // transaction work, H2 would look like a 100% roundtrip cut that never
  // happened — the exact class of error that gets believed for days.
  test('counts statements issued inside executeWrite', async () => {
    const meter = meterDriver(driver);
    const s = driver.session();
    await s.executeWrite(async (tx: any) => {
      await tx.run('CREATE (n:MeterProbe {i: 1})');
      await tx.run('CREATE (n:MeterProbe {i: 2})');
      await tx.run('CREATE (n:MeterProbe {i: 3})');
    });
    await s.close();
    expect(meter.stats.queries).toBe(3);
    expect(meter.stats.transactions).toBe(1);
  });

  test('counts statements issued inside executeRead', async () => {
    const meter = meterDriver(driver);
    const s = driver.session();
    await s.executeRead(async (tx: any) => {
      await tx.run('MATCH (n:MeterProbe) RETURN count(n)');
    });
    await s.close();
    expect(meter.stats.queries).toBe(1);
    expect(meter.stats.transactions).toBe(1);
  });

  test('counts statements in an explicit beginTransaction', async () => {
    const meter = meterDriver(driver);
    const s = driver.session();
    const tx = s.beginTransaction();
    await tx.run('CREATE (n:MeterProbe {i: 4})');
    await tx.run('CREATE (n:MeterProbe {i: 5})');
    await tx.commit();
    await s.close();
    expect(meter.stats.queries).toBe(2);
    expect(meter.stats.transactions).toBe(1);
  });

  test('an UNWIND batch counts as ONE statement, a loop counts as many', async () => {
    const meter = meterDriver(driver);
    const s = driver.session();
    for (let i = 0; i < 5; i++) await s.run('CREATE (n:MeterProbe {i: $i})', { i });
    const loop = meter.stats.queries;
    meter.reset();
    await s.run('UNWIND $rows AS r CREATE (n:MeterProbe {i: r})', { rows: [1, 2, 3, 4, 5] });
    const batch = meter.stats.queries;
    await s.close();
    expect(loop).toBe(5);
    expect(batch).toBe(1);
  });

  test('resetDatabase removes constraints and indexes, not just nodes', async () => {
    const s = driver.session();
    await s.run('CREATE CONSTRAINT probe_unique IF NOT EXISTS FOR (i:Probe) REQUIRE i.k IS UNIQUE');
    await s.run('CREATE INDEX probe_idx IF NOT EXISTS FOR (i:Probe) ON (i.v)');
    await s.run('CREATE (n:Probe {k: 1, v: 2})');
    const before = (await s.run('SHOW CONSTRAINTS YIELD name RETURN count(*) AS c')).records[0].get('c').toNumber();
    expect(before).toBeGreaterThan(0);
    await s.close();

    await resetDatabase(driver); // throws if anything survives

    const s2 = driver.session();
    const after = (await s2.run('SHOW CONSTRAINTS YIELD name RETURN count(*) AS c')).records[0].get('c').toNumber();
    const idx = (await s2.run("SHOW INDEXES YIELD type WHERE type <> 'LOOKUP' RETURN count(*) AS c")).records[0]
      .get('c')
      .toNumber();
    await s2.close();
    expect(after).toBe(0);
    expect(idx).toBe(0);
  }, 30_000);

  // An integrity check that cannot fail is worse than no check at all.
  describe('integrity checks actually fail on a corrupted graph', () => {
    const tiny: Corpus = {
      meta: { source: 't', builtAt: '', seed: 0, owner: 'o', repo: 'r', split: 'test', count: 1 },
      issues: [
        makeIssue(1, {
          totalComments: 2,
          comments: [
            { id: 'c1', bodyText: 'a', createdAt: '2024-01-01T00:00:00Z', author: null, reactions: { nodes: [], totalCount: 0 } },
            { id: 'c2', bodyText: 'b', createdAt: '2024-01-01T01:00:00Z', author: null, reactions: { nodes: [], totalCount: 0 } },
          ],
        }),
      ],
    };

    const seed = async () => {
      await resetDatabase(driver);
      const s = driver.session();
      await s.run(`
        CREATE (i:Issue {issueId: 'ID_1', number: 1, title: 'issue 1', authorLogin: 'user1'})
        CREATE (u:User {login: 'user1'})
        CREATE (i)-[:AUTHORED_BY]->(u)
        CREATE (c1:Comment {commentId: 'c1'})
        CREATE (c2:Comment {commentId: 'c2'})
        CREATE (i)-[:HAS_COMMENT]->(c1)
        CREATE (i)-[:HAS_COMMENT]->(c2)`);
      await s.close();
    };
    const failing = async () => (await checkIntegrity(driver, tiny)).filter((c) => !c.pass && !c.info).map((c) => c.name);

    test('a correctly seeded graph passes', async () => {
      await seed();
      expect(await failing()).toEqual([]);
    });

    test('a duplicate issue is caught', async () => {
      await seed();
      const s = driver.session();
      await s.run("CREATE (:Issue {issueId: 'ID_1', number: 1, title: 'dup', authorLogin: 'user1'})");
      await s.close();
      const bad = await failing();
      expect(bad).toContain('no_duplicate_issue_number');
      expect(bad).toContain('no_duplicate_issue_id');
      expect(bad).toContain('issue_count');
    });

    test('a dropped comment is caught', async () => {
      await seed();
      const s = driver.session();
      await s.run("MATCH (c:Comment {commentId: 'c2'}) DETACH DELETE c");
      await s.close();
      const bad = await failing();
      expect(bad).toContain('comment_count');
      expect(bad).toContain('per_issue_comment_counts');
    });

    test('a missing author edge is caught', async () => {
      await seed();
      const s = driver.session();
      await s.run('MATCH (:Issue)-[r:AUTHORED_BY]->(:User) DELETE r');
      await s.close();
      expect(await failing()).toContain('issue_author_edges');
    });

    test('an orphaned comment is caught', async () => {
      await seed();
      const s = driver.session();
      await s.run("MATCH (:Issue)-[r:HAS_COMMENT]->(:Comment {commentId: 'c1'}) DELETE r");
      await s.close();
      const bad = await failing();
      expect(bad).toContain('no_orphan_comments');
      expect(bad).toContain('issue_comment_edges');
    });

    test('the right count of the wrong issues is caught', async () => {
      await resetDatabase(driver);
      const s = driver.session();
      await s.run(`
        CREATE (i:Issue {issueId: 'ID_9', number: 9, title: 'wrong', authorLogin: 'user1'})
        CREATE (u:User {login: 'user1'})
        CREATE (i)-[:AUTHORED_BY]->(u)
        CREATE (c1:Comment {commentId: 'c1'})
        CREATE (c2:Comment {commentId: 'c2'})
        CREATE (i)-[:HAS_COMMENT]->(c1)
        CREATE (i)-[:HAS_COMMENT]->(c2)`);
      await s.close();
      expect(await failing()).toContain('issue_numbers_match');
    });
  });
});

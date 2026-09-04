/**
 * Benchmark Neo4j lifecycle + graph integrity assertions.
 *
 * A dirty database is the classic silently-wrong benchmark: leftover nodes
 * from a previous run inflate every count and the scores look fine until you
 * dig, days later. So the harness resets and then VERIFIES the reset, and
 * refuses to run if the database is not empty.
 */

import type { Driver } from 'neo4j-driver';
import type { Corpus } from '../scripts/build-corpus';

export const CONTAINER = 'gh-issue-bench-neo4j';
export const BOLT_PORT = 7690;
export const HTTP_PORT = 7475;
export const BOLT_URI = `bolt://localhost:${BOLT_PORT}`;
export const IMAGE = 'neo4j:5';

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { code: await proc.exited, out: out + err };
}

export async function containerState(): Promise<'running' | 'stopped' | 'absent'> {
  const { out } = await sh(['docker', 'ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.State}}']);
  const s = out.trim();
  if (!s) return 'absent';
  return s.startsWith('running') ? 'running' : 'stopped';
}

export async function startNeo4j(log: (s: string) => void = console.log): Promise<void> {
  const state = await containerState();
  if (state === 'running') {
    log(`  neo4j: container ${CONTAINER} already running`);
  } else {
    if (state === 'stopped') {
      log(`  neo4j: starting existing container ${CONTAINER}`);
      const r = await sh(['docker', 'start', CONTAINER]);
      if (r.code !== 0) throw new Error(`docker start failed: ${r.out}`);
    } else {
      log(`  neo4j: creating container ${CONTAINER} (${IMAGE})`);
      const r = await sh([
        'docker', 'run', '-d',
        '--name', CONTAINER,
        '-p', `${BOLT_PORT}:7687`,
        '-p', `${HTTP_PORT}:7474`,
        '-e', 'NEO4J_AUTH=none',
        '-e', 'NEO4J_server_memory_heap_max__size=1G',
        IMAGE,
      ]);
      if (r.code !== 0) throw new Error(`docker run failed: ${r.out}`);
    }
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${HTTP_PORT}/`);
      if (res.ok) {
        log(`  neo4j: ready on ${BOLT_URI}`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`neo4j did not become ready within 120s (docker logs ${CONTAINER})`);
}

export async function stopNeo4j(): Promise<void> {
  await sh(['docker', 'rm', '-f', CONTAINER]);
}

/** Wipe data, constraints and indexes, then prove the wipe worked. */
export async function resetDatabase(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run('MATCH (n) DETACH DELETE n');

    for (const kind of ['CONSTRAINTS', 'INDEXES'] as const) {
      const listed = await session.run(`SHOW ${kind} YIELD name, type RETURN name, type`);
      for (const rec of listed.records) {
        const name = rec.get('name') as string;
        const type = String(rec.get('type') ?? '');
        if (kind === 'INDEXES' && type.toUpperCase() === 'LOOKUP') continue; // built-in
        await session.run(`DROP ${kind === 'CONSTRAINTS' ? 'CONSTRAINT' : 'INDEX'} \`${name}\` IF EXISTS`);
      }
    }

    const nodes = (await session.run('MATCH (n) RETURN count(n) AS c')).records[0].get('c').toNumber();
    const cons = (await session.run('SHOW CONSTRAINTS YIELD name RETURN count(*) AS c')).records[0]
      .get('c')
      .toNumber();
    if (nodes !== 0 || cons !== 0) {
      throw new Error(`database not clean after reset: ${nodes} nodes, ${cons} constraints`);
    }
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

export interface IntegrityCheck {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  /** Informational checks are reported but never fail a run. */
  info?: boolean;
}

const num = (v: unknown) => (v && typeof v === 'object' && 'toNumber' in v ? (v as any).toNumber() : Number(v));

export async function checkIntegrity(driver: Driver, corpus: Corpus): Promise<IntegrityCheck[]> {
  const session = driver.session();
  const checks: IntegrityCheck[] = [];

  const one = async (cypher: string): Promise<number> => {
    const r = await session.run(cypher);
    return num(r.records[0]?.get(0));
  };
  const eq = (name: string, expected: number, actual: number, info = false) =>
    checks.push({ name, pass: expected === actual, expected: String(expected), actual: String(actual), info });

  try {
    const issues = corpus.issues;
    const expComments = issues.reduce((s, i) => s + i.totalComments, 0);
    const expReactions = issues.reduce((s, i) => s + i.reactions.totalCount, 0);
    const expAuthors = new Set(issues.map((i) => i.author?.login).filter(Boolean)).size;
    const expLabels = new Set(issues.flatMap((i) => i.labels.nodes.map((l) => l.name))).size;

    eq('issue_count', issues.length, await one('MATCH (i:Issue) RETURN count(i)'));
    eq('comment_count', expComments, await one('MATCH (c:Comment) RETURN count(c)'));
    eq('user_count', expAuthors, await one('MATCH (u:User) RETURN count(u)'));
    eq('label_count', expLabels, await one('MATCH (l:Label) RETURN count(l)'));
    eq('reaction_count', expReactions, await one('MATCH (r:Reaction) RETURN count(r)'));

    // Duplicates are the failure mode uniqueness constraints are meant to stop.
    eq('no_duplicate_issue_number', 0,
      await one('MATCH (i:Issue) WITH i.number AS k, count(*) AS c WHERE c > 1 RETURN count(*)'));
    eq('no_duplicate_issue_id', 0,
      await one('MATCH (i:Issue) WITH i.issueId AS k, count(*) AS c WHERE c > 1 RETURN count(*)'));
    eq('no_duplicate_comment_id', 0,
      await one('MATCH (c:Comment) WITH c.commentId AS k, count(*) AS c2 WHERE c2 > 1 RETURN count(*)'));
    eq('no_duplicate_user_login', 0,
      await one('MATCH (u:User) WITH u.login AS k, count(*) AS c WHERE c > 1 RETURN count(*)'));
    eq('no_duplicate_label_name', 0,
      await one('MATCH (l:Label) WITH l.name AS k, count(*) AS c WHERE c > 1 RETURN count(*)'));

    // Relationships, not just nodes — an issue with no author edge answers
    // "who opened #N" wrongly even though user_count looks right.
    eq('issue_author_edges', issues.filter((i) => i.author?.login).length,
      await one('MATCH (:Issue)-[r:AUTHORED_BY]->(:User) RETURN count(r)'));
    eq('issue_comment_edges', expComments,
      await one('MATCH (:Issue)-[r:HAS_COMMENT]->(:Comment) RETURN count(r)'));
    eq('issue_label_edges', issues.reduce((s, i) => s + i.labels.nodes.length, 0),
      await one('MATCH (:Issue)-[r:HAS_LABEL]->(:Label) RETURN count(r)'));
    eq('no_orphan_comments', 0,
      await one('MATCH (c:Comment) WHERE NOT (c)<-[:HAS_COMMENT]-(:Issue) RETURN count(c)'));

    // Exact membership — catches "ingested 60 rows, but not the right 60".
    const numbers = await session.run('MATCH (i:Issue) RETURN i.number AS n');
    const got = new Set(numbers.records.map((r) => num(r.get('n'))));
    const missing = issues.filter((i) => !got.has(i.number)).map((i) => i.number);
    checks.push({
      name: 'issue_numbers_match',
      pass: missing.length === 0 && got.size === issues.length,
      expected: `${issues.length} exact numbers`,
      actual: missing.length ? `missing ${missing.slice(0, 5).join(',')}` : `${got.size} present`,
    });

    // Per-issue comment fan-out — catches partial comment pagination.
    const fan = await session.run(
      'MATCH (i:Issue) OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment) RETURN i.number AS n, count(c) AS c',
    );
    const wrong = fan.records
      .map((r) => ({ n: num(r.get('n')), c: num(r.get('c')) }))
      .filter(({ n, c }) => (corpus.issues.find((i) => i.number === n)?.totalComments ?? -1) !== c);
    checks.push({
      name: 'per_issue_comment_counts',
      pass: wrong.length === 0,
      expected: 'every issue has its corpus comment count',
      actual: wrong.length ? `${wrong.length} wrong (e.g. #${wrong[0].n}=${wrong[0].c})` : 'all match',
    });

    // Informational: what the analysis stage produced, and schema hardening.
    for (const [name, cypher] of [
      ['constraints_defined', 'SHOW CONSTRAINTS YIELD name RETURN count(*)'],
      ['indexes_defined', "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN count(*)"],
      ['solution_nodes', 'MATCH (n:Solution) RETURN count(n)'],
      ['workaround_nodes', 'MATCH (n:Workaround) RETURN count(n)'],
      ['category_nodes', 'MATCH (n:Category) RETURN count(n)'],
      ['competitor_nodes', 'MATCH (n:Competitor) RETURN count(n)'],
      ['keyword_nodes', 'MATCH (n:Keyword) RETURN count(n)'],
      ['issues_with_category', 'MATCH (i:Issue)-[:BELONGS_TO_CATEGORY]->() RETURN count(DISTINCT i)'],
      // plan.md phase 3/5: embeddings + vector index. `embedding = []` counts
      // as absent, which is what the current schema writes.
      ['vector_indexes', "SHOW INDEXES YIELD type WHERE type = 'VECTOR' RETURN count(*)"],
      ['nodes_with_embedding',
        'MATCH (n) WHERE n.embedding IS NOT NULL AND size(n.embedding) > 0 RETURN count(n)'],
    ] as const) {
      checks.push({
        name,
        pass: true,
        expected: '(informational)',
        actual: String(await one(cypher)),
        info: true,
      });
    }
  } finally {
    await session.close();
  }

  return checks;
}

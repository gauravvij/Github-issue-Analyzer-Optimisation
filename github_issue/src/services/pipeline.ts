/**
 * Pipeline orchestrator — ties together GitHub fetch, Neo4j ingest,
 * OpenAI analysis, and analysis ingestion into a single end-to-end flow.
 *
 * Supports incremental sync: when a previous run's timestamp is found in
 * Neo4j (Meta node), only issues updated since then are fetched and
 * re-analyzed. The first run always does a full sync.
 */

import { type AnalysisData, ingestAnalysisResults } from './analysis';
import { type IssueState, getAllIssueNumbers, getIssuesData } from './github';
import {
  getIssueUpdatedAt,
  getLastSyncTimestamp,
  ingestMultipleIssues,
  setLastSyncTimestamp,
  setupDatabaseSchema,
} from './neo4j';
import { analyzeIssueWithOpenAI, transformIssueDataForAnalysis } from './openai';
import { withSpan } from './tracing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  /** GitHub repo owner (e.g. "octocat") */
  owner: string;
  /** GitHub repo name (e.g. "hello-world") */
  repo: string;
  /** Which issue states to ingest */
  state: IssueState;
  /** Max issues to process (0 = all). Useful for testing. */
  limit: number;
  /** Whether to run OpenAI analysis after ingestion */
  analyze: boolean;
  /** Force full sync even if a lastSync timestamp exists */
  fullSync?: boolean;
}

export interface PipelineResult {
  issuesFetched: number;
  issuesIngested: number;
  issuesAnalyzed: number;
  issuesSkipped: number;
  errors: string[];
  durationMs: number;
  incremental: boolean;
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  return withSpan(
    'pipeline.run',
    {
      'pipeline.repo': `${config.owner}/${config.repo}`,
      'pipeline.state': config.state,
      'pipeline.limit': config.limit,
      'pipeline.analyze': config.analyze,
    },
    (span) => runPipelineInner(config, span),
  );
}

async function runPipelineInner(
  config: PipelineConfig,
  rootSpan: import('@opentelemetry/api').Span,
): Promise<PipelineResult> {
  const start = Date.now();
  const runTimestamp = new Date().toISOString();
  const errors: string[] = [];

  // Ensure MERGE lookups use the same idempotent schema on every sync.
  await setupDatabaseSchema();

  // Read lastSync to determine if this is incremental
  let since: string | null = null;
  if (!config.fullSync) {
    try {
      since = await getLastSyncTimestamp();
    } catch {
      // Neo4j may not be ready yet on first run — fall through to full sync
    }
  }
  const incremental = !!since;

  console.log('\n========================================');
  console.log(' GitHub Issue Analyzer — Ingestion Pipeline');
  console.log('========================================');
  console.log(`  Repo:    ${config.owner}/${config.repo}`);
  console.log(`  State:   ${config.state}`);
  console.log(`  Limit:   ${config.limit || 'all'}`);
  console.log(`  Analyze: ${config.analyze}`);
  console.log(`  Mode:    ${incremental ? `incremental (since ${since})` : 'full sync'}`);
  console.log('========================================\n');

  // 1. Discover issue numbers
  console.log('Step 1/5: Discovering issues...');
  const listing = await withSpan('pipeline.discover', {}, () =>
    getAllIssueNumbers(config.owner, config.repo, config.state, config.limit, since),
  );
  const numbers = listing.issueNumbers;
  console.log(`  Will process ${numbers.length} issues\n`);

  if (numbers.length === 0) {
    if (incremental) {
      console.log('  No issues updated since last sync — nothing to do.\n');
      await setLastSyncTimestamp(runTimestamp);
    }
    return {
      issuesFetched: 0,
      issuesIngested: 0,
      issuesAnalyzed: 0,
      issuesSkipped: 0,
      errors: [],
      durationMs: Date.now() - start,
      incremental,
    };
  }

  // 2. Fetch full issue data from GitHub
  console.log('Step 2/5: Fetching issue data from GitHub...');
  const fetched = await withSpan('pipeline.fetch', { 'pipeline.issue_count': numbers.length }, () =>
    getIssuesData(config.owner, config.repo, numbers),
  );
  for (const e of fetched.errors) errors.push(`fetch #${e.issueNumber}: ${e.error}`);
  console.log(`  Fetched ${fetched.results.length} issues\n`);

  // 3. Ingest into Neo4j
  console.log('Step 3/5: Ingesting into Neo4j...');
  const ingested = await withSpan(
    'pipeline.ingest',
    { 'pipeline.issue_count': fetched.results.length },
    () => ingestMultipleIssues(fetched.results),
  );
  for (const e of ingested.errors) errors.push(`ingest #${e.issueNumber}: ${e.error}`);
  console.log(`  Ingested ${ingested.results.length} issues\n`);

  let analysisCount = 0;
  let skippedCount = 0;

  if (config.analyze) {
    // 4. Run OpenAI analysis — skip issues whose updatedAt hasn't changed
    console.log('Step 4/5: Running OpenAI analysis...');
    const ingestedNumbers = ingested.results
      .map((r) => {
        const match = fetched.results.find((f) => f.issue.id === r.issueId);
        return match?.issue.number;
      })
      .filter((n): n is number => n !== undefined);

    // Build a map of issue number -> new updatedAt from the fetched data
    const updatedAtMap = new Map<number, string>();
    for (const { issue } of fetched.results) {
      updatedAtMap.set(issue.number, issue.updatedAt);
    }

    const ingestedIssueIds = new Set(ingested.results.map((result) => result.issueId));
    const analysisResults: AnalysisData[] = [];

    // Reuse the already fetched GitHub payload. The ingestion step has just
    // persisted this same data, so a Neo4j read-after-write would add one
    // query per issue without changing the analysis input.
    for (const fetchedIssue of fetched.results) {
      if (!ingestedIssueIds.has(fetchedIssue.issue.id)) continue;

      try {
        // In incremental mode, skip analysis if the issue's updatedAt hasn't changed
        if (incremental) {
          const previousUpdatedAt = await getIssueUpdatedAt(fetchedIssue.issue.number);
          const currentUpdatedAt = updatedAtMap.get(fetchedIssue.issue.number);
          if (previousUpdatedAt && currentUpdatedAt && previousUpdatedAt === currentUpdatedAt) {
            console.log(`  Skipping issue #${fetchedIssue.issue.number} (unchanged)`);
            skippedCount++;
            continue;
          }
        }

        const transformed = transformIssueDataForAnalysis({
          issue: {
            issueId: fetchedIssue.issue.id,
            number: fetchedIssue.issue.number,
            title: fetchedIssue.issue.title,
            bodyText: fetchedIssue.issue.bodyText,
          },
          labels: (fetchedIssue.issue.labels?.nodes ?? [])
            .map((label) => label.name)
            .filter((name): name is string => name !== null),
          comments: fetchedIssue.comments.map((comment) => ({
            commentId: comment.id,
            authorLogin: comment.author?.login,
            bodyText: comment.bodyText,
          })),
        });
        console.log(`  Analyzing issue #${fetchedIssue.issue.number}: ${fetchedIssue.issue.title}`);
        const result = await withSpan(
          'pipeline.analyzeIssue',
          { 'pipeline.issue_number': fetchedIssue.issue.number },
          () => analyzeIssueWithOpenAI(transformed),
        );
        analysisResults.push({
          issueNumber: fetchedIssue.issue.number,
          title: fetchedIssue.issue.title,
          analysis: result.analysis,
        });
        analysisCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Analysis failed for #${fetchedIssue.issue.number}: ${msg}`);
        errors.push(`analysis #${fetchedIssue.issue.number}: ${msg}`);
      }
    }

    // 5. Ingest analysis results
    if (analysisResults.length > 0) {
      console.log('\nStep 5/5: Ingesting analysis results...');
      const analysisIngested = await withSpan(
        'pipeline.persistAnalysis',
        { 'pipeline.issue_count': analysisResults.length },
        () => ingestAnalysisResults(analysisResults),
      );
      for (const e of analysisIngested.errors) {
        errors.push(`analysis-ingest #${e.issueNumber}: ${e.error}`);
      }
    }
  } else {
    console.log('Step 4/5: Skipped (analysis disabled)');
    console.log('Step 5/5: Skipped (analysis disabled)');
  }

  // Record this run's timestamp for the next incremental sync
  await setLastSyncTimestamp(runTimestamp);

  const durationMs = Date.now() - start;

  rootSpan.setAttributes({
    'pipeline.issues_fetched': fetched.results.length,
    'pipeline.issues_ingested': ingested.results.length,
    'pipeline.issues_analyzed': analysisCount,
    'pipeline.issues_skipped': skippedCount,
    'pipeline.errors': errors.length,
    'pipeline.duration_ms': durationMs,
    'pipeline.incremental': incremental,
  });

  console.log('\n========================================');
  console.log(' Pipeline Complete');
  console.log('========================================');
  console.log(`  Mode:            ${incremental ? 'incremental' : 'full sync'}`);
  console.log(`  Issues fetched:  ${fetched.results.length}`);
  console.log(`  Issues ingested: ${ingested.results.length}`);
  console.log(`  Issues analyzed: ${analysisCount}`);
  if (skippedCount > 0) {
    console.log(`  Issues skipped:  ${skippedCount} (unchanged)`);
  }
  console.log(`  Errors:          ${errors.length}`);
  console.log(`  Duration:        ${(durationMs / 1000).toFixed(1)}s`);
  console.log('========================================\n');

  return {
    issuesFetched: fetched.results.length,
    issuesIngested: ingested.results.length,
    issuesAnalyzed: analysisCount,
    issuesSkipped: skippedCount,
    errors,
    durationMs,
    incremental,
  };
}

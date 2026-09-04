/**
 * Read a JSONL trace and answer "where did the time go".
 *
 *   bun run trace:summary                       # newest trace in .traces/
 *   bun run trace:summary <file.jsonl|dir>
 *   bun run trace:summary <file> --tree         # span tree of the slowest trace
 *   bun run trace:summary <file> --tree <traceId>
 *
 * The aggregate table is the useful part: it shows, per operation, how many
 * calls were made and how much wall clock they cost — which is what turns
 * "ingestion is slow" into "121 serial GitHub round-trips".
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: string;
  statusMessage: string | null;
  attributes: Record<string, unknown>;
}

function newestTrace(dir: string): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) throw new Error(`no .jsonl traces in ${dir}`);
  return files[0];
}

function load(target: string): SpanRecord[] {
  const path = statSync(target).isDirectory() ? newestTrace(target) : target;
  console.log(`trace: ${path}\n`);
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SpanRecord);
}

const pct = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

function aggregate(spans: SpanRecord[]) {
  const byName = new Map<string, number[]>();
  const errors = new Map<string, number>();
  for (const s of spans) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name)!.push(s.durationMs);
    if (s.status === 'ERROR') errors.set(s.name, (errors.get(s.name) ?? 0) + 1);
  }

  const rows = [...byName.entries()]
    .map(([name, ds]) => {
      const sorted = [...ds].sort((a, b) => a - b);
      const total = ds.reduce((a, b) => a + b, 0);
      return {
        name,
        count: ds.length,
        totalMs: total,
        meanMs: total / ds.length,
        p50: pct(sorted, 0.5),
        p95: pct(sorted, 0.95),
        maxMs: sorted[sorted.length - 1],
        errors: errors.get(name) ?? 0,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);

  const w = Math.max(20, ...rows.map((r) => r.name.length));
  console.log(
    `${'operation'.padEnd(w)}  ${'count'.padStart(6)}  ${'total'.padStart(10)}  ${'mean'.padStart(9)}  ${'p50'.padStart(9)}  ${'p95'.padStart(9)}  ${'max'.padStart(9)}  err`,
  );
  console.log('-'.repeat(w + 68));
  const ms = (n: number) => `${n.toFixed(1)}ms`;
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(w)}  ${String(r.count).padStart(6)}  ${ms(r.totalMs).padStart(10)}  ` +
        `${ms(r.meanMs).padStart(9)}  ${ms(r.p50).padStart(9)}  ${ms(r.p95).padStart(9)}  ` +
        `${ms(r.maxMs).padStart(9)}  ${r.errors || ''}`,
    );
  }

  // Count LLM work by attribute, not by span name: ingestion calls are
  // `openai.chat`, agent calls are `gen_ai.request`, the summariser tool is
  // `tool.summarizeComments`. All three carry gen_ai.usage.* attributes.
  const llm = spans.filter((s) => s.attributes['gen_ai.usage.input_tokens'] !== undefined);
  const tokensIn = llm.reduce((t, s) => t + Number(s.attributes['gen_ai.usage.input_tokens'] ?? 0), 0);
  const tokensOut = llm.reduce((t, s) => t + Number(s.attributes['gen_ai.usage.output_tokens'] ?? 0), 0);
  const traces = new Set(spans.map((s) => s.traceId)).size;
  const failed = spans.filter((s) => s.status === 'ERROR');
  console.log(
    `\n${spans.length} spans across ${traces} trace(s); ${llm.length} LLM call(s), ` +
      `${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out tokens; ${failed.length} failed span(s)`,
  );
  for (const f of failed.slice(0, 10)) {
    console.log(`  ERROR ${f.name}: ${f.statusMessage ?? ''}`);
  }
}

function tree(spans: SpanRecord[], traceId?: string) {
  const id =
    traceId ??
    [...new Map(spans.map((s) => [s.traceId, s])).values()]
      .filter((s) => s.parentSpanId === null)
      .sort((a, b) => b.durationMs - a.durationMs)[0]?.traceId;
  if (!id) return console.log('\nno root span found');

  const inTrace = spans.filter((s) => s.traceId === id);
  const children = new Map<string | null, SpanRecord[]>();
  for (const s of inTrace) {
    const key = s.parentSpanId;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(s);
  }
  for (const list of children.values()) list.sort((a, b) => a.startTimeMs - b.startTimeMs);

  console.log(`\nspan tree for trace ${id}:`);
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      if (seen.has(s.spanId) || depth > 12) continue;
      seen.add(s.spanId);
      const detail =
        s.attributes['db.statement'] ??
        s.attributes['github.operation'] ??
        s.attributes['gen_ai.request.model'] ??
        '';
      console.log(
        `${'  '.repeat(depth)}${s.status === 'ERROR' ? '✗' : '·'} ${s.name} ${s.durationMs.toFixed(1)}ms ${String(detail).slice(0, 60)}`,
      );
      walk(s.spanId, depth + 1);
    }
  };
  walk(null, 0);
}

const args = process.argv.slice(2);
const flagAt = args.indexOf('--tree');
// The token after --tree is an optional traceId, not the trace file.
const consumed = new Set<number>(flagAt === -1 ? [] : [flagAt, flagAt + 1]);
const positional = args.filter((a, i) => !a.startsWith('--') && !consumed.has(i));
const target = positional[0] ?? '.traces';
if (!existsSync(target)) {
  console.error(`not found: ${target}\nRun the pipeline or agent first — traces land in .traces/`);
  process.exit(1);
}
const spans = load(target);
aggregate(spans);
if (flagAt !== -1) {
  const maybeId = args[flagAt + 1];
  tree(spans, maybeId && !maybeId.startsWith('--') && maybeId !== target ? maybeId : undefined);
}

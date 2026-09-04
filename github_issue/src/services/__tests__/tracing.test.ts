/**
 * Tracing tests.
 *
 * Tracing is measurement infrastructure: when it breaks it does so silently,
 * producing an empty or half-empty trace that reads as "nothing happened"
 * rather than as an error. These tests assert spans actually land on disk with
 * the right shape.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTraceFilePath, initTracing, shutdownTracing, withSpan } from '../tracing';

let dir: string;
let realFetch: typeof globalThis.fetch;

interface Span {
  name: string;
  status: string;
  statusMessage: string | null;
  durationMs: number;
  parentSpanId: string | null;
  attributes: Record<string, unknown>;
}

function spans(): Span[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Span),
    );
}

/** Stand-in for the network, installed before tracing wraps fetch. */
function stubFetch(body: unknown, contentType = 'application/json') {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  process.env.TRACE_DIR = dir;
  delete process.env.OTEL_SDK_DISABLED;
  realFetch = globalThis.fetch;
});

afterEach(async () => {
  await shutdownTracing();
  globalThis.fetch = realFetch;
  delete process.env.TRACE_DIR;
  delete process.env.OTEL_SDK_DISABLED;
  rmSync(dir, { recursive: true, force: true });
});

describe('withSpan', () => {
  it('writes a span with its name and attributes', async () => {
    const out = await withSpan('unit.probe', { 'probe.n': 7 }, async () => 'value');
    expect(out).toBe('value');
    await shutdownTracing();

    const s = spans().find((x) => x.name === 'unit.probe');
    expect(s).toBeDefined();
    expect(s!.attributes['probe.n']).toBe(7);
    expect(s!.status).toBe('OK');
    expect(s!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failure and rethrows, leaving behaviour unchanged', async () => {
    await expect(
      withSpan('unit.fails', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await shutdownTracing();

    const s = spans().find((x) => x.name === 'unit.fails');
    expect(s?.status).toBe('ERROR');
    expect(s?.statusMessage).toContain('boom');
  });

  it('nests child spans under their parent', async () => {
    await withSpan('unit.parent', {}, async () => {
      await withSpan('unit.child', {}, async () => undefined);
    });
    await shutdownTracing();

    const all = spans();
    const parent = all.find((x) => x.name === 'unit.parent');
    const child = all.find((x) => x.name === 'unit.child');
    expect(child?.parentSpanId).toBeTruthy();
    expect(child?.parentSpanId).not.toBe(parent?.parentSpanId);
  });

  it('emits nothing and does not throw when disabled', async () => {
    await shutdownTracing();
    process.env.OTEL_SDK_DISABLED = 'true';
    await expect(withSpan('unit.disabled', {}, async () => 1)).resolves.toBe(1);
    expect(spans()).toHaveLength(0);
    expect(getTraceFilePath()).toBeNull();
  });

  // Regression: provider.shutdown() alone leaves the global provider
  // registered, OTel rejects the next register() as a duplicate, and every
  // later span is dropped in silence — a trace that looks like an idle system.
  it('keeps producing spans across init/shutdown cycles', async () => {
    for (let i = 0; i < 3; i++) {
      initTracing();
      await withSpan(`unit.cycle${i}`, {}, async () => undefined);
      await shutdownTracing();
    }
    const names = spans().map((s) => s.name);
    expect(names).toContain('unit.cycle0');
    expect(names).toContain('unit.cycle1');
    expect(names).toContain('unit.cycle2');
  });
});

describe('LLM call tracing', () => {
  it('traces an inference request and reads Chat Completions usage', async () => {
    stubFetch({ model: 'gpt-4o', usage: { prompt_tokens: 11, completion_tokens: 3 } });
    initTracing();
    await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    await shutdownTracing();

    const s = spans().find((x) => x.name === 'gen_ai.request');
    expect(s).toBeDefined();
    expect(s!.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(s!.attributes['gen_ai.usage.input_tokens']).toBe(11);
    expect(s!.attributes['gen_ai.usage.output_tokens']).toBe(3);
  });

  // The agent goes through the Responses API, which names usage differently.
  it('reads Responses API usage too', async () => {
    stubFetch({ model: 'gpt-4o', usage: { input_tokens: 42, output_tokens: 8 } });
    initTracing();
    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', input: [] }),
    });
    await shutdownTracing();

    const s = spans().find((x) => x.name === 'gen_ai.request');
    expect(s!.attributes['gen_ai.usage.input_tokens']).toBe(42);
    expect(s!.attributes['gen_ai.usage.output_tokens']).toBe(8);
  });

  it('traces through a proxied base URL, not just api.openai.com', async () => {
    stubFetch({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    initTracing();
    await fetch('http://gateway.internal:9000/proxy/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o' }),
    });
    await shutdownTracing();
    expect(spans().filter((s) => s.name === 'gen_ai.request')).toHaveLength(1);
  });

  it('leaves non-inference traffic alone', async () => {
    stubFetch({ data: 'ok' });
    initTracing();
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: '{ viewer { login } }' }),
    });
    expect(await res.json()).toEqual({ data: 'ok' });
    await shutdownTracing();
    expect(spans().filter((s) => s.name === 'gen_ai.request')).toHaveLength(0);
  });

  it('does not double-count when tracing is initialised twice', async () => {
    stubFetch({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    initTracing();
    initTracing();
    await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o' }),
    });
    await shutdownTracing();
    expect(spans().filter((s) => s.name === 'gen_ai.request')).toHaveLength(1);
  });

  it('restores the original fetch on shutdown', async () => {
    const before = globalThis.fetch;
    initTracing();
    expect(globalThis.fetch).not.toBe(before);
    await shutdownTracing();
    expect(globalThis.fetch).toBe(before);
  });
});

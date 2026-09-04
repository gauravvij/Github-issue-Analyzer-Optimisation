/**
 * OpenTelemetry tracing.
 *
 * Every outbound call the system makes — GitHub GraphQL, OpenAI, Neo4j — and
 * every pipeline stage, agent run and tool invocation emits a span, so any
 * request can be reconstructed end to end after the fact.
 *
 * Two exporters, both optional-by-configuration but file-on-by-default:
 *   - JSONL file (always, unless disabled): one span per line under TRACE_DIR.
 *     No collector, no infra — greppable with jq, and the benchmark harness
 *     points TRACE_DIR at each run's job directory so every scored run keeps
 *     its own trace.
 *   - OTLP/HTTP: only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Environment:
 *   TRACE_DIR                    directory for JSONL traces (default .traces)
 *   OTEL_SERVICE_NAME            service name (default github-issue-analyzer)
 *   OTEL_SDK_DISABLED=true       turn tracing off entirely
 *   OTEL_EXPORTER_OTLP_ENDPOINT  also export over OTLP/HTTP
 *
 * Initialisation is lazy: the first getTracer()/withSpan() call sets it up, so
 * tracing works regardless of entry point (ingestion, agent, tests, harness).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  type Attributes,
  type Span,
  SpanStatusCode,
  type Tracer,
  context,
  trace,
} from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const SERVICE = process.env.OTEL_SERVICE_NAME || 'github-issue-analyzer';
const TRACER_NAME = 'github-issue-analyzer';

function disabled(): boolean {
  return process.env.OTEL_SDK_DISABLED === 'true';
}

// ---------------------------------------------------------------------------
// JSONL file exporter
// ---------------------------------------------------------------------------

const hrToMs = (t: [number, number]) => t[0] * 1e3 + t[1] / 1e6;

/**
 * Appends one JSON object per span. Uses SimpleSpanProcessor rather than a
 * batch one on purpose: spans are written as they end, so a crashed or
 * force-killed run still leaves a usable trace instead of an empty file.
 */
class JsonlFileExporter implements SpanExporter {
  private readonly path: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.path = join(dir, `${SERVICE}-${stamp}-${process.pid}.jsonl`);
  }

  get filePath(): string {
    return this.path;
  }

  export(spans: ReadableSpan[], done: (result: { code: number; error?: Error }) => void): void {
    try {
      const lines = spans.map((s) => {
        const ctx = s.spanContext();
        return JSON.stringify({
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId: s.parentSpanContext?.spanId ?? null,
          name: s.name,
          kind: s.kind,
          startTimeMs: hrToMs(s.startTime),
          endTimeMs: hrToMs(s.endTime),
          durationMs: hrToMs(s.duration),
          status: s.status.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK',
          statusMessage: s.status.message ?? null,
          attributes: s.attributes,
          events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })),
          service: SERVICE,
        });
      });
      appendFileSync(this.path, `${lines.join('\n')}\n`);
      done({ code: 0 });
    } catch (error) {
      done({ code: 1, error: error as Error });
    }
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let provider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;
let traceFilePath: string | null = null;

/**
 * LLM calls made by SDKs we do not own (the agent goes through Mastra/ai-sdk,
 * not the OpenAI SDK) are traced at the HTTP layer instead. Requests are
 * identified by shape — a POST to an inference path with a `model` in the body
 * — so this keeps working through a proxied base URL or a change of SDK.
 *
 * NOTE: this does NOT catch the `openai` SDK. That package resolves fetch
 * through a shim initialised when the package is imported, which happens
 * before this wrapper is installed, so its calls bypass it. Those calls are
 * covered by explicit spans instead (`openai.chat`, `tool.summarizeComments`),
 * which carry the same `gen_ai.usage.*` attributes. To count LLM calls or
 * tokens, aggregate over spans that HAVE those attributes — do not filter by
 * the span name `gen_ai.request`, which sees only part of the traffic.
 */
const INFERENCE_PATH = /\/(chat\/completions|completions|embeddings|responses|messages)\/?$/;

let originalFetch: typeof fetch | null = null;

function installFetchTracing(): void {
  // Idempotent: without this guard a second initTracing() wraps the already
  // wrapped fetch and every LLM call is recorded twice.
  if (originalFetch) return;
  const original = globalThis.fetch;
  originalFetch = original;

  const patched = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

    let model: string | null = null;
    try {
      if (INFERENCE_PATH.test(new URL(url).pathname)) {
        const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
        if (typeof raw === 'string') {
          const parsed = JSON.parse(raw) as { model?: unknown };
          if (typeof parsed.model === 'string') model = parsed.model;
        }
      }
    } catch {
      model = null;
    }
    if (model === null) return original(input, init);

    return withSpan(
      'gen_ai.request',
      {
        'gen_ai.system': 'openai',
        'gen_ai.request.model': model,
        'url.full': url,
        'http.request.method': 'POST',
      },
      async (span) => {
        const res = await original(input, init);
        span.setAttribute('http.response.status_code', res.status);
        const ctype = res.headers.get('content-type') ?? '';
        if (res.ok && ctype.includes('application/json')) {
          try {
            const json = (await res.clone().json()) as {
              model?: string;
              usage?: {
                prompt_tokens?: number | null;
                completion_tokens?: number | null;
                input_tokens?: number | null;
                output_tokens?: number | null;
              };
            };
            if (json.model) span.setAttribute('gen_ai.response.model', json.model);
            // Chat Completions and the Responses API report usage under
            // different names; record whichever is present.
            const inTok = json.usage?.prompt_tokens ?? json.usage?.input_tokens;
            const outTok = json.usage?.completion_tokens ?? json.usage?.output_tokens;
            if (inTok != null) span.setAttribute('gen_ai.usage.input_tokens', inTok);
            if (outTok != null) span.setAttribute('gen_ai.usage.output_tokens', outTok);
          } catch {
            /* body not readable as JSON — the span still records the call */
          }
        }
        return res;
      },
    );
  }) as typeof fetch;

  Object.assign(patched, original);
  globalThis.fetch = patched;
}

export function initTracing(): void {
  if (tracer || disabled()) return;

  const processors = [];
  const fileExporter = new JsonlFileExporter(process.env.TRACE_DIR || '.traces');
  traceFilePath = fileExporter.filePath;
  processors.push(new SimpleSpanProcessor(fileExporter));

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // Loaded only when configured. createRequire rather than a bare require:
    // this is an ES module, and bare require is undefined under node.
    const { OTLPTraceExporter } = createRequire(import.meta.url)(
      '@opentelemetry/exporter-trace-otlp-http',
    );
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': SERVICE,
      'service.version': process.env.SERVICE_VERSION || '0.1.0',
    }),
    spanProcessors: processors,
  });
  provider.register();
  tracer = trace.getTracer(TRACER_NAME);
  installFetchTracing();
}

export function getTracer(): Tracer {
  if (!tracer) {
    if (disabled()) return trace.getTracer(TRACER_NAME); // no provider -> no-op spans
    initTracing();
  }
  return tracer ?? trace.getTracer(TRACER_NAME);
}

/** Path of the JSONL trace for this process, once tracing has started. */
export function getTraceFilePath(): string | null {
  return traceFilePath;
}

export async function shutdownTracing(): Promise<void> {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  if (!provider) return;
  await provider.forceFlush();
  await provider.shutdown();
  // Unregister the global provider too. Without this, OTel refuses the next
  // register() as a duplicate and keeps handing out tracers from the shut-down
  // provider — so tracing silently stops producing spans instead of failing.
  trace.disable();
  provider = null;
  tracer = null;
  traceFilePath = null;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a span. Records the error and marks the span failed if `fn`
 * throws, then rethrows — tracing never changes behaviour.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = getTracer().startSpan(name, { attributes });
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

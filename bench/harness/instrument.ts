/**
 * Measurement instrumentation. Nothing here touches the system under test —
 * it wraps `globalThis.fetch` and the Neo4j driver singleton from the outside,
 * so the numbers cannot be gamed by editing github_issue/ and stay valid if
 * the SUT swaps SDKs.
 */

import type { Driver, Session } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// OpenAI accounting
// ---------------------------------------------------------------------------

/**
 * USD per 1M tokens. Update when prices change — a wrong number here silently
 * mis-ranks every cost-driven hypothesis.
 */
export const PRICES: Record<string, { in: number; out: number }> = {
  'gpt-4o': { in: 2.5, out: 10.0 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2.0, out: 8.0 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'text-embedding-3-small': { in: 0.02, out: 0 },
  'text-embedding-3-large': { in: 0.13, out: 0 },
};

export interface ModelUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** Requests whose token usage could not be read (e.g. streamed responses). */
  unmetered: number;
}

export interface OpenAIStats {
  requests: number;
  byModel: Record<string, ModelUsage>;
  /** Endpoint path -> request count, e.g. "/chat/completions". */
  byEndpoint: Record<string, number>;
  /** Host -> request count. A surprise host means traffic is going somewhere
   *  the price table may not describe. */
  byHost: Record<string, number>;
  /** Models seen that have no entry in PRICES — their cost is counted as 0. */
  unpricedModels: string[];
}

/**
 * Price lookup tolerant of `provider/model` prefixes (Mastra's model router
 * uses them) and dated snapshot suffixes. Returns null for an unknown model so
 * callers can flag it rather than quietly charging zero.
 */
export function priceOf(model: string): { in: number; out: number } | null {
  const bare = model.replace(/^[a-z0-9_-]+\//, '');
  return PRICES[bare] ?? PRICES[bare.replace(/-20\d{2}-\d{2}-\d{2}$/, '')] ?? null;
}

export function costOf(model: string, promptTokens: number, completionTokens: number): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
}

export interface OpenAIMeter {
  stats: OpenAIStats;
  costUsd(): number;
  reset(): void;
  uninstall(): void;
  /** Fold in usage reported by an SDK we could not read off the wire. */
  addReportedUsage(model: string, promptTokens: number, completionTokens: number): void;
}

function emptyUsage(): ModelUsage {
  return { requests: 0, promptTokens: 0, completionTokens: 0, unmetered: 0 };
}

/**
 * LLM requests are identified by SHAPE, not by hostname: a POST to a known
 * inference path carrying a JSON body with a `model` field.
 *
 * Detecting by URL substring looked fine while the SUT talked to
 * api.openai.com, but silently metered nothing the moment OPENAI_BASE_URL
 * pointed at a proxy (Azure, OpenRouter, LiteLLM, a local gateway) — and a
 * cost-driven loop reads "nothing metered" as "cost eliminated".
 */
const INFERENCE_PATH = /\/(chat\/completions|completions|embeddings|responses|messages)\/?$/;

/**
 * Two incompatible usage shapes are in play: Chat Completions returns
 * `prompt_tokens`/`completion_tokens`, the Responses API (which Mastra's agent
 * uses) returns `input_tokens`/`output_tokens`. Reading only the first shape
 * silently reported the agent's entire QA spend as $0.
 */
interface Usage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

function readUsage(u: Usage | undefined): { prompt: number; completion: number } | null {
  if (!u) return null;
  const prompt = u.prompt_tokens ?? u.input_tokens;
  const completion = u.completion_tokens ?? u.output_tokens;
  if (prompt == null && completion == null) return null;
  return { prompt: prompt ?? 0, completion: completion ?? 0 };
}

function inferenceModel(url: string, body: unknown): string | null {
  if (!INFERENCE_PATH.test(new URL(url).pathname)) return null;
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
}

/**
 * Wraps `globalThis.fetch`.
 *
 * MUST run before anything imports the `openai` package: that SDK resolves its
 * fetch through a shim initialised at import time, so a meter installed
 * afterwards never sees a single request and every cost silently reads $0.
 * Harness modules therefore import `openai` lazily (see `grade.ts`), and
 * preflight makes a live call asserting this meter actually saw it.
 */
export function installOpenAIMeter(): OpenAIMeter {
  const original = globalThis.fetch;
  const stats: OpenAIStats = { requests: 0, byModel: {}, byEndpoint: {}, byHost: {}, unpricedModels: [] };

  function bucket(model: string): ModelUsage {
    if (!stats.byModel[model]) stats.byModel[model] = emptyUsage();
    return stats.byModel[model];
  }

  const patched = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

    // The model name lives in the request body, which is never streamed.
    let raw: unknown = init?.body;
    if (raw === undefined && input instanceof Request) {
      try {
        raw = await (input as Request).clone().text();
      } catch {
        raw = undefined;
      }
    }

    const model = inferenceModel(url, raw);
    if (model === null) return original(input, init);

    stats.requests++;
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.replace(/^\/v\d+/, '');
    stats.byEndpoint[path] = (stats.byEndpoint[path] ?? 0) + 1;
    stats.byHost[parsedUrl.host] = (stats.byHost[parsedUrl.host] ?? 0) + 1;

    const res = await original(input, init);

    // Attribute to the model the RESPONSE reports, falling back to the request.
    // OpenAI answers a request for "gpt-4o-mini" with "gpt-4o-mini-2024-07-18",
    // so bucketing the request and the response separately counted one call
    // twice and left an empty bucket under the requested name.
    //
    // Usage is read off a buffered JSON response. Streamed (SSE) responses are
    // left alone — teeing them risks corrupting the SUT's own consumption —
    // and are reconciled later via addReportedUsage().
    let finalModel = model;
    let usage: { prompt: number; completion: number } | null = null;
    const ctype = res.headers.get('content-type') ?? '';
    if (res.ok && ctype.includes('application/json')) {
      try {
        const json = (await res.clone().json()) as { model?: string; usage?: Usage };
        if (typeof json.model === 'string') finalModel = json.model;
        usage = readUsage(json.usage);
      } catch {
        usage = null;
      }
    }

    const b = bucket(finalModel);
    b.requests++;
    if (usage) {
      b.promptTokens += usage.prompt;
      b.completionTokens += usage.completion;
    } else {
      b.unmetered++;
    }

    return res;
  }) as typeof fetch;

  // Bun/Node attach extras (e.g. `preconnect`) to the global fetch; keep them.
  Object.assign(patched, original);
  globalThis.fetch = patched;

  return {
    stats,
    costUsd() {
      let total = 0;
      stats.unpricedModels = [];
      for (const [model, u] of Object.entries(stats.byModel)) {
        const c = costOf(model, u.promptTokens, u.completionTokens);
        if (c === null) {
          if (u.promptTokens + u.completionTokens > 0) stats.unpricedModels.push(model);
          continue;
        }
        total += c;
      }
      return total;
    },
    reset() {
      stats.requests = 0;
      stats.byModel = {};
      stats.byEndpoint = {};
      stats.byHost = {};
      stats.unpricedModels = [];
    },
    uninstall() {
      globalThis.fetch = original;
    },
    addReportedUsage(model, promptTokens, completionTokens) {
      const b = bucket(model);
      b.promptTokens += promptTokens;
      b.completionTokens += completionTokens;
      if (b.unmetered > 0) b.unmetered--;
    },
  };
}

// ---------------------------------------------------------------------------
// Neo4j roundtrip accounting
// ---------------------------------------------------------------------------

export interface Neo4jStats {
  /** Every Cypher statement sent to the server, however it was issued. */
  queries: number;
  /** Sessions opened. */
  sessions: number;
  /** Managed transactions (executeRead/executeWrite) and explicit ones. */
  transactions: number;
  /** First 60 chars of each statement, in order — for spotting N+1 patterns. */
  samples: string[];
}

export interface Neo4jMeter {
  stats: Neo4jStats;
  reset(): void;
}

const SAMPLE_CAP = 4000;

/**
 * Wrap a driver instance so every Cypher statement is counted, whether issued
 * via `session.run`, an explicit transaction, or a managed
 * `executeRead`/`executeWrite` callback. plan.md's "75% fewer roundtrips"
 * target is only meaningful if UNWIND batching inside a managed transaction is
 * counted the same way as loose `session.run` calls.
 */
export function meterDriver(driver: Driver): Neo4jMeter {
  const stats: Neo4jStats = { queries: 0, sessions: 0, transactions: 0, samples: [] };

  function record(query: unknown) {
    stats.queries++;
    if (stats.samples.length < SAMPLE_CAP) {
      const text =
        typeof query === 'string' ? query : ((query as { text?: string })?.text ?? String(query));
      stats.samples.push(text.replace(/\s+/g, ' ').trim().slice(0, 60));
    }
  }

  function wrapRunner<T extends { run: (...a: any[]) => any }>(obj: T): T {
    const run = obj.run.bind(obj);
    (obj as { run: unknown }).run = (...args: unknown[]) => {
      record(args[0]);
      return run(...args);
    };
    return obj;
  }

  const openSession = driver.session.bind(driver);
  (driver as { session: unknown }).session = (...args: unknown[]) => {
    stats.sessions++;
    const session = openSession(...(args as [])) as Session;
    wrapRunner(session as unknown as { run: (...a: any[]) => any });

    for (const name of ['executeRead', 'executeWrite'] as const) {
      const fn = (session as any)[name];
      if (typeof fn !== 'function') continue;
      const bound = fn.bind(session);
      (session as any)[name] = (work: (tx: unknown) => unknown, ...rest: unknown[]) => {
        stats.transactions++;
        return bound((tx: { run: (...a: any[]) => any }) => work(wrapRunner(tx)), ...rest);
      };
    }

    const begin = (session as any).beginTransaction;
    if (typeof begin === 'function') {
      const bound = begin.bind(session);
      (session as any).beginTransaction = (...rest: unknown[]) => {
        stats.transactions++;
        return wrapRunner(bound(...rest));
      };
    }

    return session;
  };

  return {
    stats,
    reset() {
      stats.queries = 0;
      stats.sessions = 0;
      stats.transactions = 0;
      stats.samples = [];
    },
  };
}

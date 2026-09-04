/**
 * Fail-fast preflight.
 *
 * The previous auto-research loop burned two full ~1h benchmark jobs before
 * noticing the API key was never reaching the containers — every trial scored
 * 0 and looked like a real regression. Everything that can silently turn a run
 * into a wall of zeros is checked HERE, cheaply, before any money is spent.
 *
 * Every check either passes or aborts the run. There is no --skip flag on
 * purpose: a run that skipped preflight is a run whose numbers you cannot
 * trust, and it will be trusted anyway three days later.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { priceOf, type OpenAIMeter } from '../bench/harness/instrument';

// DERIVED FROM bench/harness/preflight.ts BY verification_bench/derive.ts — DO NOT EDIT.

export interface PreflightResult {
  name: string;
  pass: boolean;
  detail: string;
}

const BENCH = import.meta.dirname;
const SUT = resolve(BENCH, process.env.SUT_DIR ?? join('..', 'github_issue'));

/** Load github_issue/.env into process.env without overwriting real env vars. */
export function loadEnv(): string | null {
  const path = join(SUT, '.env');
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
  return path;
}

async function sh(cmd: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: out + err };
}

export async function preflight(opts: {
  split: string;
  meter: OpenAIMeter;
  typecheck: boolean;
}): Promise<PreflightResult[]> {
  const results: PreflightResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail });
    return pass;
  };

  // --- files ---------------------------------------------------------------
  check('sut_present', existsSync(join(SUT, 'package.json')), SUT);
  const deps = existsSync(join(SUT, 'node_modules', '@mastra', 'core'));
  check('sut_deps_installed', deps, deps ? 'node_modules present' : 'run `bun install` in github_issue/');

  const corpusPath = join(BENCH, 'corpus', `${opts.split}.json`);
  const tasksPath = join(BENCH, 'tasks', `${opts.split}.jsonl`);
  check('corpus_present', existsSync(corpusPath), corpusPath);
  check('tasks_present', existsSync(tasksPath), tasksPath);

  if (existsSync(corpusPath) && existsSync(tasksPath)) {
    const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));
    const tasks = readFileSync(tasksPath, 'utf-8').trim().split('\n');
    check(
      'splits_frozen',
      corpus.meta?.split === opts.split && tasks.length > 0,
      `${corpus.issues?.length ?? 0} issues, ${tasks.length} tasks, corpus built ${corpus.meta?.builtAt}`,
    );
    const canaries = tasks.filter((l) => JSON.parse(l).canary).length;
    check('canaries_present', canaries >= 1, `${canaries} canary task(s)`);
  }

  // The splits are the yardstick. Editing one silently invalidates every score
  // ever recorded against it, so the manifest is checked, not trusted.
  const manifest = join(BENCH, 'SPLITS.sha256');
  if (existsSync(manifest)) {
    const drifted: string[] = [];
    for (const line of readFileSync(manifest, 'utf-8').trim().split('\n')) {
      const [want, rel] = line.trim().split(/\s+/);
      const file = join(BENCH, rel);
      if (!existsSync(file)) {
        drifted.push(`${rel} missing`);
        continue;
      }
      const got = new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex');
      if (got !== want) drifted.push(rel);
    }
    check('splits_unmodified', drifted.length === 0,
      drifted.length ? `MODIFIED: ${drifted.join(', ')} — scores are not comparable` : 'checksums match');
  } else {
    check('splits_unmodified', false, 'verification_bench/SPLITS.sha256 missing');
  }

  // --- harness seams in the SUT -------------------------------------------
  const githubTs = existsSync(join(SUT, 'src/services/github.ts'))
    ? readFileSync(join(SUT, 'src/services/github.ts'), 'utf-8')
    : '';
  const seamUrl = githubTs.includes('process.env.GITHUB_API_URL');
  check('seam_github_api_url', seamUrl,
    seamUrl ? 'github.ts honours GITHUB_API_URL'
            : 'src/services/github.ts must honour GITHUB_API_URL or the corpus cannot be served');
  const seamCfg = existsSync(join(SUT, 'agent/config.ts'));
  check('seam_agent_config', seamCfg,
    seamCfg ? 'agent/config.ts present' : 'agent/config.ts must export INSTRUCTIONS / MODEL / TOOLS');

  // --- credentials ---------------------------------------------------------
  const key = process.env.OPENAI_API_KEY;
  if (!check('openai_key_set', !!key, key ? 'set' : 'missing OPENAI_API_KEY (github_issue/.env)')) {
    return results;
  }

  // The check that matters: a real call, that the meter actually saw, with
  // usage actually parsed. Catches a dead key, a proxy that eats usage, and a
  // runtime where fetch interception silently stops working.
  const before = opts.meter.stats.requests;
  try {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: key });
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    check('openai_key_live', !!r.choices?.length, `model=${r.model} usage=${r.usage?.total_tokens}`);
    const seen = opts.meter.stats.requests - before;
    check('meter_sees_openai', seen >= 1, `${seen} request(s) intercepted`);
    // Sum across buckets: the response is attributed to whatever model name
    // the API reports (a dated snapshot, typically), not the one requested.
    const buckets = Object.entries(opts.meter.stats.byModel);
    const prompt = buckets.reduce((t, [, u]) => t + u.promptTokens, 0);
    const completion = buckets.reduce((t, [, u]) => t + u.completionTokens, 0);
    check(
      'meter_reads_usage',
      prompt > 0,
      buckets.length
        ? `prompt=${prompt} completion=${completion} model=${buckets.map(([m]) => m).join(',')}`
        : 'no usage captured',
    );
    const unpriced = buckets.filter(([m]) => priceOf(m) === null).map(([m]) => m);
    check('meter_can_price_models', unpriced.length === 0,
      unpriced.length ? `no price for ${unpriced.join(', ')} — cost would read $0` : 'all models priced');
  } catch (err) {
    check('openai_key_live', false, err instanceof Error ? err.message : String(err));
    return results;
  }

  // --- docker / neo4j ------------------------------------------------------
  const docker = await sh(['docker', 'version', '--format', '{{.Server.Version}}'], 20_000);
  if (!check('docker_running', docker.code === 0, docker.out.trim().split('\n')[0])) return results;

  const { IMAGE, BOLT_PORT, HTTP_PORT, CONTAINER } = await import('./neo4j');
  const img = await sh(['docker', 'image', 'inspect', IMAGE], 20_000);
  if (img.code !== 0) {
    const pull = await sh(['docker', 'pull', IMAGE], 300_000);
    check('neo4j_image', pull.code === 0, pull.code === 0 ? `pulled ${IMAGE}` : pull.out.slice(-200));
  } else {
    check('neo4j_image', true, `${IMAGE} present`);
  }

  const ports = await sh([
    'docker', 'ps', '--format', '{{.Names}} {{.Ports}}',
  ], 20_000);
  const clash = ports.out
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith(CONTAINER))
    .filter((l) => l.includes(`:${BOLT_PORT}->`) || l.includes(`:${HTTP_PORT}->`));
  check(
    'ports_free',
    clash.length === 0,
    clash.length ? `port conflict: ${clash.join('; ')}` : `${BOLT_PORT}/${HTTP_PORT} available`,
  );

  // --- SUT builds ----------------------------------------------------------
  if (opts.typecheck) {
    const tsc = await sh(['bun', 'x', 'tsc', '--noEmit', '-p', join(SUT, 'tsconfig.json')], 240_000);
    check('sut_typechecks', tsc.code === 0, tsc.code === 0 ? 'clean' : tsc.out.trim().split('\n').slice(0, 6).join(' | '));
  }

  return results;
}

export function reportPreflight(results: PreflightResult[]): boolean {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  return results.every((r) => r.pass);
}

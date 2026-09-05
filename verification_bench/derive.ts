/**
 * `verification_bench/` reuses `bench/` rather than forking it.
 *
 * `bench/run.ts` and `bench/harness/preflight.ts` hardcode two paths — the SUT
 * directory and the benchmark directory — so they cannot simply be imported
 * from here. `bench/` is the referee and must not be edited (plan2.md rule 1),
 * so instead this script DERIVES the two files with a small, explicit patch:
 *
 *   - imports repointed at ../bench/harness/* (the meters, fake GitHub server,
 *     graders and integrity checks are reused verbatim)
 *   - SUT directory taken from $SUT_DIR, so one runner can score both
 *     github_issue/ (HEAD) and a git worktree of an older commit
 *   - BENCH directory becomes verification_bench/, so corpus, tasks, SPLITS
 *     and jobs come from here
 *
 * Everything else — meter-before-import ordering, the fingerprint, integrity,
 * grading, the trace fold, exit codes — is byte-identical to bench/.
 *
 *   bun verification_bench/derive.ts           regenerate
 *   bun verification_bench/derive.ts --check   fail if the checked-in copies drifted
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const BENCH = join(HERE, '..', 'bench');
const check = process.argv.includes('--check');

type Patch = { from: string; to: string; optional?: boolean };

function derive(src: string, patches: Patch[], label: string): string {
  let out = src;
  for (const p of patches) {
    const n = out.split(p.from).length - 1;
    if (n === 0 && p.optional) continue;
    if (n !== 1) throw new Error(`${label}: expected exactly 1 match for ${JSON.stringify(p.from)}, found ${n}`);
    out = out.replace(p.from, p.to);
  }
  return out;
}

/** Repoint a bench/ script at ../bench/harness and at $SUT_DIR. */
const COMMON: Patch[] = [
  { from: `import { join } from 'node:path';`, to: `import { join, resolve } from 'node:path';`, optional: true },
  { from: `import { join, relative } from 'node:path';`, to: `import { join, relative, resolve } from 'node:path';`, optional: true },
  { from: `from './scripts/build-corpus'`, to: `from '../bench/scripts/build-corpus'`, optional: true },
  { from: `from './scripts/build-tasks'`, to: `from '../bench/scripts/build-tasks'`, optional: true },
  { from: `from './harness/fake-github'`, to: `from '../bench/harness/fake-github'`, optional: true },
  { from: `from './harness/instrument'`, to: `from '../bench/harness/instrument'`, optional: true },
  { from: `from './harness/grade'`, to: `from '../bench/harness/grade'`, optional: true },
  { from: `from './harness/neo4j'`, to: `from './neo4j'`, optional: true },
  { from: `from './harness/preflight'`, to: `from './preflight'`, optional: true },
  {
    from: `const SUT = join(BENCH, '..', 'github_issue');`,
    to: `// Which implementation is under test. Defaults to the champion tree so a
// bare invocation behaves like bench/; set SUT_DIR to score another copy.
const SUT = resolve(BENCH, process.env.SUT_DIR ?? join('..', 'github_issue'));`,
    optional: true,
  },
];

const RUN_PATCHES: Patch[] = [
  {
    // run.ts alone grades against the repaired grader. bench/ is frozen, so the
    // two number/empty-set defects it carries are fixed by delegation in
    // grade-v2.ts; the alias keeps every call site byte-identical to bench/.
    from: `import { createJudge, gradeDeterministic, type Grade } from './harness/grade';`,
    to: `import { createJudge, gradeDeterministicV2 as gradeDeterministic, type Grade } from './grade-v2';`,
  },
  {
    from: ` *   bun bench/run.ts --split dev --job baseline
 *   bun bench/run.ts --split dev --job h1-confirm --attempts 3
 *   bun bench/run.ts --split dev --job qa-only --stage qa --keep-graph`,
    to: ` *   SUT_DIR=../github_issue bun verification_bench/run.ts --split dev --job head --attempts 3
 *   SUT_DIR=../.worktrees/baseline/github_issue bun verification_bench/run.ts --split dev --job base --attempts 3
 *
 * DERIVED FROM bench/run.ts BY verification_bench/derive.ts — DO NOT EDIT.`,
  },
  { from: ` * Writes bench/jobs/<job>/report.json.`, to: ` * Writes verification_bench/jobs/<job>/report.json.` },
  {
    // grade-v2 needs the question to tell a count the answer asserts from a
    // number it is quoting back out of the question (a date, an issue number).
    from: `          graded.push(gradeDeterministic(task.check, r.answer));`,
    to: `          graded.push(gradeDeterministic(task.check, r.answer, task.question));`,
  },
  ...COMMON,
];

const SMOKE_PATCHES: Patch[] = [
  { from: ` * Free self-test`, to: ` * DERIVED FROM bench/smoke.ts BY verification_bench/derive.ts — DO NOT EDIT.\n *\n * Free self-test`, optional: true },
  ...COMMON,
];

const ORACLES_PATCHES: Patch[] = [...COMMON];

const PREFLIGHT_PATCHES: Patch[] = [
  {
    from: `import { priceOf, type OpenAIMeter } from './instrument';`,
    to: `import { priceOf, type OpenAIMeter } from '../bench/harness/instrument';

// DERIVED FROM bench/harness/preflight.ts BY verification_bench/derive.ts — DO NOT EDIT.`,
  },
  {
    from: `const SUT = join(import.meta.dirname, '..', '..', 'github_issue');
const BENCH = join(import.meta.dirname, '..');`,
    to: `const BENCH = import.meta.dirname;
const SUT = resolve(BENCH, process.env.SUT_DIR ?? join('..', 'github_issue'));`,
  },
  { from: `import { join } from 'node:path';`, to: `import { join, resolve } from 'node:path';` },
  { from: `await import('./neo4j')`, to: `await import('./neo4j')` },
  { from: `'bench/SPLITS.sha256 missing'`, to: `'verification_bench/SPLITS.sha256 missing'` },
];

// build-tasks-v2.ts reuses these oracle helpers rather than keeping a second,
// silently diverging copy. The `import.meta.main` guard is load-bearing: without
// it, importing this module would run the generator and overwrite the frozen
// tasks/*.jsonl the moment anything imported a helper from it.
const TASKS_EXPORT_PATCH: Patch = {
  from: `main();`,
  to: `export { countBy, strictMax, titleTerms, issueText, stableTerms, dropSelfForbids, yyyymm };

if (import.meta.main) main();`,
};

const TASKS_PATCHES: Patch[] = [
  {
    from: ` * Generate the benchmark question set from a frozen corpus.`,
    to: ` * Generate the verification question set from a frozen corpus.
 *
 * DERIVED FROM bench/scripts/build-tasks.ts BY verification_bench/derive.ts —
 * DO NOT EDIT. The only behavioural change is \`stableTerms\`: bench/ hardcodes a
 * huggingface/datasets vocabulary there, which is meaningless for another repo.`,
  },
  { from: `import type { Corpus, CorpusIssue } from './build-corpus';`, to: `import type { Corpus, CorpusIssue } from '../../bench/scripts/build-corpus';` },
  {
    // Latent bug in bench/'s generator, never triggered by its corpus: when a
    // near-miss `forbid` value coincides with the correct answer, the task
    // becomes unpassable and silently costs every SUT a point. It fires here
    // because SWE-bench issues are all resolved, so closed_count == total.
    // Fixed once in add(), which every template routes through.
    from: `  const add = (t: Omit<Task, 'id'>) => {
    tasks.push({ id: \`\${split}-\${String(++seq).padStart(3, '0')}\`, ...t });
  };`,
    to: `  const add = (t: Omit<Task, 'id'>) => {
    tasks.push({ id: \`\${split}-\${String(++seq).padStart(3, '0')}\`, ...t, check: dropSelfForbids(t.check) });
  };`,
  },
  {
    from: `function buildTasks(corpus: Corpus, split: string, quota: number): Task[] {`,
    to: `/** A forbidden value that IS the answer makes a task unpassable. Never intended. */
function dropSelfForbids(check: Check): Check {
  switch (check.type) {
    case 'number':
      return { ...check, forbid: check.forbid?.filter((v) => v !== check.value) };
    case 'issue_set':
      return { ...check, forbid: check.forbid?.filter((v) => !check.expect.includes(v)) };
    case 'contains_all':
      return { ...check, forbid: check.forbid?.filter((v) => !check.values.includes(v)) };
    default:
      return check;
  }
}

function buildTasks(corpus: Corpus, split: string, quota: number): Task[] {`,
  },
  {
    from: `  const candidates = [
    'memory', 'parquet', 'streaming', 'shard', 'audio', 'image', 'cache', 'tokenizer',
    'multiprocessing', 'timeout', 'checksum', 'pandas', 'numpy', 'pyarrow', 'S3', 'JSON',
    'CSV', 'Windows', 'GPU', 'IterableDataset', 'load_dataset', 'push_to_hub', 'map',
    'concatenate', 'webdataset', 'polars', 'duckdb', 'zstd', 'gzip',
  ];`,
    to: `  // Mined from the corpus rather than hand-listed, so the generator is
  // corpus-independent instead of swapping one repo's vocabulary for another's.
  // Deterministic: frequency desc, then alphabetical, capped so the O(terms x
  // issues) scan below stays cheap. The case-stability filter still applies.
  const freq = new Map<string, number>();
  for (const issue of issues) {
    for (const word of new Set(issueText(issue).match(/[A-Za-z_][A-Za-z0-9_.]{3,}/g) ?? [])) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  const candidates = [...freq.entries()]
    .filter(([, n]) => n >= min && n <= max)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 200)
    .map(([word]) => word);`,
  },
  TASKS_EXPORT_PATCH,
];

const NEO4J_PATCHES: Patch[] = [
  { from: `import type { Corpus } from '../scripts/build-corpus';`, to: `import type { Corpus } from '../bench/scripts/build-corpus';

// DERIVED FROM bench/harness/neo4j.ts BY verification_bench/derive.ts — DO NOT EDIT.` },
  {
    // bench/'s corpus has null comment authors and no comment reactions (its
    // source dataset dropped both), so counting only ISSUE authors/reactions was
    // exact there. This corpus is fetched live from GitHub and has both, so the
    // expectations are generalised. On bench/'s corpus the generalised forms
    // reduce to the originals exactly — the extra terms are empty there.
    from: `    const expReactions = issues.reduce((s, i) => s + i.reactions.totalCount, 0);
    const expAuthors = new Set(issues.map((i) => i.author?.login).filter(Boolean)).size;`,
    to: `    // A Reaction node is MERGEd on {content, issueId, userLogin} — commentId is
    // not part of its identity — so the same user reacting the same way to two
    // comments on one issue is ONE node. Counting distinct keys is what the
    // graph actually holds. (Both SUTs share this identity, so it cannot bias
    // the comparison.)
    const reactionKeys = new Set<string>();
    for (const i of issues) {
      for (const r of i.reactions.nodes) reactionKeys.add(\`\${r.content}|\${i.id}|\${r.user.login}\`);
      for (const c of i.comments) {
        for (const r of c.reactions.nodes as { content: string; user: { login: string } }[]) {
          reactionKeys.add(\`\${r.content}|\${i.id}|\${r.user.login}\`);
        }
      }
    }
    const expReactions = reactionKeys.size;
    const expAuthors = new Set(
      [
        ...issues.map((i) => i.author?.login),
        ...issues.flatMap((i) => i.comments.map((c) => (c.author as { login: string } | null)?.login)),
      ].filter(Boolean),
    ).size;`,
  },
];

const outputs: [string, string][] = [
  ['run.ts', derive(readFileSync(join(BENCH, 'run.ts'), 'utf-8'), RUN_PATCHES, 'run.ts')],
  ['preflight.ts', derive(readFileSync(join(BENCH, 'harness', 'preflight.ts'), 'utf-8'), PREFLIGHT_PATCHES, 'preflight.ts')],
  ['scripts/build-tasks.ts', derive(readFileSync(join(BENCH, 'scripts', 'build-tasks.ts'), 'utf-8'), TASKS_PATCHES, 'build-tasks.ts')],
  ['smoke.ts', derive(readFileSync(join(BENCH, 'smoke.ts'), 'utf-8'), SMOKE_PATCHES, 'smoke.ts')],
  ['verify-oracles.ts', derive(readFileSync(join(BENCH, 'verify-oracles.ts'), 'utf-8'), ORACLES_PATCHES, 'verify-oracles.ts')],
  ['neo4j.ts', derive(readFileSync(join(BENCH, 'harness', 'neo4j.ts'), 'utf-8'), NEO4J_PATCHES, 'neo4j.ts')],
];

let drift = false;
for (const [name, content] of outputs) {
  const path = join(HERE, name);
  const current = (() => {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  })();
  if (current === content) {
    console.log(`  ok    ${name} (in sync with bench/)`);
    continue;
  }
  if (check) {
    console.error(`  DRIFT ${name} — re-run: bun verification_bench/derive.ts`);
    drift = true;
    continue;
  }
  writeFileSync(path, content);
  console.log(`  wrote ${name}`);
}
if (check && drift) process.exit(1);

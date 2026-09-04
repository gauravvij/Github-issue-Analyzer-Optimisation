# `bench/` — GitHub Issue Analyzer benchmark harness

Measures the system in `github_issue/` end to end so that changes to it can be
**kept or reverted on evidence** instead of on plausibility.

`bench/` is the referee. **Nothing in `bench/` may be edited by the optimisation
loop** — see the rules in [`../plan2.md`](../plan2.md).

---

## What it measures

Two halves, scored separately because they fail differently.

### 1. Ingestion (deterministic)

The pipeline runs unmodified against a **local fake GitHub GraphQL server**
backed by a frozen corpus. No network, no rate limits, no flaky weather — the
previous auto-research loop lost whole runs to network flakes counted as agent
failures.

| Metric | Meaning | Noise |
|---|---|---|
| `github.requests` | GraphQL calls to fetch the corpus | zero — exact integer |
| `github.maxConcurrent` | high-water mark of in-flight fetches; `1` = fully serial | zero |
| `neo4j.queries` | every Cypher statement, including ones inside `executeWrite` | zero |
| `neo4j.transactions` | managed/explicit transactions used | zero |
| `openai.requests`, tokens by model | read off the wire, per model | zero |
| `openai.costUsd` | tokens × `PRICES` in `harness/instrument.ts` | zero |
| `durationMs` | ingestion wall clock | **noisy** — OpenAI latency dominates; use a median of 3 |

The zero-noise counters are the ones to optimise against. Wall clock is a
sanity check, not a decision metric on a single run.

### 2. Agent QA (low noise)

40 dev / 20 holdout questions whose answers are **computed from the corpus**,
not written by a model. 35/40 are graded by exact number or issue-set
comparison — no judge, no variance. The remaining 5 are summarisation questions
graded by a fixed `gpt-4o` judge against a reference extract.

| Score | What it is |
|---|---|
| `score.deterministic` | structural + retrieval tasks — **the primary metric** |
| `score.semantic` | judge-graded summarisation — quality guardrail |
| `score.overall` | all tasks |
| `score.canaryPass` | the two trivial counting questions; a fail means look at the graph before believing anything |
| `score.toolUseRate` | fraction of answers that called a tool at all (anti-hallucination) |
| `score.agentErrorRate` | fraction of attempts that threw |

### 3. Integrity (pass/fail)

Assertions comparing the graph against the corpus: exact node and relationship
counts, no duplicate `Issue.number` / `issueId` / `commentId` / `User.login` /
`Label.name`, no orphan comments, exact issue-number membership, per-issue
comment fan-out. Plus informational counters: `constraints_defined`,
`indexes_defined`, `vector_indexes`, `nodes_with_embedding`, and the analysis
node yield (`solution_nodes`, `workaround_nodes`, `category_nodes`, …).

Integrity failures are **real regressions and stay in the report**. They do not
invalidate a run.

---

## Commands

### Verification (free — no API key, no cost)

Run these after any change to `bench/` or to `github_issue/src/services/`. If
any fails, no paid run is trustworthy.

**One command runs them all in the correct order** — the harness tests reset the
graph, so they must precede the checks that need an ingested one:

```bash
bun bench/verify-all.ts        # the gate: typechecks + every check below, ~1 min
bun bench/verify-all.ts --job h1   # gate, then a scored dev run
```

Individually:

```bash
bun test bench/                # 35 unit tests: meters, graders, integrity, pagination
bun bench/smoke.ts             # real pipeline, analysis off, asserts the graph vs the corpus
bun bench/verify-oracles.ts    # every frozen answer re-derived from the graph via its own Cypher
bun bench/verify-offline.ts    # the REAL runner end to end against a mock LLM (~2 min)
bun bench/verify-paths.ts      # the runner's other paths: --attempts, holdout, --stage, failure handling
```

`verify-offline.ts` is the important one: it spawns `run.ts` exactly as the
loop does, against `mock-openai.ts`, and asserts 29 properties of the resulting
report — ingestion metered, both token-usage shapes parsed, cost attributed,
integrity run, the agent tool loop actually executed, grading applied. It is a
plumbing check, not a quality check; its scores are meaningless.

**All of these reset the benchmark Neo4j graph.** Do not run them between
a `--stage ingest` and a `--stage qa --keep-graph` pair.

Job directories starting with `_` (e.g. `_offline-verify`) are harness
self-checks, not measurements. `verify-offline.ts` drops a `MOCK` file in its
job directory so a mock report can never be mistaken for a baseline.

### Scored runs

```bash
# Dev measurement
bun bench/run.ts --split dev --job baseline

# Confirmation run — single attempts are noise at this sample size
bun bench/run.ts --split dev --job h1-confirm --attempts 3

# Re-score the agent without re-paying for ingestion
bun bench/run.ts --split dev --job qa-only --stage qa --keep-graph

# Sealed holdout — ONCE, on the final candidate only
bun bench/run.ts --split holdout --job holdout-final

# Read a report / diff two runs (the flip fingerprint is the useful part)
bun bench/summarize.ts jobs/baseline
bun bench/summarize.ts jobs/baseline jobs/h1
```

Flags: `--attempts N`, `--latency-ms N` (simulated per-request GitHub latency,
default 120 — **do not change between runs you intend to compare**),
`--qa-concurrency N` (default 3), `--stage all|ingest|qa`, `--keep-graph`,
`--no-typecheck`.

Exit codes: `0` valid run, `2` preflight failed (nothing was spent), `3` run
completed but is INVALID.

---

## How the numbers were verified

Each link in the chain is checked by code that did not produce it:

| Link | Check |
|---|---|
| source dataset → `corpus/*.json` | 5 issues × 12 fields spot-checked against the live `helmo/github-issues` rows (title, body, state, author, timestamps, `node_id`, labels, reaction totals, first comment, PR exclusion) — all exact |
| corpus → graph | 20 integrity assertions, and `bun test bench/` proves each one **fails** on a deliberately corrupted graph |
| graph → frozen answers | `verify-oracles.ts` re-derives all 40 dev + 20 holdout answers with hand-written Cypher; 43 and 21 comparisons agree |
| metering | unit tests for both usage shapes, proxied base URLs, streamed responses, `UNWIND` vs loop statement counts, and `executeWrite`/`beginTransaction` |
| the runner itself | `verify-offline.ts`, 29 assertions on a real subprocess run; `verify-paths.ts` for `--attempts`, holdout, `--stage`, and agent-failure handling |

`SPLITS.sha256` pins the four frozen files. Preflight recomputes it every run
and aborts if any split was edited, so "the splits stay frozen" is enforced
rather than requested.

---

## Preflight

`run.ts` always runs preflight and there is no skip flag. It checks deps,
frozen splits, the two SUT seams, docker, the neo4j image, port conflicts,
`tsc --noEmit` on the SUT, and — the important one — makes a **live 1-token
OpenAI call and asserts the meter both saw it and parsed its usage**. That
single check is what makes "every task scored 0 because the key never arrived"
impossible to discover three runs later.

Preflight failure aborts before any spend and writes an invalid report.

---

## Layout

```
bench/
  corpus/dev.json          60 issues, frozen        ]  built once from
  corpus/holdout.json      40 issues, frozen        ]  helmo/github-issues
  tasks/dev.jsonl          40 questions + oracles   ]  by scripts/, then frozen
  tasks/holdout.jsonl      20 questions + oracles   ]
  scripts/build-corpus.ts  one-shot corpus builder  (rebuilding invalidates all scores)
  scripts/build-tasks.ts   one-shot question builder
  harness/fake-github.ts   local GraphQL server serving the corpus
  harness/instrument.ts    OpenAI fetch meter + Neo4j roundtrip meter + price table
  harness/neo4j.ts         container lifecycle, verified reset, integrity assertions
  harness/grade.ts         deterministic checkers + fixed judge
  harness/preflight.ts     fail-fast checks
  run.ts                   the runner
  summarize.ts             scorecard + before/after diff with flip fingerprint
  smoke.ts                 free self-test (real pipeline, analysis off)
  harness.test.ts          unit tests for the meters, graders and integrity checks
  mock-openai.ts           OpenAI-compatible mock (/chat/completions + /responses)
  verify-offline.ts        end-to-end check of run.ts against the mock
  verify-paths.ts          deeper check: --attempts, holdout, --stage, agent-failure handling
  verify-oracles.ts        re-derives every frozen answer from the graph
  verify-all.ts            the gate: runs every check above, in the order that works
  SPLITS.sha256            checksums of the four frozen files, enforced in preflight
  jobs/<name>/report.json  every run, kept ("_"-prefixed = self-check, not a score)
  jobs/<name>/traces/      OpenTelemetry spans emitted by that run
```

---

## Traces

The system under test emits an OpenTelemetry span for every outbound call. The
harness points `TRACE_DIR` at each job directory, so a score and the trace that
produced it never drift apart, and folds per-operation totals into
`report.json` under `.trace`.

`summarize.ts` prints that table and **warns if the SUT's tracing and the
harness meter disagree on the GitHub call count** — they measure the same thing
by different means, so a disagreement means one of them is broken.

```bash
cd github_issue && bun run trace:summary ../bench/jobs/<name>/traces
cd github_issue && bun run trace:summary ../bench/jobs/<name>/traces --tree
```

---

## Corpus fidelity — known gaps

The source dataset stores issue metadata faithfully but flattens two things.
Both are handled deterministically and documented so nobody re-derives them at
2am:

- **Comments have no ids and no authors.** Ids are synthesised as
  `IC_<issue>_<index>` (the analyzer keys extraction provenance off
  `commentId`); timestamps are monotonic from the issue's creation. Comment
  author is `null`, so no benchmark question asks who wrote a comment.
- **Reactions are aggregate counts, not per-user rows.** They are expanded into
  synthetic reactors (`reactor-<issue>-<kind>-<n>`) so the per-user reaction
  path is exercised. Counts match the source exactly.

Everything else — issue body, title, state, timestamps, labels, issue author,
comment bodies — is verbatim from the dataset.

---

## Two seams in the system under test

The harness needs exactly two hooks, both added **before** the baseline so they
are present in every measurement and bias nothing:

1. `src/services/github.ts` — `GITHUB_API_URL` is overridable by env. Unset in
   production, so real GitHub is still the default.
2. `agent/config.ts` — `INSTRUCTIONS` / `MODEL` / `TOOLS` extracted from
   `agent/index.ts` so the harness and the eval suite construct the *real*
   agent instead of a drifting copy. (The eval suite previously recovered the
   instructions by regexing `index.ts`; it now imports them.)

Preflight fails if either seam is removed.

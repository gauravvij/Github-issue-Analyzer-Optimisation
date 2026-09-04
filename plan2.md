# plan2.md — how to *execute* `plan.md` as an auto-research loop

`plan.md` says what to change. This file says how to run those changes as a
measured loop: **measure → read the failures → one hypothesis → smallest change
→ re-measure → keep only what holds.**

The scaffolding is `bench/` — see [`bench/README.md`](bench/README.md) for what
each metric means. This file is the operating brief for the agent doing the
optimisation.

---

## 0. One screen

```bash
bun bench/verify-all.ts --job baseline        # gate (free, ~1min) + measure
bun bench/summarize.ts jobs/baseline          # read the score AND the trace
#   ... make ONE change in github_issue/ ...
bun bench/verify-all.ts --job h1              # gate + measure again
bun bench/summarize.ts jobs/baseline jobs/h1  # before -> after + flip fingerprint
#   keep only if it holds at --attempts 3, else revert
```

A red gate means discard the cycle. See §6 for cadence, budget and unattended
runs.

Everything is written to `bench/jobs/<name>/report.json` and kept.

---

## 1. Rules

1. **Only `github_issue/` changes.** `bench/` — corpus, questions, graders,
   price table, instrumentation — is the referee. Editing it is editing your own
   exam. If a harness bug genuinely blocks you, say so and stop; do not patch
   around it.
2. **The frozen splits stay frozen.** `bench/corpus/*.json` and
   `bench/tasks/*.jsonl` are built once and pinned in `bench/SPLITS.sha256`;
   preflight recomputes the checksums and aborts if any changed. Rebuilding
   them invalidates every score ever recorded. If you need new question types
   (e.g. semantic retrieval to exercise vector search), add a **new** split;
   never modify `dev` or `holdout`.
3. **Holdout is sealed.** Do not run `--split holdout` until you have a final
   frozen candidate. Run it exactly once. Report dev and holdout separately — a
   gain that does not survive holdout is not a gain.
4. **No question-specific code.** Never reference a benchmark issue number,
   label, author, or question string in `github_issue/`. A fix must be general
   or it is not a fix.
5. **One change per measurement.** Two changes in one run means you learn
   nothing about either.
6. **Confirm before believing.** `--attempts 1` is noise at 40 questions. Any
   change you intend to keep gets a `--attempts 3` re-run first.
7. **Gate before you score.** Run `bun bench/verify-all.ts` — it is free, takes
   about a minute, and runs every check in the one order that works (the
   harness tests reset the graph, so they must precede the checks that need an
   ingested one). A red gate means discard the cycle.
8. **Leave tracing on.** It is on in the baseline. Turning it off for a
   candidate makes that candidate look faster for a reason unrelated to the
   hypothesis. `OTEL_SDK_DISABLED` is for production, not for measurement.
9. **Run jobs sequentially.** This box is 4 cores / 15 GB with Neo4j in Docker.
   Two concurrent benchmark jobs corrupt each other's graph — they share one
   container — and skew every latency number.

---

## 2. Layout

```
github_issue/     the system under test. The only thing you may change.
bench/            the harness. Read-only. See bench/README.md.
prompt.md         the one-page brief to hand the agent running the loop.
plan.md           what to change and why (the six phases).
plan2.md          this file — how to run it as a loop.
ledger.md         running changelog. Append one entry per hypothesis.
```

---

## 3. Commands

| Purpose | Command |
|---|---|
| **Full gate, correct order (free)** | **`bun bench/verify-all.ts`** |
| **Gate + a scored run** | **`bun bench/verify-all.ts --job <name>`** |
| Harness unit tests (free) | `bun test bench/` |
| Pipeline self-test, analysis off (free) | `bun bench/smoke.ts` |
| Re-derive every frozen answer from the graph (free) | `bun bench/verify-oracles.ts` |
| End-to-end check of the runner vs a mock LLM (free) | `bun bench/verify-offline.ts` |
| Deeper path checks: attempts/holdout/stage/failures (free) | `bun bench/verify-paths.ts` |
| Dev measurement | `bun bench/run.ts --split dev --job <name>` |
| Confirmation (n=3) | `bun bench/run.ts --split dev --job <name> --attempts 3` |
| Ingestion only | `bun bench/run.ts --split dev --job <name> --stage ingest` |
| QA only, reuse graph | `bun bench/run.ts --split dev --job <name> --stage qa --keep-graph` |
| Sealed holdout (once) | `bun bench/run.ts --split holdout --job holdout-final` |
| Scorecard | `bun bench/summarize.ts jobs/<name>` |
| Before → after + flips | `bun bench/summarize.ts jobs/<a> jobs/<b>` |
| Where the time went | `cd github_issue && bun run trace:summary ../bench/jobs/<name>/traces` |

`--stage qa --keep-graph` is the cost lever: agent-side hypotheses (Phase 5) do
not need ingestion re-paid. Ingestion-side hypotheses (Phases 2–4) do.

Requires `github_issue/.env` with `OPENAI_API_KEY`. Preflight makes a live
1-token call and asserts the meter saw it, so a dead or missing key aborts in
seconds instead of producing a wall of zeros.

---

## 4. Baseline

<!-- BASELINE:BEGIN -->
Job `baseline`, dev split, `--attempts 1`, SUT fingerprint `71c696b48a9da953`.
Run it yourself with `bun bench/verify-all.ts --job <name>`; the full report is
`bench/jobs/baseline/report.json` and its spans are beside it in `traces/`.

### Score

| Metric | Baseline |
|---|---|
| **`score.deterministic`** (primary, 35 tasks) | **94.3%** |
| `score.semantic` (5 judge tasks) | 80.0% |
| `score.overall` | 92.5% |
| solved | 37/40 |
| canaries | pass |
| tool-use rate | 100% |
| agent error rate | 0% |

### Ingestion — the zero-noise counters to optimise against

| Metric | Baseline | Target hypothesis |
|---|---|---|
| `github.requests` | **121** (1 listing + 2 per issue) | — |
| `github.maxConcurrent` | **1** (strictly serial) | H8 |
| `neo4j.queries` | **610** | H2, H9 |
| `neo4j.transactions` | **0** | H2 |
| `openai.requests` | 60 (`gpt-4o`) | H4 |
| `openai.costUsd` (ingest) | **$0.2972** | H4, H6 |
| `constraints_defined` | **0** | H1 |
| `indexes_defined` | **0** | H1 |
| `vector_indexes` / `nodes_with_embedding` | **0 / 0** | H7 |
| `solution_nodes` / `workaround_nodes` | 34 / 23 | H5 |
| `durationMs` (noisy — median of 3) | 242.8s | H8 |

Integrity: **all pass**. Cost: ingest $0.2972 + QA $0.2557 = **SUT $0.5529** per dev run
(judge overhead $0.0333, not charged to the SUT).

### Where the time goes (from the run's own trace)

| Operation | Calls | Total |
|---|---|---|
| `pipeline.analyzeIssue` | 60 | 219s |
| `pipeline.fetch` | 1 | 15s |
| `neo4j.query` | 683 | 9s |
| `pipeline.ingest` | 1 | 3s |

LLM analysis is ~90% of ingestion wall clock. Fetching is second and fully serial.

### The three known baseline failures

| Task | Cause |
|---|---|
| `dev-003` open_count | Agent queries `i.state = 'open'`; the graph stores GitHub's enum casing `'OPEN'`, so it returns 0 and answers "there are currently no open issues". **The schema block in `agent/config.ts` documents `state (STRING)` without its permitted values.** H12. |
| `dev-004` closed_count | Same root cause, same casing guess. Flickers between runs — it failed here and passed in the previous run, so these two tasks are ONE defect, not two independent ones. |
| `dev-040` summarize_issue | Genuine drift: the answer generalises to "The Pile" and unrelated tooling instead of the specific download failure. |

### The n=3 anchor — compare against THIS

Job `baseline-n3` (`--attempts 3`, same SUT fingerprint). Use it as the
reference for any keep/revert decision: §7 requires candidates at `--attempts
3`, and comparing an n=3 candidate against an n=1 baseline biases every call.

| Metric | n=3 anchor |
|---|---|
| **`score.deterministic`** | **94.3%** |
| `score.semantic` | 80.0% |
| `score.overall` | 92.5% |
| solved on **every** attempt | **36/40** |
| solved on ≥1 attempt | 38/40 |
| cost | $1.064 SUT (+$0.098 judge) |

### Measured variance — where the noise actually is

At n=3 the deterministic set is **stable**: the only failures are `dev-003` and
`dev-004`, both **0/3**, both the same state-casing defect. Nothing else
oscillates. Across five attempts each, `dev-003` passed 0/5 and `dev-004` 1/5 —
so the earlier impression that they "flicker" was an artefact of two n=1 runs.

All of the variance sits in the **judge-graded** tasks: `dev-036` scored 2/3 and
`dev-040` 1/3 on identical code. With only 5 semantic tasks, **one task is 20
points**, so `score.semantic` swings ±20pts on noise alone.

Consequences, and they are not symmetric:

- A `score.deterministic` move of even one task (2.9pts) at n=3 is **real
  signal** — treat it seriously in both directions.
- A `score.semantic` move of one task (20pts) at n=3 is **within noise**. Only
  act on it if it moves two or more tasks, or if the flip fingerprint shows the
  same task failing consistently for a stated reason.
- The three ingestion counters (`github.requests`, `neo4j.queries`,
  `neo4j.transactions`) were **byte-identical across all three runs** while wall
  clock varied by 16s. They are the metrics to steer by.
<!-- BASELINE:END -->

---

## 5. One cycle

1. **Gate** — `bun bench/verify-all.ts`. Free, ~1 minute, and it runs every
   check in the one order that works. A red gate means stop: nothing measured
   after it is trustworthy.
2. **Read the failures**, not the score. `bun bench/summarize.ts jobs/<name>`
   prints a "Failing task details" section with, for each failure, the expected
   answer, the reason it failed, **and the Cypher the agent actually ran**.
   Cross-read it with the run's own trace (§9) — the score says *what* is
   wrong, the trace says *where the time and calls went*.
3. **Form ONE hypothesis** about a weakness — a pipeline bottleneck, a schema
   gap, a prompt defect, a tool that returns unusable errors.
4. **Make the smallest change** in `github_issue/` that tests it.
5. **Gate again** — `bun bench/verify-all.ts`. This is the step that catches a
   change which quietly broke ingestion before you pay to discover it.
6. **Measure** — `bun bench/run.ts --split dev --job <name>`.
7. **Decide** using §7. Keep or revert. Append to `ledger.md` either way —
   rejected hypotheses are the most useful part of the record.
8. Repeat until dev plateaus, then run the sealed holdout once.

---

## 6. Running continuously

One command does the gate and the measurement, in order, stopping at the first
failure:

```bash
bun bench/verify-all.ts --job h1                 # gate, then a scored dev run
bun bench/verify-all.ts --job h1-confirm --attempts 3
bun bench/verify-all.ts --deep                   # free gate + slower path checks
bun bench/verify-all.ts                          # free gate only, $0
```

Exit code 0 means the gate passed and, if `--job` was given, the run completed.
Non-zero means **discard the cycle** — do not read a score out of it.

### Cadence

| | Cost | Time | When |
|---|---|---|---|
| `verify-all.ts` (free gate) | $0 | ~1 min | after **every** edit to `github_issue/` or `bench/` |
| `--job <n>` (dev measurement) | ~$1–2 | ~10–15 min | once per hypothesis |
| `--job <n> --attempts 3` | ~$3–5 | ~30–40 min | before keeping any change |
| `--split holdout` | ~$1 | ~10 min | **once**, at the very end |

Budget roughly **$25–40** for a full loop of ~10 hypotheses with confirmations.

### Unattended

Runs are long; do not hold them in a foreground shell, and **never run two at
once** — they share one Neo4j container and would corrupt each other's graph.

```bash
nohup bun bench/verify-all.ts --job h1 > bench/jobs/h1.log 2>&1 &
tail -f bench/jobs/h1.log
```

Poll for completion by waiting for `bench/jobs/h1/report.json`, then check
`.valid` before reading `.score`:

```bash
jq '{valid, invalidReason, score: .score.deterministic, cost: .cost.sutTotalUsd}' bench/jobs/h1/report.json
```

### What each cycle must leave behind

- `bench/jobs/<name>/report.json` — the numbers (kept forever, never edited).
- `bench/jobs/<name>/traces/*.jsonl` — every span from that run.
- One `ledger.md` entry: hypothesis, the diff, gate result, before/after, and
  KEEP or REVERT **with the reason**. Write it for rejected hypotheses too.

### When to stop

Stop the loop and run the sealed holdout when any of these is true:

- three consecutive hypotheses fail to hold at `--attempts 3`;
- the remaining dev failures are distinct, unrelated failure modes rather than
  one shared cause (that was the plateau signal in the previous loop);
- every hypothesis in §8 has been tried and decided.

Do not keep iterating past a plateau — at 40 questions you will start fitting
noise, and the holdout will say so.

---

## 7. Accept / reject rule

The primary metric is **`score.deterministic`** — 35 of 40 dev questions graded
by exact number or issue-set match, no judge, no variance. Everything else is a
guardrail.

Keep a change only if **all** of these hold:

Compare against the **n=3 anchor** (`jobs/baseline-n3`), not the n=1 baseline.

| Condition | Threshold |
|---|---|
| `score.deterministic` | not below the anchor at `--attempts 3`. Measured variance at n=3 is zero on this set, so a 1-task drop (−2.9 pts) is a real regression, not noise |
| `score.semantic` | not below the anchor by **more than 1 task (20 pts)** — with 5 tasks and two of them measured at 2/3 and 1/3, a single-task move is noise |
| Integrity | no check that passed at baseline now fails |
| `score.canaryPass` | still `true` |
| `score.agentErrorRate` | not higher than baseline |
| At least one target metric | **materially** improved (see §8) |

"Materially" means outside noise: a zero-noise counter (`neo4j.queries`,
`github.requests`, `github.maxConcurrent`, `openai.requests`, `openai.costUsd`)
moving at all is real. `durationMs` needs a median of 3 runs and a ≥20% move.

If the score improves but integrity regresses, **revert**: a faster pipeline
that duplicates nodes is a worse pipeline that happens to score well today.

If a change is score-neutral but improves a zero-noise counter with no
regression anywhere, keep it — that is exactly what Phases 2–4 are.

---

## 8. `plan.md` phases → hypotheses → the metric each must move

This is the bridge. Each phase of `plan.md` is one or more hypotheses, and each
hypothesis names the metric that proves it and the metric that must not move.

| # | `plan.md` | Change | Must improve | Must not regress | Re-pay ingestion? |
|---|---|---|---|---|---|
| H1 | Ph2 | Uniqueness constraints + range indexes (`setupDatabaseSchema`) | `constraints_defined` 0 → ≥7; `indexes_defined` | all integrity, score | yes |
| H2 | Ph2 | `UNWIND` batching inside `session.executeWrite` | `neo4j.queries` ↓ (target ≥75%); `neo4j.transactions` 0 → >0; trace `neo4j.query` count ↓ | all integrity, score | yes |
| H3 | Ph2 | Scope the orphan `Competitor`/`Category` sweep to the issue | `neo4j.queries`, `durationMs` | `competitor_nodes`, `category_nodes`, integrity | yes |
| H4 | Ph3 | Extraction + summariser → `gpt-4o-mini` | `openai.costUsd` ↓ (target ≥90%) | `score.deterministic`, `score.semantic`, `solution_nodes` | yes |
| H5 | Ph3 | Prompt extracts solutions/workarounds from the **body**, not comments only | `solution_nodes`, `workaround_nodes` ↑ | score, cost | yes |
| H6 | Ph3 | Bot/noise filtering + token bounds on comment text | `openai` prompt tokens ↓ | `score.semantic`, `solution_nodes` | yes |
| H7 | Ph3/5 | Embeddings + Neo4j vector index | `vector_indexes` 0 → ≥1; `nodes_with_embedding` 0 → >0 | `openai.costUsd`, score | yes |
| H8 | Ph4 | `p-limit` concurrent fetch / analyse / write | `github.maxConcurrent` 1 → >1; `durationMs` ↓; trace `pipeline.fetch` total ↓ | `github.requests` (must NOT rise), integrity | yes |
| H9 | Ph4 | In-memory handoff — drop the `fetchMultipleIssueDetails` read-back | `neo4j.queries` ↓ | integrity, score | yes |
| H10 | Ph5 | `queryNeo4j` error feedback + retry on bad Cypher | `score.deterministic`, `agentErrorRate` ↓ | QA `openai.costUsd` | **no** (`--stage qa --keep-graph`) |
| H11 | Ph5 | `semanticSearchTool` | `score.semantic`, `score.byKind.retrieval` | `score.structural`, QA cost | no, after H7 |
| H12 | Ph5 | Sharpened agent instructions / schema prompt | `score.deterministic` | cost, `toolUseRate` | no |

Order matters: **H10 and H12 first** — they are agent-side, need no ingestion
re-pay, and cost cents per iteration. Then H1–H3 (free, deterministic
counters). Then H4 (the big cost win). H7/H11 last, since vector search is the
only item that adds a new capability rather than improving an existing one.

### Two `plan.md` claims this harness cannot fully prove

Be honest about these in the final report:

- **"4×–8× ingestion latency reduction."** Measurable, but `durationMs` includes
  real OpenAI latency and is noisy. The zero-noise proxy is
  `github.maxConcurrent` (1 today = strictly serial) plus the request count.
  Quote both, and take a median of 3 for wall clock.
- **"Successful semantic vector similarity search."** The frozen question set is
  lexical; it will show whether vector search *helps or hurts* the score, but it
  does not by itself prove retrieval quality. The harness reports
  `vector_indexes` and `nodes_with_embedding` as capability checks. To score
  it properly, add a **new** split (rule 2) — do not touch `dev`/`holdout`.

---

## 9. Tracing — reading what actually happened

Every outbound call the system makes is a span: GitHub GraphQL, Neo4j
statements (traced at the driver, so statements inside `executeWrite` count
too), OpenAI calls from the ingestion analyser, LLM calls made by the agent
through Mastra (traced at the HTTP layer, so they survive a model or SDK
change), each pipeline stage, and each agent tool invocation.

`bench/run.ts` points `TRACE_DIR` at `bench/jobs/<name>/traces/`, so **every
scored run keeps the trace that produced it**, and folds per-operation totals
into `report.json` under `.trace`.

```bash
cd github_issue
bun run trace:summary ../bench/jobs/h1/traces          # where the time went
bun run trace:summary ../bench/jobs/h1/traces --tree    # span tree, slowest trace
jq -c 'select(.status=="ERROR")' ../bench/jobs/h1/traces/*.jsonl
jq -r 'select(.name=="neo4j.query") | .attributes["db.statement"]' \
  ../bench/jobs/h1/traces/*.jsonl | sort | uniq -c | sort -rn   # the N+1 offenders
```

**Counting LLM calls**: aggregate spans that carry `gen_ai.usage.*` attributes,
never spans named `gen_ai.request` alone. Ingestion calls appear as
`openai.chat` and the summariser tool as `tool.summarizeComments` — the
`openai` SDK resolves fetch through a shim bound at import time, so those calls
bypass the HTTP-layer wrapper. `trace:summary` already aggregates correctly.

`bun bench/summarize.ts` prints the same table, and warns loudly if the SUT's
own tracing and the harness meter disagree on the GitHub call count — they
measure the same thing by different means, so a disagreement means one of them
is broken and the run's ingestion numbers cannot be trusted.

### What the traces already show about `plan.md`

From the baseline shape: `pipeline.ingest` dominates wall clock, `neo4j.query`
fires hundreds of times with the same handful of statements repeated per issue,
and `github.graphql` shows 121 calls at concurrency 1. That is H2, H8 and H9
visible directly rather than inferred.

### Configuration

| Variable | Effect |
|---|---|
| `TRACE_DIR` | where JSONL traces are written (default `.traces`) |
| `OTEL_SDK_DISABLED=true` | turn tracing off entirely |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | additionally export over OTLP/HTTP to a collector |
| `OTEL_SERVICE_NAME` | service name on every span |

**Leave tracing on for every measured run.** It is on in the baseline, so
turning it off for a candidate would make that candidate look faster for a
reason that has nothing to do with the hypothesis.

---

## 10. Traps

Carried over from the previous auto-research loop on this box, plus the ones
specific to this system. These are the things that got discovered late last
time.

- **Two full benchmark jobs were wasted because the API key never reached the
  agent** — every trial scored 0 and read as a real regression. Now impossible:
  preflight makes a live call and asserts the meter saw it and parsed its usage.
  If preflight fails, nothing is spent. Never add a skip flag.
- **`n=1` is noise.** Last loop, three of four apparent regressions were
  stochastic and did not repeat at `n=3`. Confirm before keeping.
- **A "fix" can backfire in a way the score hides.** Last loop, a
  self-verification guideline raised the mean score while silently introducing a
  duplicate-class artifact. Here the equivalent is a faster pipeline that
  duplicates nodes: watch the integrity block, not just the score.
- **Run jobs sequentially.** Parallel heavy Docker jobs raced on this box.
- **A dirty Neo4j silently inflates every count.** `run.ts` resets and then
  *verifies* the reset. If you use `--keep-graph`, the integrity block is your
  proof the graph is still the benchmark graph — read it before believing a QA
  score.
- **Score the code you think you are scoring.** Every report records a
  `sut.hash` fingerprint over all `src/`, `agent/` and `ingestion/` sources.
  Two runs with the same hash measured the same code.
- **Cost can be "improved" by doing less work.** Dropping analysis entirely
  makes `openai.costUsd` go to zero. That is why `solution_nodes` /
  `workaround_nodes` / `score.semantic` are guardrails on every cost hypothesis.
- **`--latency-ms` must not change between compared runs.** It is the simulated
  GitHub latency; changing it changes every wall-clock number.
- **The judge model is fixed at `gpt-4o`.** Changing it moves every historical
  semantic score. Judge cost is reported separately and is not charged to the
  SUT.
- **Cost metering is fragile in three specific ways, all of which read as
  "$0 = huge win".** All three were found and fixed while testing the harness,
  and each now has a regression test — but if you touch anything near them,
  re-run `bun bench/verify-offline.ts`, which asserts non-zero metered cost on
  both API shapes:
  1. `openai`'s shim captures `globalThis.fetch` **at import time**. Any
     top-level `import ... from 'openai'` that loads before the meter is
     installed blinds it permanently. Harness modules import it lazily; a test
     greps for offenders.
  2. LLM traffic is identified by request *shape*, not hostname — detecting by
     hostname metered nothing through a proxied `OPENAI_BASE_URL`.
  3. Chat Completions reports `prompt_tokens`/`completion_tokens`; the
     Responses API that Mastra's agent uses reports
     `input_tokens`/`output_tokens`. The meter reads both, and falls back to
     the agent's own reported totals if a model streams.
- **`"@mastra/core": "latest"` is unpinned.** A stray `bun install` can change
  the agent framework under the benchmark. `bun.lock` is part of the recorded
  `sut.hash`, so two runs with the same hash used the same framework; a hash
  change with no source diff means the dependencies moved.
- **`--stage qa --keep-graph` scores whatever graph is loaded.** Every ingest
  stamps a `BenchMeta` node, and QA-only runs print and record which job and
  SUT hash built the graph they are querying.

---

## 11. Deliverables

When the loop terminates:

1. **`ledger.md`** — one entry per hypothesis: what, why, the diff, the gate
   result, dev score before/after, and KEEP or REVERT with the reason. Rejected
   hypotheses included.
2. **The traces**: `bench/jobs/<name>/traces/*.jsonl` for every run you cite.
   A number without the trace that produced it is not reproducible.
3. **A final report** (append to this file or a `RESULTS.md`) with:
   - dev before → after, holdout before → after, quoted separately;
   - the kept diff;
   - the per-hypothesis table;
   - what was tried and rejected, and why;
   - which `plan.md` evaluation criteria were met, which were not, and which
     this harness could not prove.
4. **Only numbers from runs you actually ran.** Every number must trace to a
   `bench/jobs/<name>/report.json` that still exists.

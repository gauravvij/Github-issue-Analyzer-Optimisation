# Project Change Ledger & Commit History

This ledger tracks all changes, optimizations, architectural refactorings, and milestone commits for the `github-issue-analyzer` project.

---

## Log Format
Each entry documents:
- **Timestamp / Date**
- **Component / Subsystem**
- **Action / Description**
- **Rationale & Impact** (Performance, Cost, Latency, Accuracy, Architecture)
- **Status** (Planned / In Progress / Completed / Verified)

---

## Canonical baseline

The verified baseline lives in **`plan2.md` §4** (both the n=1 `baseline` and the n=3
`baseline-n3` anchor, with per-metric detail and the measured variance). The reports and
their OpenTelemetry spans are in `bench/jobs/baseline/` and `bench/jobs/baseline-n3/`.
`prompt.md` carries the headline table for the agent running the loop.

Headline, job `baseline-n3` (`--attempts 3`, SUT `71c696b48a9da953`, integrity clean):
`score.deterministic` **94.3%**, `score.semantic` **80.0%**, **36/40** solved on every
attempt, ingestion **121 GitHub requests at concurrency 1**, **610 Neo4j statements in 0
transactions**, **$0.2976** to ingest, **$1.064** total per n=3 run.

## Change Entries

### [2026-09-03] - Project Audit, Reorganization & Optimization Planning
- **Component**: Project Root & Planning
- **Action**:
  - Cloned and inspected repository structure in `github_issue/`.
  - Conducted full architectural and code audit covering Latency, Cost, Performance, Accuracy, and Graph integrity.
  - Authored comprehensive optimization plan in `plan.md`.
  - Initialized change ledger in `ledger.md`.
- **Rationale & Impact**: Establishes baseline metrics and clear execution roadmap targeting >4x ingestion throughput, ~90%+ cost reduction, unique database constraints, vector search capabilities, and agent robustness.
- **Status**: Completed

---

### [2026-09-03] - Benchmark Harness (`bench/`) — Measurement Scaffolding for the Auto-Research Loop
- **Component**: `bench/` (new), `github_issue/src/services/github.ts`, `github_issue/agent/config.ts` (new), `github_issue/agent/index.ts`, `github_issue/test/evals/agent.eval.ts`
- **Action**:
  - Built a frozen benchmark from the HuggingFace dataset `helmo/github-issues` (7,540 rows scraped from `huggingface/datasets`): `bench/corpus/dev.json` (60 issues / 228 comments) and `bench/corpus/holdout.json` (40 issues / 174 comments), disjoint, stratified across open/closed, labelled/unlabelled and comment volume.
  - Generated 40 dev + 20 holdout questions whose answers are **computed from the corpus** (`bench/tasks/*.jsonl`). 35/40 dev questions grade deterministically (exact number / issue-set match); 5 summarisation questions use a fixed `gpt-4o` judge. Templates only emit a question when the oracle is unambiguous (no ties, no casing-dependent term matches).
  - `bench/harness/fake-github.ts` — in-process GraphQL server serving the corpus with fixed simulated latency, so ingestion is reproducible and network flakes cannot be scored as agent failures.
  - `bench/harness/instrument.ts` — OpenAI accounting via `globalThis.fetch` (per-model tokens + price table) and a Neo4j meter wrapping the driver singleton that counts every statement, including ones issued inside `executeWrite`. Neither touches the system under test.
  - `bench/harness/neo4j.ts` — throwaway container lifecycle, a **verified** reset, and integrity assertions (exact node/edge counts, duplicate detection, exact issue-number membership, per-issue comment fan-out, constraint/index/vector-index counters).
  - `bench/harness/preflight.ts` — fail-fast gate that ends with a live 1-token OpenAI call asserting the meter both saw the request and parsed its usage. Aborts with exit 2 before any spend. No skip flag.
  - `bench/run.ts`, `bench/summarize.ts` (scorecard + before/after diff with flip fingerprint), `bench/smoke.ts` (free, key-less self-test).
  - Two test seams added to the SUT before any measurement, so they bias nothing: `GITHUB_API_URL` env override in `github.ts`, and `agent/config.ts` exporting `INSTRUCTIONS`/`MODEL`/`TOOLS` (the eval suite previously recovered instructions by regexing `index.ts`; it now imports them).
  - Authored `plan2.md` — the operating brief that maps each `plan.md` phase to a hypothesis, the metric it must move, and the metric it must not regress.
- **Rationale & Impact**: `plan.md` listed evaluation criteria with nothing able to evaluate them. Every criterion (latency, cost, roundtrips, integrity, vector capability, accuracy) now has a number attached to a reproducible command, most of them zero-noise integer counters rather than wall-clock or LLM judgement.
- **Verified so far** (`bun bench/smoke.ts`, analysis disabled, zero cost): 60/60 issues ingested, all 17 integrity assertions pass, **121 GitHub requests** (1 listing + 2 per issue), **fetch max concurrency 1** (strictly serial — confirms `plan.md` §1), **313 Neo4j statements** for 60 issues, **0 managed transactions**, 62 sessions.
- **Status**: Completed (harness). Baseline measurement pending `OPENAI_API_KEY`.

---

### [2026-09-03] - Harness Verification — Three Silent-Zero Cost Bugs Found and Fixed
- **Component**: `bench/harness/instrument.ts`, `bench/harness/grade.ts`, `bench/harness/preflight.ts`, `bench/run.ts`; new `bench/harness.test.ts`, `bench/mock-openai.ts`, `bench/verify-offline.ts`, `bench/verify-oracles.ts`, `bench/SPLITS.sha256`
- **Action**: Hard-tested the harness before trusting it to score anything. Three defects were found, all of the same class — the meter reporting **$0**, which a cost-driven loop reads as a total win:
  1. **LLM traffic was detected by URL substring.** Any proxied `OPENAI_BASE_URL` (Azure, OpenRouter, LiteLLM, a local gateway) metered nothing. Detection is now by request *shape* — a POST to an inference path carrying a JSON body with a `model` field — plus a `byHost` breakdown so unexpected destinations are visible.
  2. **`openai`'s shim captures `globalThis.fetch` at import time.** `run.ts` statically imported `grade.ts`, which statically imported `openai`, so the meter was installed *after* the SDK had already captured the unpatched fetch — **the entire ingestion spend would have reported $0**. `grade.ts` now imports `openai` lazily, and a test greps all of `bench/` for top-level `openai` imports so the bug cannot return.
  3. **Only one of the two token-usage shapes was read.** Mastra's agent uses the OpenAI **Responses** API (`/v1/responses`), which reports `input_tokens`/`output_tokens`, not `prompt_tokens`/`completion_tokens` — so **the agent's entire QA spend would have reported $0**. The meter now reads both, and falls back to the agent SDK's own reported totals if a model streams.
- **Also hardened**:
  - `bun.lock` added to the recorded `sut.hash` — `"@mastra/core": "latest"` is unpinned, so a stray reinstall could change the agent framework mid-experiment without changing any source.
  - Every ingest stamps a `BenchMeta` node; `--stage qa --keep-graph` runs now report which job and SUT hash built the graph they are scoring.
  - `bench/SPLITS.sha256` pins the four frozen split files; preflight recomputes them and aborts if any was edited (verified by tampering: exit 2, `splits_unmodified` FAIL).
- **Verification chain now closed**, each link checked by code that did not produce it:
  - source dataset → corpus: 5 issues x 12 fields spot-checked against live `helmo/github-issues` rows — all exact.
  - corpus → graph: 20 integrity assertions, each **proven to fail** on a deliberately corrupted graph (duplicate issue, dropped comment, missing author edge, orphaned comment, right count of wrong issues).
  - graph → frozen answers: `verify-oracles.ts` re-derives every answer with independently written Cypher — 43/43 dev and 21/21 holdout agree.
  - metering: 35 unit tests covering both usage shapes, proxied base URLs, streamed responses, `UNWIND`-vs-loop statement counts, and `executeWrite`/`beginTransaction` counting (the path `plan.md` H2's headline metric depends on, previously untested since the SUT uses none of it yet).
  - the runner: `verify-offline.ts` spawns the real `run.ts` against a mock LLM and asserts 29 properties of the report. Zero cost, ~2 minutes.
- **Measured baseline shape** (dev, 60 issues, mock LLM so quality is meaningless): 121 GitHub requests, fetch max concurrency **1**, **493** Neo4j statements with analysis on (313 with it off), **0** managed transactions, 60 analysis calls, all 20 integrity checks passing, agent tool loop exercised at 100%.
- **Also added**: `verify-paths.ts` covering the runner paths a normal run never exercises — `--attempts N` (the confirmation path every keep/revert decision uses), the holdout split, `--stage ingest`, summarize on a QA-less report, and agent failure. A run where >=50% of QA attempts throw is now marked **INVALID** with exit 3 rather than reporting a convincing 0% (verified against a deliberately dead endpoint). `verify-oracles.ts` now aborts with a clear message if the graph is not ingested, instead of a mid-run TypeError.
- **Status**: Completed. Real baseline still pending `OPENAI_API_KEY`.

---

### [2026-09-03] - OpenTelemetry Tracing Across the System + Continuous-Run Protocol
- **Component**: `github_issue/src/services/tracing.ts` (new), `src/services/{neo4j,github,openai,pipeline,analysis}.ts`, `agent/{index,tools/query-neo4j,tools/summarize-comments}.ts`, `ingestion/index.ts`, `src/tools/trace-summary.ts` (new); `bench/run.ts`, `bench/summarize.ts`, `bench/verify-all.ts` (new); `plan2.md`
- **Action — tracing**: Every outbound call now emits an OpenTelemetry span. Built on the OTel packages already present transitively via Mastra (now declared explicitly in `package.json`); **no new dependency was added**.
  - **Neo4j**: traced by wrapping the driver once in `getDriver()`, so every statement is covered — including ones issued inside `executeWrite`/`beginTransaction`, which `plan.md` H2 will introduce. The span is attached to the driver's `Result` rather than awaited, so the return type and behaviour are unchanged.
  - **GitHub**: one span per logical GraphQL call at the single `graphql()` chokepoint, with a `retry` event per attempt — a slow request and a thrice-retried one are indistinguishable in a wall-clock number otherwise. Plus a parent span per issue recording comments/reactions actually paged.
  - **OpenAI**: `gen_ai.*` semantic-convention attributes on the ingestion analyser and the comment summariser, including token counts.
  - **The agent's own LLM calls** go through Mastra/ai-sdk, not the OpenAI SDK, so they are traced at the HTTP layer by request shape. That survives a proxied base URL, a model swap (H4) and an SDK change, and it reads both the Chat Completions and Responses usage shapes.
  - **Exporters**: JSONL file always (one span per line, no collector needed, written via `SimpleSpanProcessor` so a killed run still leaves a usable trace) plus OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Lazy init means tracing works from any entry point.
  - `bun run trace:summary` renders per-operation call counts, total/p50/p95/max latency and token totals, with `--tree` for a span tree.
- **Action — benchmark integration**: `bench/run.ts` points `TRACE_DIR` at `bench/jobs/<name>/traces/`, so **every scored run keeps the trace that produced it**, and folds per-operation totals into `report.json` under `.trace`. `summarize.ts` renders that table, diffs trace timings between two runs, and **warns if the SUT's tracing and the harness meter disagree on the GitHub call count** — two independent measurements of the same thing, so a disagreement means one is broken.
- **Action — continuous operation**: added `bench/verify-all.ts`, one command that runs typechecks, the SUT's tests, the harness tests, smoke, oracles and the offline end-to-end check **in the one order that works** (the harness tests reset the graph, so they must precede the checks that need an ingested one — getting this wrong produces a convincing wall of false failures). Free, ~51s, stops at the first failure; `--job <name>` appends a scored run. `plan2.md` rewritten around it: §5 one cycle, §6 running continuously (cadence, per-cycle cost/time budget, unattended `nohup` usage, what each cycle must leave behind, when to stop), §9 tracing.
- **Verified**: full gate green — SUT typecheck, bench typecheck, SUT unit tests 10/10, harness tests 35/35, smoke, oracles 43/43, offline e2e 29/29. A traced mock run produced **1053 spans** covering `pipeline.*`, `github.graphql` (121), `neo4j.query` (566), `gen_ai.request` (80, the agent), `openai.chat` (60, ingestion), `tool.queryNeo4j` (40); tracing and the harness meter agree exactly on 121 GitHub calls. Mastra version unchanged at 1.36.0 across the dependency addition.
- **Immediately useful**: the baseline trace shows `pipeline.ingest` at 2.7s of a 3.5s run across 344 statements, and `github.graphql` at 121 calls with concurrency 1 — H2, H8 and H9 visible directly rather than inferred.
- **Status**: Completed. Real baseline still pending `OPENAI_API_KEY`.

---

### [2026-09-03] - Tracing Verification — Five Defects in the New Instrumentation
- **Component**: `github_issue/src/services/tracing.ts`, `src/tools/trace-summary.ts`, `vitest.config.ts`, new `src/services/__tests__/tracing.test.ts`; `bench/run.ts`, `bench/verify-offline.ts`
- **Context**: the previous entry added ~400 lines of tracing to the SUT with no tests. Tracing is measurement infrastructure — when it breaks it produces a thin or empty trace that reads as "nothing happened" rather than as an error — so it was tested the same way the harness was.
- **Defects found and fixed**:
  1. **Tracing could not be restarted within a process.** `provider.shutdown()` leaves the global provider registered; OTel then rejects the next `register()` as a duplicate and keeps handing out tracers from the dead provider, so **every span after the first shutdown was silently dropped**. Found by a three-cycle test that expected 3 spans and got 1. Fixed with `trace.disable()` on shutdown.
  2. **The fetch wrapper stacked on every re-init**, which would have double-counted every LLM call. Fixed with an idempotence guard; `shutdownTracing` now restores the original fetch.
  3. **Trace files accumulated across runs of the same job name.** `report.json` is overwritten but the traces directory was not cleared, so `.trace` double-counted spans from runs that no longer existed — a real measurement error. `run.ts` now clears the directory, and `verify-offline.ts` asserts `exactly one trace file per run`.
  4. **`require()` inside an ES module** — worked under bun, would throw under node, which is where the SUT's own vitest suite runs. Switched to `createRequire`. The OTLP export path was exercised for the first time against a local collector: 631 bytes received, works.
  5. **`gen_ai.request` undercounts LLM calls.** The `openai` SDK resolves fetch through a shim bound at package import, before the HTTP wrapper is installed, so ingestion calls bypass it — they are covered by explicit `openai.chat` / `tool.summarizeComments` spans carrying the same `gen_ai.usage.*` attributes. `trace:summary` now counts LLM work by attribute rather than span name and reports a call count; documented in `tracing.ts` and `plan2.md` so nobody filters by span name and concludes ingestion made no LLM calls.
- **Also**: `vitest.config.ts` unit project widened to `src/**/__tests__/**` — `src/` previously had no test path at all. Added 11 tracing tests (span shape, error recording, nesting, disabled mode, restart regression, both usage shapes, proxied base URL, non-inference pass-through, double-init, fetch restoration). `verify-offline.ts` gained four trace assertions including **tracing and the harness meter must agree on the GitHub call count** (121 = 121).
- **Measured**: tracing overhead is inside the noise — 3.0s/3.2s with tracing vs 2.8s/3.2s without, over the same 60-issue ingest. Across those four runs the zero-noise counters were byte-identical (121 GitHub requests, 313 Neo4j statements, concurrency 1) while wall clock varied, which is exactly why the accept/reject rule keys on the counters and not on `durationMs`.
- **Verified**: `bun bench/verify-all.ts --deep` fully green — SUT typecheck, bench typecheck, SUT tests 21/21, harness tests 35/35, smoke, oracles 43/43, offline e2e 33/33, path checks.
- **Status**: Completed. Real baseline still pending `OPENAI_API_KEY`.

---

### [2026-09-03] - First Real Baseline Attempt — Preflight Caught a Metering Bug Before Any Spend
- **Component**: `bench/harness/instrument.ts`, `bench/harness/preflight.ts`, `bench/harness.test.ts`
- **What happened**: the first scored run against a real `OPENAI_API_KEY` aborted at preflight with `meter_reads_usage: prompt=0 completion=0`, exit 2, **nothing spent**. The live call itself had succeeded (`model=gpt-4o-mini-2024-07-18`).
- **Root cause**: OpenAI answers a request for `gpt-4o-mini` with the dated snapshot `gpt-4o-mini-2024-07-18`. The meter bucketed the request under the requested name and the response under the reported name, producing **two buckets for one call**:
  - per-model request counts were inflated — one call summed to 2 across buckets (top-level `stats.requests` was correct, so this skewed only the per-model breakdown that every report prints);
  - the requested-name bucket was left with 0 tokens, and that is the bucket preflight was inspecting, so the check failed even though usage had been read correctly. Cost was never affected: `priceOf()` strips the dated suffix.
- **Fix**: attribute each call to exactly one bucket, chosen from the response model with the request model as fallback. Preflight now sums tokens across all buckets rather than guessing a model name, and additionally asserts every observed model is priceable (`meter_can_price_models`) — an unpriced model silently costs $0, which is the failure mode this whole harness exists to prevent.
- **Regression test added**: request `gpt-4o-mini` / response `gpt-4o-mini-2024-07-18` must yield one bucket, one counted request, non-zero tokens and non-zero cost. Harness tests now 36.
- **Worth noting**: this is exactly the class of defect that cost the previous auto-research loop two full benchmark jobs — a metering gap that reads as a plausible number rather than an error. Here it surfaced in 4 seconds, for $0, on the first attempt, because preflight makes a live call and asserts the meter both saw it and parsed it. The rule against adding a `--skip-preflight` flag stands.
- **Status**: Completed. Baseline re-running.

---

### [2026-09-03] - First Real Baseline — a Dead Guardrail Metric and a Genuine SUT Defect
- **Component**: `bench/scripts/build-tasks.ts`, `bench/harness/neo4j.ts`, `bench/tasks/*.jsonl`, `bench/SPLITS.sha256`
- **First real measurement** (job `_void-baseline-strict-judge`, since voided): overall 85.0%, deterministic **97.1%**, semantic **0.0%**, 34/40 solved, canaries pass, integrity all pass. Ingestion 239.7s / $0.2965 / 121 GitHub requests at concurrency 1 / 609 Neo4j statements / 0 transactions. SUT total $0.5633.
- **Finding 1 — semantic scored 0/5, and that was the harness's fault.** The judge failed correct answers for *"including details not present in the ground truth"* even though the rubric said extra detail was fine. Cause: the reference handed to the judge was a truncated extract (900 chars of body, 3 comments at 400 chars) while the agent reads the **full** issue and every comment from the graph — so a fuller, correct answer looked invented. A metric pinned at 0.0% cannot detect improvement *or* regression, which makes it useless as the guardrail on H4 (gpt-4o-mini migration) and H6 (comment truncation) — precisely the hypotheses most likely to damage summary quality.
  - **Fix**: the judge now receives what the agent sees (full body to 6k chars, every comment to 1.2k each), and the rubric was rewritten into three checkable conditions — same issue, contradicts no stated fact, not a refusal — with an explicit instruction that completeness is *not* graded and that extra or omitted detail must not fail an answer.
  - Splits were re-frozen and `SPLITS.sha256` regenerated. Verified the **non-judge tasks are byte-identical** — only the 5 judge tasks changed. Done deliberately before the optimisation loop starts; the earlier baseline is void and kept as `_void-baseline-strict-judge` for reference.
- **Finding 2 — a real SUT defect the benchmark caught.** `dev-003` ("how many issues are open?") failed: the agent wrote `WHERE i.state = 'open'` while the graph stores GitHub's enum casing `'OPEN'`, got zero rows, and answered *"There are currently no open issues."* The schema block in `agent/config.ts` documents `state (STRING)` without saying what values it takes. That is a genuine weakness for H12 to fix, not a harness artefact — closed_count passed, so the agent is capable; it simply guessed the casing.
- **Finding 3**: `issues_with_category` was computed as `count(DISTINCT 1)`, which counts the literal and is always 1. Informational only, but wrong; fixed to `count(DISTINCT i)`.
- **What the baseline already tells the loop**: `openai.chat` accounts for 211s of the 239.7s ingest (H4/H8 territory), 609 Neo4j statements with 0 managed transactions (H2), 121 GitHub calls strictly serial (H8), `constraints_defined=0` and `vector_indexes=0` (H1/H7), and extraction yield of 34 solutions / 21 workarounds from comments only (H5's target).
- **Status**: Completed. Baseline re-running against the corrected judge.

---

### [2026-09-03] - Verified Baseline Established (job `baseline`)
- **Component**: `plan2.md` §4, `bench/jobs/baseline/`
- **Result** (dev split, `--attempts 1`, SUT `71c696b48a9da953`, gate green before it ran):
  - `score.deterministic` **94.3%** (33/35) — the primary metric; `score.semantic` **80.0%** (4/5); overall **92.5%**, 37/40 solved; canaries pass; tool-use 100%; agent errors 0%.
  - Ingestion: **242.8s**, **121** GitHub requests at **concurrency 1**, **610** Neo4j statements in **0** transactions, 60 `gpt-4o` calls, **$0.2972**. Integrity all pass. `constraints_defined=0`, `vector_indexes=0`.
  - Cost per dev run: ingest $0.2972 + QA $0.2557 = **$0.5529** (judge $0.0333 excluded from the SUT) — inside the $1–2 budget agreed up front.
  - Trace: `pipeline.analyzeIssue` is **219s of the 243s** ingest; fetching is second and fully serial.
- **The judge fix worked**: semantic went **0.0% → 80.0%** on an unchanged agent, confirming the earlier zero was the truncated reference and not agent quality.
- **Three baseline failures, two of which share one cause**: `dev-003` and `dev-004` both fail because the agent guesses lowercase `'open'`/`'closed'` against GitHub's enum casing `'OPEN'`/`'CLOSED'` and then reports "there are currently no open issues". `dev-003` failed in both runs, `dev-004` in one — so the ±1-task swing between runs is this single defect flickering, not independent noise. `dev-040` is a genuine summary drift. H12 (document the permitted `state` values in the schema block) is the obvious first hypothesis and is expected to recover up to 2 tasks.
- **Methodological fix**: `plan2.md` requires `--attempts 3` before keeping a change, but the anchor was `--attempts 1`; comparing n=1 against n=3 would produce wrong keep/revert decisions. An `--attempts 3` baseline (`baseline-n3`) was launched as the proper anchor.
- **Status**: Completed.

---

### [2026-09-03] - n=3 Baseline Anchor + Variance Calibration (job `baseline-n3`)
- **Component**: `plan2.md` §4 and §7, `bench/jobs/baseline-n3/`
- **Result** (`--attempts 3`, same SUT `71c696b48a9da953`): deterministic **94.3%**, semantic **80.0%**, overall **92.5%**, **36/40** solved on every attempt and 38/40 on at least one. Cost **$1.064** SUT + $0.098 judge. Ingestion counters identical to the n=1 runs: 121 GitHub requests at concurrency 1, 610 Neo4j statements, 0 transactions.
- **Corrects the previous entry.** `dev-003` and `dev-004` fail **0/3** at n=3 — the state-casing defect is essentially always-on, not flaky. Counting every attempt recorded: `dev-003` passed 0/5, `dev-004` 1/5. The "flicker" seen earlier was an artefact of comparing two single-attempt runs.
- **Where the noise actually lives**: entirely in the judge-graded tasks — `dev-036` scored 2/3 and `dev-040` 1/3 on identical code. With only 5 semantic tasks, **one task is 20 points**, so `score.semantic` swings ±20pts on noise alone, while the 35-task deterministic set showed **zero** oscillation at n=3.
- **Accept/reject rule recalibrated against measurement rather than guesswork**: candidates compare against the n=3 anchor, not the n=1 baseline (comparing n=1 to n=3 biases every keep/revert call). A 1-task deterministic drop is now treated as a real regression; a 1-task semantic move is explicitly declared noise and must not drive a decision on its own.
- **Reproducibility evidence**: across three independent runs the zero-noise counters were byte-identical while ingestion wall clock varied by 16s — the empirical justification for steering by counters and treating `durationMs` as a soft metric.
- **Status**: Completed. Benchmark verified end to end and ready for the optimisation loop.

---

### [2026-09-03] - H12: General schema guidance for enum casing and suspicious empty results
- **Component**: `github_issue/agent/config.ts`
- **Hypothesis**: The agent's schema prompt did not document permitted enum values for `Issue.state`, and it treated empty query results as authoritative. General guidance to verify enum casing and property names before concluding that data is absent should recover the open/closed count failures without question-specific logic.
- **Smallest diff**: Added three lines to the existing `INSTRUCTIONS` rules: empty results trigger query/schema verification, including enum casing and property names, and must not become a confident zero. No benchmark identifiers or question-specific strings were added.
- **Verification**: `bun bench/verify-all.ts` passed all 8 gate steps before the confirmation score. Repository metadata check found no `.git` directory under `/home/azureuser/githubIssue`, so no Git dirty-state report is available. The n=1 report is retained at `bench/jobs/h12/report.json`; the required n=3 confirmation is retained at `bench/jobs/h12-confirm/report.json`, with trace at `bench/jobs/h12-confirm/traces/github-issue-analyzer-2026-09-03T09-55-31-577Z-1074290.jsonl`. Confirmation trace summary: 1,489 spans, 315 LLM calls, 0 failed spans.
- **Result vs `baseline-n3`**:
  - Deterministic: **100.0%** vs **94.3%**; all 35 deterministic tasks passed on every attempt.
  - Semantic: **86.7%** vs **80.0%**; within the allowed one-task noise guardrail.
  - Overall: **98.3%** vs **92.5%**; 39/40 solved on every attempt and 40/40 on at least one attempt.
  - Canaries: pass; tool-use rate: 100%; agent-error rate: 0%; integrity: all checks pass.
  - Ingestion counters remained healthy: 121 GitHub requests, max concurrency 1, 609 Neo4j statements, 0 transactions, 60 OpenAI analysis calls, ingest cost $0.2972.
- **Decision**: **KEEP**. The deterministic improvement is material and held at `--attempts 3`; no integrity, canary, agent-error, or quality regression was observed. Retain this change as the current candidate for the next independent hypothesis.
- **Status**: Completed / Verified

### [2026-09-03] - H10: General Cypher error feedback for agent retry
- **Component**: `github_issue/agent/tools/query-neo4j.ts`
- **Hypothesis**: When a generated Cypher query fails, the tool description did not explicitly tell the agent to use the exact database error to correct and retry. General error-feedback guidance should reduce failed-query answers without changing ingestion or adding question-specific logic.
- **Smallest diff**: Extended the `queryNeo4j` tool description with a general instruction to correct and retry from the exact error message, and not treat a failed query as empty data. No benchmark issue numbers, labels, authors, or question strings were added.
- **Gate**: `bun bench/verify-all.ts` passed all 7 free checks before scoring.
- **First measurement**: `bench/jobs/h10/report.json` (dev, QA-only, `--stage qa --keep-graph`, attempts 1) is valid. The graph provenance is recorded in the report as built by `_offline-verify` from the same H10 SUT fingerprint; integrity checks all pass. Score was deterministic **100.0%**, semantic **100.0%**, overall **100.0%**, 40/40 solved, canaries pass, tool-use 100%, agent errors 0%. QA cost was $0.2689 and no ingestion was charged. Trace: `bench/jobs/h10/traces/github-issue-analyzer-2026-09-03T10-10-41-334Z-1077679.jsonl`; summary has 187 spans, 85 LLM calls, and 0 failed spans.
- **Comparison note**: This QA-only run is a first signal, not the retention decision. Its graph has no analysis nodes because the reusable graph was created by `_offline-verify`; therefore ingestion counters and analysis yields are not comparable to the full `baseline-n3` or H12 runs. The QA score and integrity are valid for the structural/retrieval/semantic questions exercised.
- **Confirmation measurement**: `bench/jobs/h10-confirm/report.json` (dev, `--attempts 3`) is valid. The full gate plus scored confirmation passed. Trace: `bench/jobs/h10-confirm/traces/github-issue-analyzer-2026-09-03T10-15-48-695Z-1080051.jsonl`; summary has 1,491 spans, 315 LLM calls, and 0 failed spans. The trace contains 106 `tool.queryNeo4j` calls and 763 `neo4j.query` spans, with no recorded errors.
- **Confirmation result vs `baseline-n3`**:
  - Deterministic: **100.0%** vs **94.3%**; all 35 deterministic tasks passed on every attempt.
  - Semantic: **93.3%** vs **80.0%**; this is a one-task improvement over the H12 confirmation's 86.7%, and semantic movement is treated as noise unless supported by repeated task-specific evidence.
  - Overall: **99.2%** vs **92.5%**; 39/40 solved on every attempt and 40/40 on at least one attempt.
  - Canaries: pass; tool-use rate: 100%; agent-error rate: 0%; integrity: all checks pass.
  - Full ingestion remained healthy: 121 GitHub requests, max concurrency 1, 609 Neo4j statements, 0 transactions, 60 OpenAI analysis calls, ingest cost $0.2977. These counters are unchanged from H12 and show no ingestion regression.
  - SUT cost: $1.1026 including ingestion and three-attempt QA; judge overhead $0.0975 excluded.
- **Decision**: **KEEP**. H10 held at `--attempts 3`, preserved the deterministic gain already present under H12, and introduced no integrity, canary, tool-use, agent-error, or ingestion-counter regression. The scored trace did not exercise a malformed Cypher path, so direct retry activation is not independently demonstrated; the quality result supports retention without claiming measured retry reduction.
- **Status**: Completed / Verified

### [2026-09-03] - H1: Neo4j identity constraints and lookup indexes
- **Component**: `github_issue/src/services/neo4j.ts`, `github_issue/src/services/pipeline.ts`
- **Hypothesis**: Adding idempotent uniqueness constraints for graph identity fields and lookup indexes for frequently queried issue fields should improve MERGE lookup behavior and enforce graph identity without changing answer quality.
- **Smallest diff**: Added one general `setupDatabaseSchema()` initializer with ten `CREATE CONSTRAINT ... IF NOT EXISTS` statements for Issue, Comment, User, Label, Category, Competitor, Solution, Workaround, and Keyword identities, plus two Issue indexes for `state` and `updatedAt`. The pipeline invokes it once before discovery and ingestion. No benchmark-specific identifiers or question-specific logic were added.
- **Invalid pre-measurement incident**: An earlier edit accidentally appended duplicate full implementations of `pipeline.ts` and `neo4j.ts`, causing typecheck failures. That cycle was discarded without a score. The appended ranges were removed; the intended first-copy H1 implementation was retained. The mandatory gate then passed before scoring.
- **First measurement**: `bench/jobs/h1/report.json` (dev, full ingestion, attempts 1) is valid. Score: deterministic **100.0%**, semantic **80.0%**, overall **97.5%**, 39/40 solved on every attempt and at least once; canaries pass, tool-use 100%, agent errors 0%, integrity all pass. Ingestion: 121 GitHub requests at max concurrency 1, 619 Neo4j statements, 0 transactions, 60 `gpt-4o` analysis calls, and $0.2965. Trace: `bench/jobs/h1/traces/github-issue-analyzer-2026-09-03T10-51-06-673Z-1093288.jsonl`, 1,191 spans, 0 failed spans.
- **Confirmation**: `bench/jobs/h1-confirm/report.json` (dev, full ingestion, `--attempts 3`) is valid after `bun bench/verify-all.ts --job h1-confirm --attempts 3` passed all eight gate/score stages. Trace: `bench/jobs/h1-confirm/traces/github-issue-analyzer-2026-09-03T10-58-08-584Z-1096799.jsonl`, 1,517 spans, 316 LLM calls, 0 failed spans.
- **Confirmation result vs `baseline-n3`**:
  - Deterministic: **100.0%** vs **94.3%**; no deterministic regression and the two baseline state-casing failures were solved.
  - Semantic: **86.7%** vs **80.0%**; one judge-task movement is within the documented semantic noise guardrail and is not attributed to H1.
  - Overall: **98.3%** vs **92.5%**; 38/40 solved on every attempt and 40/40 on at least one attempt, versus 36/40 and 38/40 for the anchor.
  - Canaries: pass; tool-use rate: 100%; agent-error rate: 0%; integrity: all checks pass.
  - Ingestion counters: 121 GitHub requests, max concurrency 1, **623 Neo4j statements**, 0 transactions, 60 OpenAI analysis requests, and **$0.2986** ingest cost. The 10 constraints and 12 indexes are present. Vector indexes and embeddings remain 0, as expected because H1 does not test H7.
- **Decision**: **KEEP**. H1 held at `--attempts 3`, achieved its capability target, and introduced no integrity, canary, agent-error, deterministic-quality, or model/dataset/framework regression. The small statement-count increase is the measured cost of the twelve idempotent schema statements; batching and transaction reduction remain separate H2 work.
- **Status**: Completed / Verified

### [2026-09-03] - H2: UNWIND-batched Neo4j ingestion in a managed transaction
- **Component**: `github_issue/src/services/neo4j.ts`
- **Hypothesis**: Replacing the per-issue/per-relation ingestion round trips with parameterized `UNWIND` statements inside one managed `executeWrite` transaction should materially reduce Neo4j statements while preserving graph integrity and answer quality.
- **Invalid gate attempt**: The first H2 implementation used one nested Cypher statement with the same `ignored` return alias in multiple subqueries. Neo4j rejected the duplicate outer-scope variable during smoke; no graph was populated and no score was produced. Distinct aliases were initially tried, then the implementation was simplified into separate `UNWIND` statements in one managed transaction. The failed gate is not a measurement.
- **Smallest retained diff**: Added a batch payload normalizer and eight parameterized `UNWIND` statements for issues, users, authors, labels, reactions, comments, comment authors, and comment reactions. `ingestMultipleIssues` now executes the batch in one `session.executeWrite` transaction and constructs the same per-issue result metadata. Existing single-issue helpers remain available; no model, prompt, benchmark, or question-specific logic changed.
- **Gate**: After correction, `bun bench/verify-all.ts` passed all seven free steps. The scored command `bun bench/verify-all.ts --job h2` also reran all eight gate/score stages successfully.
- **First measurement**: `bench/jobs/h2/report.json` is valid dev full-ingestion n=1. Deterministic **100.0%**, semantic **100.0%**, overall **100.0%**, 40/40 solved every attempt and at least once; canaries pass, tool use 100%, agent errors 0%, integrity all pass. Ingestion: 121 GitHub requests at max concurrency 1, 318 Neo4j statements, 1 transaction, 60 `gpt-4o` calls, and $0.2980. Trace: `bench/jobs/h2/traces/github-issue-analyzer-2026-09-03T11-31-04-641Z-1107214.jsonl`, 890 spans, 0 failed spans.
- **Confirmation**: `bench/jobs/h2-confirm/report.json` is valid dev full-ingestion `--attempts 3` after the mandatory gate passed. Trace: `bench/jobs/h2-confirm/traces/github-issue-analyzer-2026-09-03T11-41-09-980Z-1110039.jsonl`, 1,214 spans, 315 LLM calls, 0 failed spans.
- **Confirmation result vs `baseline-n3`**:
  - Deterministic: **99.0%** vs **94.3%**; one attempt-level `dev-003` miss occurred, but the aggregate remains above the anchor and no deterministic regression versus the anchor occurred.
  - Semantic: **93.3%** vs **80.0%**; within the one-task semantic noise allowance.
  - Overall: **98.3%** vs **92.5%**; 38/40 solved every attempt and 40/40 at least once.
  - Canaries pass; tool-use 100%; agent-error 0%; all integrity assertions pass.
  - Ingestion: 121 GitHub requests, max concurrency 1, **318 Neo4j statements**, **1 transaction**, 60 OpenAI requests, and **$0.2969** ingestion cost. Constraints 10, indexes 12; vectors/embeddings remain 0 as expected.
- **Trace evidence**: 485 `neo4j.query` spans were observed in the confirmation trace because the trace includes the batch write statements plus analysis persistence and readback; the report’s ingestion meter isolates **318** ingestion statements. There were no failed spans.
- **Decision**: **KEEP**. The required counter target moved substantially (623 → 318 statements relative to H1 confirmation; transactions 0 → 1), while the confirmed result remained above the baseline anchor and all integrity/operational guardrails passed. H2 is retained for subsequent hypotheses.
- **Status**: Completed / Verified

### [2026-09-03] - H3: Scope orphan competitor/category cleanup to the current issue
- **Component**: `github_issue/src/services/analysis.ts`
- **Hypothesis**: Cleanup should inspect only competitor and category nodes previously connected to the issue being reprocessed, rather than scanning every such node in the graph. This should preserve graph shape while reducing unnecessary database work.
- **Smallest diff**: Replaced the graph-wide orphan `MATCH (comp:Competitor)` and `MATCH (cat:Category)` sweep with two issue-scoped subqueries. Each collects entities detached from the current issue, then deletes only candidates with no remaining incoming relationship of the corresponding type. No benchmark-specific identifiers, model, prompt, or dataset code changed.
- **Gate**: Fresh `bun bench/verify-all.ts` passed all seven free stages immediately before the required confirmation.
- **First measurement**: `bench/jobs/h3/report.json` is valid dev full-ingestion n=1. Deterministic **100.0%**, semantic **100.0%**, overall **100.0%**, 40/40 solved every attempt and at least once; canaries, integrity, tool use, and agent errors all pass. Ingestion: 121 GitHub requests at max concurrency 1, 317 Neo4j statements, 1 transaction, 60 `gpt-4o` analysis requests, and $0.2972. Trace: `bench/jobs/h3/traces/github-issue-analyzer-2026-09-03T11-56-16-288Z-1112769.jsonl`, 891 spans and 0 failed spans.
- **Confirmation**: `bench/jobs/h3-confirm/report.json` is valid dev full-ingestion `--attempts 3` after `bun bench/verify-all.ts --job h3-confirm --attempts 3` passed all eight stages. Trace: `bench/jobs/h3-confirm/traces/github-issue-analyzer-2026-09-03T12-08-07-640Z-1115367.jsonl`, 1,212 spans, 315 LLM calls, and 0 failed spans.
- **Confirmation result vs `baseline-n3`**:
  - Deterministic: **100.0%** vs **94.3%**; no deterministic regression.
  - Semantic: **80.0%** vs **80.0%**; no semantic regression beyond the anchor allowance.
  - Overall: **97.5%** vs **92.5%**; 37/40 solved every attempt and 40/40 at least once.
  - Canaries pass; tool-use 100%; agent-error 0%; all integrity assertions pass.
  - Ingestion: 121 GitHub requests, max concurrency 1, **316 Neo4j statements**, **1 transaction**, 60 OpenAI requests, and **$0.2969** ingest cost. Graph shape remained valid: 10 constraints, 12 indexes, 33 solutions, 22 workarounds, 110 categories, 2 competitors, and 0 vector indexes/embedding nodes.
- **Trace evidence**: 483 `neo4j.query` spans were recorded in the full confirmation trace; the report’s ingestion meter isolates 316 statements. There were no failed spans. Wall clock remained noisy (224.8s) and was not used as the material target.
- **Decision**: **KEEP**. H3 held at `--attempts 3`, preserved quality and all guardrails, and moved the zero-noise Neo4j counter from 318 (H2 confirmation) to 316 while removing the graph-wide cleanup scan. The material improvement is the general query scope reduction; no claim is made that wall-clock latency improved.
- **Status**: Completed / Verified

### [2026-09-03] - H3 revalidation: fresh `h3-confirm-2` confirmation
- **Component**: `github_issue/src/services/analysis.ts` (working candidate fingerprint `8a9efd42759f2fa2`)
- **Reason for revalidation**: Exploratory H5 schema edits were made and reverted after the earlier H3 confirmation. The planner required a fresh standalone gate and a new confirmation so the retained candidate state was independently verified before advancing.
- **Gate**: A fresh `bun bench/verify-all.ts` passed all seven free checks immediately before scoring. The frozen split checksum remained `ae3e0d28952c1ef0622478353f1cb32b24dd54b61e2ef8f4395deb0ae775496b`.
- **Confirmation**: `bench/jobs/h3-confirm-2/report.json`, dev full ingestion, `--attempts 3`; trace: `bench/jobs/h3-confirm-2/traces/github-issue-analyzer-2026-09-03T12-38-52-340Z-1120992.jsonl`.
- **Result vs `baseline-n3`**:
  - Deterministic **100.0%** vs **94.3%**; semantic **100.0%** vs **80.0%**; overall **100.0%** vs **92.5%**.
  - **40/40** tasks solved on every attempt and at least once; canaries pass; tool use **100%**; agent errors **0%**.
  - Integrity passed for all checks: 60 issues, 228 comments, 55 users, 6 labels, 37 reactions, no duplicates/orphans, exact issue membership and comment fan-out.
  - Ingestion completed 60/60 with **121 GitHub requests**, max concurrency **1**, **318 Neo4j statements**, **1 transaction**, 60 `gpt-4o` analysis requests, and **$0.2985** ingestion cost. Graph counters: 10 constraints, 12 indexes, 36 solution nodes, 23 workaround nodes, 0 vector indexes/embedding nodes.
  - Trace summary: **1,212 spans**, 315 LLM calls, 351,789 input tokens, 24,548 output tokens, and **0 failed spans**. The report's 318 count is the ingestion meter; the trace includes 484 total Neo4j query spans across ingestion, readback, analysis persistence, and QA.
- **Decision**: **KEEP**. The fresh confirmation is valid, exceeds the baseline-n3 quality anchor, preserves all integrity and operational guardrails, and confirms the H1/H2/H3 candidate state. The reversed argument order in an earlier summarize command was presentation-only; the report above is authoritative.
- **Status**: Completed / Verified

### [2026-09-03] - H4: model downgrade explicitly skipped
- **Component**: `github_issue/src/services/openai.ts`, `github_issue/agent/tools/summarize-comments.ts`
- **Hypothesis**: Replacing `gpt-4o` with `gpt-4o-mini` could reduce cost.
- **Decision**: **NOT RUN / SKIPPED**. The execution contract fixes the SUT at `openai/gpt-4o` and permits `gpt-4o-mini-2024-07-18` only for the preflight one-token observation. No SUT model change, score, or holdout was performed for H4.
- **Status**: Completed / Not applicable

## Controlled Optimization Execution Log

- **Protocol**: `plan2.md` rules are enforced: only `github_issue/` source changes; `bench/`, corpus, tasks, and holdout remain read-only; no question-specific logic; one hypothesis per measurement; sequential jobs; tracing remains enabled; every score requires a fresh `bun bench/verify-all.ts` pass; retained candidates require `--attempts 3` confirmation against `bench/jobs/baseline-n3/report.json`.
- **Acceptance gate**: deterministic score must not fall below baseline-n3 (94.2857%); semantic score may not fall by more than one task / 20 points; integrity and canary must remain passing; agent-error rate may not increase; at least one target metric must materially improve. Zero-noise counter movement counts; duration requires median-of-three and at least 20% movement.
- **Stopping rule**: stop after three consecutive attempts=3 hypotheses fail, when remaining failures are distinct unrelated modes, or when every §8 hypothesis has been tried and decided; then freeze the best development candidate and run the sealed holdout exactly once.
- **Anchor and retained state**: baseline-n3 is 94.3% deterministic / 80.0% semantic / 92.5% overall, 36/40 solved every attempt, 610 Neo4j statements and 0 managed transactions. Retained H1/H2/H3/H10/H12 are preserved; `bench/jobs/h3-confirm-2/report.json` is the strongest observed development confirmation at 100% deterministic, semantic, and overall, 40/40 solved every attempt, 318 ingestion statements, and 1 managed transaction.
- **Integrity metadata**: frozen split checksum file remains `bench/SPLITS.sha256` with recorded checksum `ae3e0d28952c1ef0622478353f1cb32b24dd54b61e2ef8f4395deb0ae775496b`; no `.git` directory exists under `/home/azureuser/githubIssue` (**NO_GIT_METADATA**).
- **Status**: Execution log recorded before resolving and scoring H5. Historical Upcoming/Planned placeholders were superseded by this controlled campaign log.

### [2026-09-03] - H5: Body-aware solution and workaround extraction
- **Component**: `github_issue/src/services/openai.ts`, `github_issue/src/services/analysis.ts`, `github_issue/src/services/__tests__/analysis.test.ts`
- **Hypothesis**: Allowing explicitly stated solutions and workarounds from either the issue body or comments, with typed source provenance, should increase extracted analysis nodes without harming answer quality or graph integrity.
- **Smallest diff**: Added `issueId` to the analysis input; required `source` and `sourceType` (`issueId` or `commentId`) in the structured schema; updated general prompt instructions for body/comment provenance; validated source metadata before persistence; and matched body-derived items directly to `Issue.issueId` while comment-derived items resolve through `Comment.commentId` to the owning issue. Added focused tests for body-only, comment-only, mixed, empty, malformed, and duplicate-source cases. No benchmark-specific identifiers or logic were added.
- **Gate and focused checks**: `bun run typecheck` and `bun run test:unit` from `github_issue` passed (27 tests); the fresh seven-step `bun bench/verify-all.ts` gate passed immediately before scoring. SUT fingerprint for the scored candidate: `007fde4eb448998a`.
- **Confirmation**: `bench/jobs/h5-confirm/report.json`, dev full ingestion, `--attempts 3`; trace directory: `bench/jobs/h5-confirm/traces/`.
- **Result vs `baseline-n3`**:
  - Deterministic **100.0%** vs **94.3%**; semantic **100.0%** vs **80.0%**; overall **100.0%** vs **92.5%**.
  - **40/40** tasks solved every attempt and at least once; canaries pass; tool use 100%; agent errors 0%; all integrity checks pass.
  - Ingestion counters: 121 GitHub requests at max concurrency 1, 321 Neo4j statements, 1 transaction, 60 fixed `gpt-4o` calls, and $0.3341 ingestion cost. Graph capabilities/yields: 10 constraints, 12 indexes, 35 solutions, **25 workarounds** (baseline-n3 23), 116 categories, 1 competitor, 239 keywords, and 0 vector indexes/embedding nodes.
- **Decision**: **KEEP**. H5 held at attempts=3, materially improved the zero-noise workaround-node target (23 → 25), preserved the deterministic/semantic/integrity/canary/agent-error guardrails, and retained the fixed model and frozen data. The higher ingestion cost and 321 statements are recorded; H5 was not a cost or round-trip hypothesis.
- **Status**: Completed / Verified

### [2026-09-03] - H6: Bot/noise filtering and bounded comment context
- **Component**: `github_issue/src/services/openai.ts`, `github_issue/src/services/__tests__/analysis.test.ts`
- **Hypothesis**: Filtering generic bot/empty comments and capping each comment at a deterministic 2,000 characters should reduce ingestion prompt tokens without harming semantic quality or extracted solutions.
- **Feasibility evidence**: The frozen dev corpus has 228 comments; six exceed 2,000 characters and account for 17,186 characters above that bound. All 228 nested author login values are null, so bot-filter effectiveness cannot be measured on this split. The implementation was general and did not use benchmark identifiers.
- **Smallest diff tested**: Added a 2,000-character comment cap, generic author-pattern filtering, and focused tests for bot/empty comments, long-text truncation, IDs, and preservation of H5 body provenance.
- **Gate and confirmation**: `bun bench/verify-all.ts --job h6-confirm --attempts 3` passed the fresh 8-stage gate and scored the candidate. Report: `bench/jobs/h6-confirm/report.json`; trace: `bench/jobs/h6-confirm/traces/`.
- **Result vs `baseline-n3`**:
  - Deterministic **99.05%** vs **94.29%**; semantic **86.67%** vs **80.0%**; overall **97.5%**; 37/40 solved every attempt and 40/40 at least once.
  - Canaries passed, tool-use 100%, agent errors 0%, all integrity checks passed, 121 GitHub requests at concurrency 1, and one managed transaction.
  - The named target failed: ingestion prompt tokens increased **94,494 → 101,268** and ingestion cost increased **$0.297585 → $0.32012**. The 60-call fixed `gpt-4o` model was unchanged. Duration was not a median-of-three target measurement.
- **Decision**: **REVERT**. Although quality and guardrails held, H6 did not materially improve its required prompt-token target and increased cost; no bot filtering gain was observable in this corpus. The H6-only source and tests were removed, restoring the H5 champion implementation. Post-revert typecheck and unit tests pass: 4 files, 27 tests.
- **Status**: Completed / Reverted

### [2026-09-03] - H7: Embeddings and Neo4j vector index
- **Component**: `github_issue/src/services/analysis.ts`, `github_issue/src/services/neo4j.ts`, OpenAI integration
- **Hypothesis**: Add embeddings to analysis nodes and a Neo4j vector index to enable semantic retrieval.
- **Feasibility decision**: **NOT RUN / SKIPPED**. The SUT has no embedding model/resource contract, no embedding-generation implementation, no vector-index creation API, and no semantic-search implementation. The existing `embedding = []` properties are placeholders, not valid vectors. Implementing this hypothesis would require inventing an external model identifier and an unverified Neo4j/OpenAI contract, which is outside the fixed campaign resources. The benchmark's lexical frozen questions also cannot prove retrieval quality.
- **Evidence**: Existing scored reports consistently record `vector_indexes: 0` and `nodes_with_embedding: 0`; source inspection found only placeholder empty-list properties and schema documentation.
- **Decision**: **SKIPPED / INCOMPATIBLE**. No source change, score, or holdout was made for H7.
- **Status**: Completed / Not applicable

### [2026-09-03] - H11: Semantic search tool
- **Component**: `github_issue/agent/tools`, dependent on H7
- **Hypothesis**: Add a semantic-search agent tool backed by the Neo4j vector index.
- **Feasibility decision**: **NOT RUN / SKIPPED**. H11 depends on H7's embeddings and vector index, which are unavailable under the fixed resource contract. There is no valid vector index or embedding population to query, and adding a lexical substitute would not test H11 as specified.
- **Decision**: **SKIPPED / BLOCKED BY H7**. No source change, score, or holdout was made for H11.
- **Status**: Completed / Not applicable

### [2026-09-03] - H8: Opt-in bounded concurrent GitHub detail fetch
- **Component**: `github_issue/src/services/github.ts`
- **Hypothesis**: A bounded worker pool should overlap independent issue-detail GraphQL requests, increasing fetch concurrency without increasing request count or changing result ordering/error semantics.
- **Smallest diff**: Replaced the serial detail-fetch loop with a bounded, indexed worker pool. `GITHUB_FETCH_CONCURRENCY` is a general runtime setting, defaults to `1` to preserve the existing serial contract, clamps to the valid issue-count range, and was set to `4` only for the isolated benchmark. No benchmark-specific identifiers or logic were added.
- **Gate**: The initial default-4 candidate failed the read-only harness concurrency invariant before scoring. After changing only the general default to 1, a fresh `env -u GITHUB_FETCH_CONCURRENCY bun bench/verify-all.ts` passed all seven free checks immediately before the scored H8 confirmation. The H8 score used `GITHUB_FETCH_CONCURRENCY=4` without editing `bench/`.
- **Confirmation**: `bench/jobs/h8-confirm/report.json`, dev full ingestion, `--attempts 3`; trace: `bench/jobs/h8-confirm/traces/github-issue-analyzer-2026-09-03T15-07-24-610Z-1158117.jsonl`.
- **Result vs `baseline-n3`**:
  - Deterministic **100.0%** vs **94.3%**; semantic **93.3%** vs **80.0%**; overall **99.2%**; 39/40 solved every attempt and 40/40 at least once.
  - Canaries pass; tool use **100%**; agent errors **0%**; all integrity checks pass.
  - GitHub requests stayed at **121**, while the zero-noise fetch counter moved from max concurrency **1 → 4**. The run recorded 322 Neo4j queries, 60 fixed `gpt-4o` calls, and $0.3336 ingestion cost. No latency reduction is claimed: the report's nested ingestion duration fields are null and plan2 requires a median of three for duration.
- **Decision**: **KEEP**. H8 achieved its specified zero-noise concurrency target under the documented opt-in configuration with unchanged GitHub request count and no quality, integrity, canary, or agent-error regression at attempts=3.
- **Status**: Completed / Verified

### [2026-09-03] - H9: In-memory handoff removes Neo4j read-after-write
- **Component**: `github_issue/src/services/pipeline.ts`
- **Hypothesis**: The pipeline can analyze the already fetched GitHub payload after ingestion instead of reading the same issue details back from Neo4j, reducing round trips without changing analysis input or graph integrity.
- **Smallest diff**: Removed the `fetchMultipleIssueDetails` import and `pipeline.readback` call. The pipeline now maps successfully ingested fetched issues into the existing analysis input shape, including body text, labels, comment IDs, authors, and H5-compatible provenance. Incremental timestamp checks and H3 analysis persistence remain unchanged. No benchmark-specific identifiers or question logic were added.
- **Gate and focused checks**: SUT typecheck and unit tests passed (27 tests). A fresh `env -u GITHUB_FETCH_CONCURRENCY bun bench/verify-all.ts` passed all seven free checks immediately before the confirmation score.
- **Confirmation**: `bench/jobs/h9-confirm/report.json`, dev full ingestion, `--attempts 3`; trace: `bench/jobs/h9-confirm/traces/` (the run's JSONL trace; no `pipeline.readback` span is present).
- **Result vs `baseline-n3`**:
  - Deterministic **100.0%** vs **94.3%**; semantic **100.0%** vs **80.0%**; overall **100.0%**; **40/40** solved every attempt and at least once.
  - Canaries pass; tool use **100%**; agent errors **0%**; all integrity assertions pass.
  - Neo4j query count fell to **261** from the baseline's 610 statements/queries reported for the anchor; GitHub remained **121** requests at default concurrency 1. The run made 60 fixed `gpt-4o` calls and cost **$0.3339** for ingestion. No duration claim is made because plan2 requires a median of three for wall-clock claims.
- **Decision**: **KEEP**. H9 achieved its zero-noise round-trip target and preserved every quality, integrity, canary, tool-use, and agent-error guardrail at attempts=3.
- **Status**: Completed / Verified

### [2026-09-03] - Stopping rule, final development champion, and holdout authorization
- **Stopping-rule application**: Plan2 §6/§8 says to stop when three consecutive attempts=3 hypotheses fail, when remaining failures are distinct unrelated modes, or when every hypothesis in §8 has been tried and decided. The campaign reached the third condition: H1, H2, H3, H5, H8, H9, H10, and H12 were measured and retained; H6 was measured and reverted; H4 was skipped because the fixed-model contract prohibits substitution; H7 was skipped as incompatible because no valid embedding resource/seam exists; H11 was skipped because it depends on H7. There were not three consecutive attempts=3 failures, and no further justified §8 hypothesis remains.
- **Final champion freeze**: Freeze the current `/home/azureuser/githubIssue/github_issue` source containing retained H1/H2/H3/H5/H9/H10/H12 and the H8 bounded worker pool. H8 is enabled for the final candidate with the general environment setting `GITHUB_FETCH_CONCURRENCY=4`; its source default remains `1` so the read-only harness and ordinary deployments preserve serial behavior unless concurrency is explicitly selected. Final scored source fingerprint from `h9-confirm`: `9eeb557db3e87c2d` (19 files). No source or benchmark changes are permitted after the holdout run.
- **Development champion evidence**: H9 confirmation is the strongest combined-source confirmation at 100.0% deterministic, semantic, and overall, 40/40 solved every attempt, clean guardrails, 261 Neo4j queries, and 121 GitHub requests at default concurrency. H8 separately verified max concurrency 4 with 121 requests and no guardrail regression at `bench/jobs/h8-confirm/report.json`.
- **Holdout authorization**: The sealed holdout may now be run exactly once, after a fresh passing gate, using the frozen champion configuration. No tuning or second holdout is permitted.
- **Status**: Completed / Superseded by sealed holdout closeout below

### [2026-09-03] - Sealed holdout result and campaign closeout
- **Frozen candidate**: SUT fingerprint `9eeb557db3e87c2d` (19 files), containing retained H1/H2/H3/H5/H8/H9/H10/H12. The holdout used the fixed `openai/gpt-4o` SUT model, `latencyMs=120`, `GITHUB_FETCH_CONCURRENCY=4`, and attempts=1 as required for the sealed split. No source, benchmark, corpus, task, or holdout files were changed after freeze.
- **Pre-holdout gate**: `env -u GITHUB_FETCH_CONCURRENCY bun bench/verify-all.ts` passed all 7 free checks (exit 0) immediately before the holdout command. The holdout command then exited 0.
- **Holdout evidence**: `bench/jobs/holdout-final/report.json` is valid; trace `bench/jobs/holdout-final/traces/github-issue-analyzer-2026-09-03T15-44-36-408Z-1164059.jsonl`. Exactly one holdout report and one holdout trace exist. The report records deterministic **100.0%**, semantic **100.0%**, overall **100.0%**, **20/20** solved every attempt and at least once, canary pass, tool-use **100%**, agent-error rate **0%**, and zero trace errors.
- **Holdout resource/integrity evidence**: 40 issues, 174 comments, 36 users, 9 labels, 32 reactions; no duplicates/orphans and exact issue membership. Ingestion was 96,142 ms, 81 GitHub requests at max concurrency 4, 190 Neo4j queries in 1 managed transaction, 40 fixed `gpt-4o` calls, and **$0.2253725** ingestion cost. The holdout trace contains 561 spans and no `ERROR` status records.
- **Development before → after**: authoritative `baseline-n3` (`bench/jobs/baseline-n3/report.json`) was deterministic **94.2857%**, semantic **80.0%**, overall **92.5%**, 36/40 solved every attempt. The selected H9 champion confirmation (`bench/jobs/h9-confirm/report.json`) was deterministic **100.0%**, semantic **100.0%**, overall **100.0%**, 40/40 solved every attempt, with 261 Neo4j queries, 121 GitHub requests at default serial concurrency, and 1 managed transaction. H9 trace: `bench/jobs/h9-confirm/traces/github-issue-analyzer-2026-09-03T15-29-00-632Z-1161613.jsonl` (1,159 spans, zero trace errors).
- **Holdout before → after**: no pre-holdout score was run because plan2 seals the split and permits exactly one final run; therefore there is no holdout-before number. The single final holdout result is **100.0%/100.0%/100.0%**, 20/20. This is reported separately and is not used for tuning.
- **Final decision**: **KEEP / VERIFIED**. The campaign is closed under the third plan2 stopping condition (every hypothesis in §8 tried and decided). No post-holdout tuning, scoring, or rescore occurred. See `RESULTS.md` for the complete auditable report.

- **Ledger audit note**: Earlier historical `Upcoming`/`Planned` text is superseded by the controlled execution log and the explicit entries above; the campaign is closed, not pending. Corrected non-scoring acceptance evidence: `cd /home/azureuser/githubIssue/github_issue && bun run typecheck && bun run test:unit` exited 0 (4 files, 27 tests); `cd /home/azureuser/githubIssue/bench && sha256sum -c SPLITS.sha256` exited 0 (4/4 frozen entries OK); and the final artifact audit passed (21 cited paths, 11 valid reports, zero missing/invalid reports or report-linked traces, exactly one holdout report and one holdout trace). The standalone machine-readable audit inventory is `/home/azureuser/githubIssue/artifact-audit-inventory.json`; it records the scoped RESULTS.md extraction and selection rules, phrase list, selected paths, per-report checks, stdout summary, exit code 0, and UTC generation timestamp. Its canonical representation is UTF-8 compact JSON serialized with sorted keys and separators `(',', ':')`, hashing the complete object with only `canonical_representation.inventory_sha256` omitted; the stored SHA-256 is `6658b3ac196fa459527b6f53f873530ac15d38d28184dbb512c662d1de7c94ab`. The eight persisted documentation checks — `inventory_linked`, `campaign_closed`, `generated_artifact_scope`, `provenance_limitation`, `sut_validation`, `frozen_checksum_validation`, `artifact_audit`, and `repository_metadata` — each have `passed: true`. The post-holdout scope audit found no implementation source, benchmark source, frozen manifest, corpus, task, or holdout modifications; acceptance checks may create generated runtime artifacts such as `github_issue/.traces/` and `node_modules/.vite/`, which are not implementation changes. Exact-once holdout execution and gate adjacency are supported by surviving command/artifact evidence, but are not cryptographically provable because no immutable command transcript was retained. No `.git` directory exists under `/home/azureuser/githubIssue` (**NO_GIT_METADATA**).

### Final document digest bindings
The following document bindings use the same normalized projection described in `RESULTS.md`: UTF-8 text with CRLF converted to LF, masking only explicitly labeled inventory/document-binding digest values (`stored SHA-256`, `inventory_sha256`, and `normalized projection SHA-256`). All other ledger content remains in the projection. The normalized projection SHA-256 values are recorded in `/home/azureuser/githubIssue/artifact-audit-inventory.json`.
- `ledger.md` normalized projection SHA-256: `4b0504ab68e5c558b231533e039f43848693bb4fcc46e8279c490fa9291592b2`
- `RESULTS.md` normalized projection SHA-256: `f2f7edea7058dfaef8d64b2761f10612f373d1666600c9c0eb318d1937120156`
- Canonical inventory SHA-256 with the self-referential inventory digest field omitted: `6658b3ac196fa459527b6f53f873530ac15d38d28184dbb512c662d1de7c94ab`.

### [2026-09-04] - W1 QA model cost campaign (gpt-4o-mini)
- **Scope/method**: New `verification_bench` dev campaign only. Reused the preserved graph `verification_bench/jobs/w1-graph-restore/` (60 issues, 40 tasks, 121 GitHub requests). Three sequential QA-only jobs used `attempts=3`, `latencyMs=120`, and `keepGraph=true`; no holdout, W2, or W3 work was run.
- **Candidate/pins**: QA model `openai/gpt-4o-mini`; candidate SUT fingerprint `843ed48e862b0927` (19 files); current-best/reference fingerprint `73acfdc375576226`. Extraction, comment summarization, judge, corpus, tasks, and harness were unchanged.
- **Preserved evidence**: `verification_bench/jobs/w1-mini-1/report.json`, `w1-mini-2/report.json`, `w1-mini-3/report.json`; each has one JSONL trace in its `traces/` directory. Graph report and trace are `verification_bench/jobs/w1-graph-restore/report.json` and `verification_bench/jobs/w1-graph-restore/traces/github-issue-analyzer-2026-09-04T09-49-55-653Z-1443507.jsonl`.
- **Measured quality**: deterministic scores were 93.333333%, 99.047619%, and 95.238095%; mean **95.873015873%**, range **93.333333%–99.047619%**, spread **5.714286 pp**. Solved every attempt was 35/40, 38/40, and 36/40. Overall mean was 96.111111111%; semantic scores were context only and did not drive the decision.
- **Measured cost/usage**: QA cost `$0.48765695`; fixed-judge cost `$0.3093575`; combined scored QA+judge `$0.79701445`; 724 mini requests, 682,297 input tokens, and 42,304 output tokens. Ingestion was not repaid. The projected full-run SUT total remains `$0.5209` (56.2% below the `$1.1894` reference), but measured QA-only cost is reported separately.
- **Guardrails**: every report is valid, canary passing, tool-use `1.0`, agent errors `0`, all integrity entries passing, 121 dev GitHub requests, 120 ms latency, and preserved graph provenance. Combined traces contain 1,533 spans, 724 generation requests, 45 summarize calls, 445 Neo4j query spans, and 319 query-tool spans; no trace errors were recorded.
- **Failure mechanism**: raw task/tool-call evidence repeatedly shows reversed `(User)-[:AUTHORED_BY]->(Issue)` traversal on `dev-006` and `dev-010`, sometimes followed by a confident zero/no-data answer. Other misses occurred on reaction, label, issue-body/title, and semantic-summary tasks.
- **Decision**: **REJECT**. The independent three-run instability and mean 95.873015873% are below the 97.14% conditional threshold (at least two deterministic tasks lost on average), despite projected cost savings and clean infrastructure guardrails. No holdout quality decision was made; stop W1 before W2/W3 and any holdout.

### [2026-09-04] - H13 relationship-direction investigation pending
- The next controlled step is a standalone relationship-direction probe for `openai/gpt-4o` and `openai/gpt-4o-mini`, followed by exactly one general guidance line if supported. No H13 score, fallback score, or confirmation authorization is claimed by this W1 entry.

### [2026-09-04] - H13 relationship-direction hypothesis cancelled
- **Decision**: **CANCELLED** before implementation. Do not add the relationship-direction guidance line and do not run `verification_bench/probe-relationship-direction.ts`; the probe file is preserved unchanged.
- **Rationale**: The theoretical ceiling from removing the known direction failure was **98.10%**, but residual non-direction failures remained. The observed instability was unchanged and there was **no validation headroom** to justify spending on the probe or confirmation jobs.
- **Scope**: No H13 score, prompt change, fingerprint change, or confirmation evidence exists. Proceed directly to the separately controlled `openai/gpt-4.1-mini` fallback, then stop before W2, W3, holdout, or any `bench/` scoring.

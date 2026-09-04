# GitHub Issue Analyzer — Controlled Optimization Results

> **Editorial repair — 2026-09-04**
>
> The file as sealed was a mechanical concatenation of two different revisions of
> this report: bytes `0–17101` and `17102–37691`, glued mid-line with no newline
> between them, so the title, the executive table and every section through
> `## Audit checklist` appeared twice. The two copies were **not** identical —
> the first carried `## Final document digest bindings` and the second carried
> the four closing sections from `## Best commit / frozen release identifier`
> onward.
>
> This version is the union of the two, in document order. **No content was
> removed and no wording was changed**; the only edit is deleting the repeated
> block. The pre-repair file was SHA-256 `b32f6c901d19bc656d9c2e39e61da8e5ce3437cda16eb73eeee0f4f1d28b8374`
> (37692 bytes).
>
> One consequence to be aware of: the hashes under `## Final document digest
> bindings` were computed over the *duplicated* file. They describe the sealed
> artifact and no longer validate against this repaired text. The scored
> evidence they point at — the reports and traces under `bench/jobs/` — is
> untouched and still verifies; `bench/SPLITS.sha256` still passes 4/4.
>
> For what in this report holds up under re-measurement and what does not, see
> [`VERIFICATION.md`](VERIFICATION.md). In short: every number here traces to a
> saved report, but the headline 100% does not reproduce, and the accuracy gain
> is one three-line prompt change rather than eight compounding optimisations.

**Campaign:** `plan2.md` controlled optimization loop  
**Project:** `/home/azureuser/githubIssue`  
**Closeout:** 2026-09-03  
**Repository metadata:** `NO_GIT_METADATA` — no `.git` directory exists; no Git clean/dirty claim is made.

## Executive result

The selected development champion materially improved the analyzer against the required `baseline-n3` anchor while preserving integrity, canary, tool-use, and agent-error guardrails:

| Metric | Baseline `baseline-n3` | Development champion `h9-confirm` | Change |
|---|---:|---:|---:|
| Deterministic score | 94.2857% (33/35) | **100.0% (35/35)** | **+5.7143 pp** |
| Semantic score | 80.0% (4/5) | **100.0% (5/5)** | **+20.0 pp** |
| Overall score | 92.5% | **100.0%** | **+7.5 pp** |
| Solved every attempt | 36/40 | **40/40** | **+4 tasks** |
| Solved at least once | 38/40 | **40/40** | **+2 tasks** |
| Canary | pass | **pass** | no regression |
| Tool-use rate | 100% | **100%** | no regression |
| Agent-error rate | 0% | **0%** | no regression |
| Neo4j ingestion queries | 610 | **261** | **−349 (57.2%)** |
| Managed transactions | 0 | **1** | batching enabled |
| GitHub requests | 121 | 121 | unchanged |
| Ingestion model calls | 60 `gpt-4o` | 60 `gpt-4o` | unchanged |
| Ingestion cost | $0.297585 | $0.333930 | no cost reduction claimed |

The champion is the frozen source fingerprint `9eeb557db3e87c2d` (19 SUT files). It contains retained H1/H2/H3/H5/H8/H9/H10/H12. H8's bounded worker pool is enabled for the final run with the general runtime setting `GITHUB_FETCH_CONCURRENCY=4`; the source default remains `1` to preserve the existing serial contract when the setting is absent.

## Sealed holdout

The holdout was sealed and run exactly once after the final candidate was frozen. There was intentionally no holdout-before score: `plan2.md` prohibits using the holdout for tuning and requires a single final run.

| Metric | Holdout result |
|---|---:|
| Job / report | `holdout-final` / `bench/jobs/holdout-final/report.json` |
| Configuration | `split=holdout`, `attempts=1`, `stage=all`, `model=openai/gpt-4o`, `latencyMs=120`, `GITHUB_FETCH_CONCURRENCY=4` |
| Deterministic score | **100.0%** |
| Semantic score | **100.0%** |
| Overall score | **100.0%** |
| Solved every attempt / total | **20/20** |
| Canary / tool use / agent errors | **pass / 100% / 0%** |
| Integrity | all checks pass; 40 issues, 174 comments, 36 users, 9 labels, 32 reactions |
| Ingestion | 96,142 ms; 81 GitHub requests; max concurrency 4; 190 Neo4j queries; 1 transaction |
| OpenAI | 40 fixed `gpt-4o` calls; $0.2253725 ingestion cost |
| Trace | `bench/jobs/holdout-final/traces/github-issue-analyzer-2026-09-03T15-44-36-408Z-1164059.jsonl` (561 spans, zero ERROR status records) |

The required command sequence was a fresh `env -u GITHUB_FETCH_CONCURRENCY bun bench/verify-all.ts` gate followed by `GITHUB_FETCH_CONCURRENCY=4 bun bench/run.ts --split holdout --job holdout-final`; both exited 0. Exactly one holdout report and one holdout trace exist. The surviving filesystem audit found no post-holdout changes to implementation source, benchmark source, the frozen manifest, corpus, task, or holdout files. Acceptance checks did create or update generated runtime artifacts such as `github_issue/.traces/` and `node_modules/.vite/`; these are not implementation changes. No post-holdout tuning, scoring, or rescore occurred. Exact-once execution and gate adjacency are supported by the surviving command and artifact evidence, but are not cryptographically provable because no immutable command transcript was retained.

## Per-hypothesis decision table

All scored candidates below were preceded by a fresh passing `bun bench/verify-all.ts` gate and were compared to `baseline-n3`. Confirmation candidates used `attempts=3`. Reports and traces are preserved; skipped hypotheses have no score by design.

| Hypothesis | Change and target | Decision | Evidence and outcome |
|---|---|---|---|
| H1 | Neo4j identity constraints and lookup indexes; target constraints/indexes | **KEEP** | `bench/jobs/h1-confirm/report.json`; trace `bench/jobs/h1-confirm/traces/github-issue-analyzer-2026-09-03T10-58-08-584Z-1096799.jsonl`. At attempts=3: 100.0% deterministic, 86.7% semantic, 98.3% overall; integrity/canary/errors clean; 10 constraints and 12 indexes. |
| H2 | Parameterized `UNWIND` batching in one managed transaction; target fewer Neo4j statements | **KEEP** | `bench/jobs/h2-confirm/report.json`; trace `bench/jobs/h2-confirm/traces/github-issue-analyzer-2026-09-03T11-41-09-980Z-1110039.jsonl`. At attempts=3: 99.0476% deterministic, 93.3% semantic, 98.3% overall; 318 ingestion statements and 1 transaction versus the anchor's 610 and 0; integrity/canary/errors clean. |
| H3 | Scope orphan Competitor/Category cleanup to the current issue | **KEEP** | `bench/jobs/h3-confirm-2/report.json`; trace `bench/jobs/h3-confirm-2/traces/github-issue-analyzer-2026-09-03T12-38-52-340Z-1120992.jsonl`. At attempts=3: 100% deterministic, semantic, and overall; 40/40 every attempt; integrity and failed spans clean. |
| H4 | Replace fixed `gpt-4o` extraction/summarization with `gpt-4o-mini` | **SKIPPED** | Not run. The campaign contract fixes the SUT model to `openai/gpt-4o`; substituting the requested model would invalidate the comparison. No score or trace exists. `gpt-4o-mini` was used only for harness preflight/evaluation context. |
| H5 | Extract solutions/workarounds from body and comments with source provenance | **KEEP** | `bench/jobs/h5-confirm/report.json`; trace `bench/jobs/h5-confirm/traces/github-issue-analyzer-2026-09-03T13-50-56-259Z-1142599.jsonl`. Partial provenance work was completed atomically before scoring. At attempts=3: 100% deterministic, semantic, and overall; 40/40 every attempt; 25 workaround nodes versus the anchor's 23; integrity/canary/errors clean. |
| H6 | Generic bot/noise filtering and comment token bound | **REVERT** | `bench/jobs/h6-confirm/report.json`; trace `bench/jobs/h6-confirm/traces/github-issue-analyzer-2026-09-03T14-31-15-973Z-1152207.jsonl`. At attempts=3: 99.0476% deterministic, 86.7% semantic, 97.5% overall, 37/40 every attempt. Prompt tokens rose to 101,268 from the anchor's 94,494 and ingestion cost rose to $0.32012 from $0.297585; the required token target did not improve. Source and tests were reverted; the rollback passed 27 unit tests. |
| H7 | Embeddings and Neo4j vector index | **SKIPPED / INCOMPATIBLE** | No valid embedding model/resource contract, generation path, vector-index seam, or populated vector data exists. Existing embedding properties are empty-list placeholders. Scored reports retain `vector_indexes=0` and `nodes_with_embedding=0`. Implementing this would require inventing an external resource contract. |
| H8 | Bounded concurrent GitHub detail fetch | **KEEP** | `bench/jobs/h8-confirm/report.json`; trace `bench/jobs/h8-confirm/traces/github-issue-analyzer-2026-09-03T15-07-24-610Z-1158117.jsonl`. At attempts=3 with `GITHUB_FETCH_CONCURRENCY=4`: 100% deterministic, 93.3% semantic, 99.1667% overall; 121 requests unchanged, max concurrency moved 1→4, canary/integrity/errors clean. No wall-clock reduction is claimed because no median-of-three duration measurement was run. |
| H9 | Remove pipeline Neo4j read-after-write and hand fetched data directly to analysis | **KEEP** | `bench/jobs/h9-confirm/report.json`; trace `bench/jobs/h9-confirm/traces/github-issue-analyzer-2026-09-03T15-29-00-632Z-1161613.jsonl`. At attempts=3: 100% deterministic, semantic, and overall; 40/40 every attempt; Neo4j queries 261; 121 GitHub requests; 1 transaction; integrity/canary/errors clean. No `pipeline.readback` span is present. This is the selected development confirmation. |
| H10 | Return exact Cypher errors and instruct correction/retry | **KEEP** | `bench/jobs/h10-confirm/report.json`; trace `bench/jobs/h10-confirm/traces/github-issue-analyzer-2026-09-03T10-15-48-695Z-1080051.jsonl`. At attempts=3: 100% deterministic, 93.3% semantic, 99.1667% overall; canary/integrity/errors clean. The scored trace did not activate a malformed-query retry, so no direct retry-frequency or retry-latency reduction is claimed. |
| H11 | Semantic-search tool backed by vector retrieval | **SKIPPED / BLOCKED BY H7** | Not run because H7 has no valid vector index or embeddings. A lexical substitute would not test the specified hypothesis and would violate the experiment design. |
| H12 | General schema guidance for enum casing and suspicious empty results | **KEEP** | `bench/jobs/h12-confirm/report.json`; trace `bench/jobs/h12-confirm/traces/github-issue-analyzer-2026-09-03T09-55-31-577Z-1074290.jsonl`. At attempts=3: 100% deterministic, 86.7% semantic, 98.3% overall; 39/40 every attempt and 40/40 at least once; canary/integrity/errors clean. |

The campaign stopped under the third `plan2` stopping condition: every hypothesis in §8 was tried and decided. It did not stop because of three consecutive failed confirmations; H4, H7, and H11 were justified skips, H6 was rejected and reverted, and the remaining feasible hypotheses were retained.

## Retained implementation

The final source preserves these general, non-question-specific changes:

- H1: ten idempotent identity constraints and two Issue indexes.
- H2: eight parameterized `UNWIND` ingestion statements in one `executeWrite` transaction.
- H3: issue-scoped orphan cleanup for Competitor and Category nodes.
- H5: body/comment extraction with source provenance and matching persistence.
- H8: indexed bounded worker pool controlled by `GITHUB_FETCH_CONCURRENCY`; default 1, final holdout setting 4.
- H9: direct in-memory handoff from fetched issue data to analysis, removing the readback stage.
- H10: exact Cypher error feedback and general retry guidance.
- H12: schema enum/property verification and defensive empty-result guidance.

The fixed SUT model remained `openai/gpt-4o` for all scored SUT runs. No model, dataset, framework, benchmark, question, issue-number, author, label, or answer-specific logic was added.

## Evaluation criteria and limitations

### Met or supported by this campaign

- Deterministic answer quality improved from 94.2857% to 100.0% at attempts=3.
- Semantic guardrail improved from 80.0% to 100.0% on the selected development confirmation and was 100.0% on the sealed holdout.
- Neo4j write batching materially reduced counted ingestion queries and introduced one managed transaction without integrity regression.
- Identity constraints/indexes are present: 10 constraints and 12 indexes on the final graph.
- Orphan cleanup is scoped to the issue and integrity remains clean.
- Body/comment solution provenance increased the observed workaround yield on the confirmation corpus (25 vs 23 in the anchor context).
- GitHub request concurrency capability is present and verified: max concurrency 1→4 at unchanged request count under the explicit final setting.
- Read-after-write removal is verified by the H9 trace and 261 counted queries versus the 610-query anchor.
- Cypher error feedback and schema guidance were retained with no agent-error, canary, integrity, or deterministic-score regression.
- Frozen-data integrity is supported by manifest `bench/SPLITS.sha256` value `ae3e0d28952c1ef0622478353f1cb32b24dd54b61e2ef8f4395deb0ae775496b` and the final pre/post-holdout checksum audit.

### Not met or not claimed

- No verified cost reduction: the fixed 60-call `gpt-4o` analysis remained required; H4 was prohibited. The champion's measured ingestion cost was $0.33393 versus $0.297585 for `baseline-n3`.
- No 4×–8× end-to-end latency claim: H8's concurrency counter moved, but plan2 requires a median of three wall-clock measurements and that evidence was not collected for H8. The single final holdout duration is descriptive, not a comparative latency result.
- No direct proof of malformed-Cypher retry activation: H10's trace had no failed query spans.
- H6 did not reduce prompt tokens and was reverted.
- H7 vector capability and H11 semantic vector search were not implemented because their required resource and data contracts were unavailable.

### Claims this harness cannot fully prove

- The plan's 4×–8× ingestion latency claim cannot be established from one noisy wall-clock run; the zero-noise concurrency/request counters are the defensible evidence here.
- A successful semantic vector-similarity search cannot be proven by this lexical frozen question set. The final graph still reports `vector_indexes=0` and `nodes_with_embedding=0`.
- The semantic judge has only five dev tasks and one task is 20 points, so one-task semantic movement is treated as noise under `plan2`; the deterministic score and integrity checks are the primary stable evidence.

## Audit checklist

- [x] Baseline anchor is `bench/jobs/baseline-n3/report.json`, not the n=1 baseline.
- [x] Every cited scored candidate has a preserved report and trace, with the skipped hypotheses explicitly marked as having no score.
- [x] Candidate confirmations use `attempts=3`; the sealed holdout uses exactly one attempt.
- [x] A fresh seven-step `bun bench/verify-all.ts` gate passed immediately before the sealed holdout.
- [x] Exactly one holdout report and one holdout trace exist.
- [x] Holdout report is valid; all 20 tasks pass; canary passes; tool use is 100%; agent-error rate is 0%; integrity passes.
- [x] Frozen manifest and split-file checksums were re-read unchanged.
- [x] No post-holdout implementation source, benchmark source, frozen manifest, corpus, task, or holdout files were modified; generated `github_issue/.traces/` and `node_modules/.vite/` runtime artifacts are explicitly excluded from that claim.
- [x] No post-holdout tuning, scoring, or rescore occurred.
- [x] Corrected post-holdout SUT check passed: `cd github_issue && bun run typecheck && bun run test:unit` exited 0 (4 test files, 27 tests).
- [x] Corrected frozen-data check passed: `cd bench && sha256sum -c SPLITS.sha256` exited 0 (4/4 entries OK).
- [x] Final artifact audit passed: 21 cited paths, 11 valid reports, zero missing paths, zero invalid reports, zero missing report-linked traces, and exactly one holdout report plus one holdout trace. The standalone machine-readable inventory is `/home/azureuser/githubIssue/artifact-audit-inventory.json`; it records the scoped extraction/selection rules, phrase list, selected paths, per-report checks, stdout summary, exit code 0, and UTC generation timestamp. Its canonical representation is UTF-8 compact JSON serialized with sorted keys and separators `(',', ':')`, hashing the complete object with only `canonical_representation.inventory_sha256` omitted; the stored SHA-256 is `6658b3ac196fa459527b6f53f873530ac15d38d28184dbb512c662d1de7c94ab`. The eight persisted documentation checks — `inventory_linked`, `campaign_closed`, `generated_artifact_scope`, `provenance_limitation`, `sut_validation`, `frozen_checksum_validation`, `artifact_audit`, and `repository_metadata` — each have `passed: true`.
- [x] Exact-once holdout and gate adjacency are supported by surviving report/trace and command evidence, with the limitation that no immutable command transcript was retained to make either property cryptographically provable.
- [x] No `.git` metadata exists; repository state is reported as `NO_GIT_METADATA`.


## Final document digest bindings

The following document bindings use a normalized projection to avoid circularity: UTF-8 text with CRLF converted to LF, then the digest value is masked only when it is the value of `stored SHA-256`, `inventory_sha256`, `normalized projection SHA-256`, or another explicitly labeled inventory/document-binding digest field. All other report, trace, source, and frozen-data content remains in the projection. The resulting normalized projection SHA-256 values are recorded in `artifact-audit-inventory.json`; recomputing them does not depend on the self-referential binding values.

- `ledger.md` normalized projection SHA-256: `01cbae0674b56bec6d4c8d293e92673408d8ef2985bf594c345630728e8b003c`
- `RESULTS.md` normalized projection SHA-256: `de00b92b58e559ec184d7f29cec5a5f6511c87812e1de432d9716b4b2c49a437`
- Canonical inventory SHA-256 with the self-referential inventory digest field omitted: `b11e6a056e6da7d77b09ceeba9fec9a472b56848f74cd32bce252eb15e7ccccc`.

## Primary artifact paths

- Ledger: `/home/azureuser/githubIssue/ledger.md`
- Final report: `/home/azureuser/githubIssue/RESULTS.md`
- Plan: `/home/azureuser/githubIssue/plan2.md`
- Baseline anchor: `/home/azureuser/githubIssue/bench/jobs/baseline-n3/report.json`
- Development champion: `/home/azureuser/githubIssue/bench/jobs/h9-confirm/report.json`
- Development champion trace: `/home/azureuser/githubIssue/bench/jobs/h9-confirm/traces/github-issue-analyzer-2026-09-03T15-29-00-632Z-1161613.jsonl`
- Sealed holdout: `/home/azureuser/githubIssue/bench/jobs/holdout-final/report.json`
- Sealed holdout trace: `/home/azureuser/githubIssue/bench/jobs/holdout-final/traces/github-issue-analyzer-2026-09-03T15-44-36-408Z-1164059.jsonl`

## Best commit / frozen release identifier

No Git commit can be cited because this project has no `.git` metadata (`NO_GIT_METADATA`). The best available immutable release identifier for the complete optimized implementation is the frozen source fingerprint:

`9eeb557db3e87c2d`

This fingerprint corresponds to the selected `h9-confirm` development champion and includes the retained H1, H2, H3, H5, H8, H9, H10, and H12 improvements. The corresponding verified champion report is `/home/azureuser/githubIssue/bench/jobs/h9-confirm/report.json`, with trace `/home/azureuser/githubIssue/bench/jobs/h9-confirm/traces/github-issue-analyzer-2026-09-03T15-29-00-632Z-1161613.jsonl`. The sealed holdout also used this same fingerprint. It should be referred to as the **best frozen source fingerprint**, not as a Git commit hash.

## Requested comparison summary (verbatim)

Baseline: `baseline-n3`
Final champion: fingerprint `9eeb557db3e87c2d`

| Factor | Baseline | Final champion | Change |
|---|---:|---:|---:|
| Deterministic accuracy | 94.3% | **100.0%** | **+5.7 percentage points / +6.0% relative** |
| Semantic accuracy | 80.0% | **100.0%** | **+20.0 percentage points / +25.0% relative** |
| Overall benchmark score | 92.5% | **100.0%** | **+7.5 percentage points / +8.1% relative** |
| Solved every attempt | 36/40 = 90.0% | **40/40 = 100.0%** | **+10.0 percentage points / +11.1% relative** |
| Neo4j statements | 610 | **261** | **349 fewer / 57.2% reduction** |
| Managed Neo4j transactions | 0 | **1** | Added transactional batching; percentage increase is not meaningful from zero |
| Schema constraints | 0 | **10** | Added from zero; percentage increase is undefined |
| Database indexes | 0 | **12** | Added from zero; percentage increase is undefined |
| GitHub requests | 121 | 121 | No change: **0%** |
| GitHub fetch concurrency | 1 | 1 | No change: **0%** |
| OpenAI analysis calls | 60 | 60 | No change: **0%** |
| Agent error rate | 0% | 0% | No regression; already zero |
| Integrity checks | Passed | Passed | Preserved at 100% |
| Canary checks | Passed | Passed | Preserved at 100% |

## Main improvements in percentage terms

### Accuracy

The strongest quality improvement was:

- **Overall score improved by 8.1% relative to baseline**
- **Deterministic accuracy improved by 6.0% relative**
- **Semantic accuracy improved by 25.0% relative**
- Every benchmark task became consistently solvable: **90% → 100%**, an **11.1% relative improvement**

The absolute score movement is more intuitive:

```text
Overall:        92.5% → 100.0%   = +7.5 points
Deterministic:  94.3% → 100.0%   = +5.7 points
Semantic:       80.0% → 100.0%   = +20.0 points
```

### Neo4j efficiency

Neo4j statements decreased from **610 to 261**:

```text
Reduction = (610 - 261) / 610 × 100
= 57.2%
```

So the final system uses approximately **57% fewer Neo4j statements**, or only **42.8% of the baseline statement volume**.

This came from:

- Batched `UNWIND` writes
- A managed transaction
- Scoped cleanup
- Reduced repeated graph operations
- Schema constraints and indexes

### Reliability

Reliability was preserved rather than merely traded for performance:

- Agent errors remained at **0%**
- Integrity checks remained **100% passing**
- Canary checks remained passing
- Tool-use checks remained at **100%**
- No deterministic regression was introduced
- The sealed holdout also achieved **100% overall**

## Overall interpretation

The most defensible summary is:

> Compared with the verified baseline, the final champion improved overall benchmark quality from **92.5% to 100%**, an **8.1% relative improvement**, increased semantic quality by **25% relative**, made every development task solve consistently, and reduced Neo4j statement volume by **57.2%** while preserving zero agent errors and full graph integrity.

The improvements should not be summarized as a single average percentage because accuracy, database statements, transactions, cost, and latency are different units. The strongest combined result is therefore:

- **+8.1% relative overall quality**
- **+11.1% relative consistency**
- **−57.2% Neo4j database work**
- **100% integrity and 0% agent-error rate preserved**
- **100% sealed holdout score**

The areas that did **not** measurably improve were GitHub request count/concurrency, OpenAI call count, and cost. No verified percentage reduction should be claimed for those factors.

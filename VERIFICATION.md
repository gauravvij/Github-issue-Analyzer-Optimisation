# Verification of `RESULTS.md`, and a second benchmark

**Status:** complete. Commit `f195ffb` is HEAD.
**Scope:** `bench/` was never modified — it is the referee. The three trees compared below
are commits on `github_issue/`, not separate folders:

| name used below | commit | fingerprint |
|---|---|---|
| baseline | `f5b3184` | `71c696b48a9da953` |
| champion | `ee48387` | `9eeb557db3e87c2d` |
| champion_fixed | `f195ffb` (HEAD) | `73acfdc375576226` |

Score a historical one with `git worktree add .worktrees/baseline f5b3184` and point
`SUT_DIR` at `.worktrees/baseline/github_issue`. See [`README.md`](README.md).

---

## 1. Verdict

**The improvement is real, it reproduces on an independent benchmark, and the numbers
recorded during the campaign are genuine.** Every hard figure in `RESULTS.md` traces to a
saved report; every checksum, source fingerprint and document digest reproduces exactly.
Nothing was fabricated.

What re-measurement changed is the **precision** of the claim, not its direction:

| | claimed (single runs) | measured (3 runs per arm, unseen corpus) |
|---|---:|---:|
| Deterministic accuracy gain | +5.71 pp | **+5.71 pp** — confirmed exactly |
| Overall score gain | +7.50 pp | **+5.28 pp** |
| Semantic gain | +20.00 pp | **not a signal** — see §2 |
| Neo4j query reduction | −57.2% | **−63.5%** — better than claimed |

Two corrections matter. First, the reported **100% was a single lucky run**: re-running the
identical frozen source on the identical questions scores **97.5%**, and the baseline it was
compared against was likewise its own worst draw. Averaging three runs per arm fixes both
ends. Second, the accuracy gain is **one defect**, not eight compounding optimisations —
seven of the eight retained changes moved efficiency and nothing else.

The single-run reproduction that started this, for the record:

| Metric | `h9-confirm` (reported) | `repro-champion` (re-run) |
|---|---:|---:|
| Deterministic | 100.0% | **98.10%** |
| Semantic | 100.0% | **93.33%** |
| Overall | 100.0% | **97.50%** |
| Solved every attempt | 40/40 | **37/40** |
| Canary | pass | **FAIL** (agent variance, not a graph fault — see §2) |
| SUT fingerprint | `9eeb557db3e87c2d` | `9eeb557db3e87c2d` (identical) |

The headline figures for the shipped system, against the reconstructed baseline on a corpus
neither had seen, are in §7.

---

## 2. Claim-by-claim verdict

### Confirmed

- **Every scored number in `RESULTS.md` matches its report.** `baseline-n3`, `h9-confirm`,
  `holdout-final` and all eight per-hypothesis rows: scores, solved counts, Neo4j queries,
  transactions, GitHub requests, OpenAI call counts and costs — all exact.
- **`sha256sum -c bench/SPLITS.sha256` → 4/4 OK.** The manifest's own SHA-256 is the
  claimed `ae3e0d28…`. The splits were never edited.
- **The frozen source fingerprint is real.** Recomputing `bench/run.ts:59`
  `fingerprintSut()` over `github_issue/` gives `9eeb557db3e87c2d`, 19 files — exactly what
  `h9-confirm` and `holdout-final` recorded. The working tree *is* the champion.
- **`artifact-audit-inventory.json` reproduces** under its documented canonicalisation
  (`6658b3ac…`), all 21 cited paths exist, 11/11 reports are valid, and both document
  projection digests (`f2f7edea…`, `4b0504ab…`) reproduce under the rule stored in the
  inventory.
- **No benchmark-specific logic in the SUT** (plan2 rule 4). Zero corpus issue numbers,
  zero corpus author logins, zero verbatim benchmark questions, and no `huggingface` /
  `datasets` / dataset-vocabulary strings anywhere in `src/`, `agent/`, `ingestion/`. The
  only label-word hits (`bug`, `duplicate`) are ordinary English in comments and generic
  test fixtures. The dataset specificity lives entirely in `bench/`.
- **The harness still gates green today.** `bun bench/verify-all.ts` → 7/7, exit 0,
  including the negative control that a canned agent must score *below* 50%.
- **Efficiency changes are real and reproduce.** Measured directly, ingesting the same
  60-issue corpus with analysis off: baseline **313 Neo4j statements, 61 sessions, 0
  transactions**; champion **21 statements, 3 sessions, 1 transaction**. Identical,
  fully-passing integrity on both.

### Contradicted or not reproducible

- **"Overall 92.5% → 100.0%" does not reproduce.** Re-run: 97.50%. Across the 11 recorded
  n=3 dev runs after H12, overall spans **97.50 – 100.00**, median **98.33**. The champion's
  100.00 is the maximum of that band.
- **"Semantic 80.0% → 100.0% (+25% relative)" is noise.** Post-H12 semantic spans
  **80.0 – 100.0**, median 93.3 — and the cleanest evidence is accidental: `h3-confirm` and
  `h3-confirm-2` are the **same source fingerprint** `8a9efd42759f2fa2` and scored **80.0%
  and 100.0%** semantic (97.50% and 100.00% overall). Same code, 20 points apart. With five
  semantic tasks one task is worth 20 points; `RESULTS.md:113` says so, then headlines
  "+25.0% relative" anyway. (The re-run of H3 was for a documented, legitimate reason —
  reverted exploratory H5 edits — so this is not cherry-picking, just an unintended
  same-code replication.)
- **"(4/5) semantic" at baseline is wrong.** No baseline semantic task scored 0. Per-task
  pass rates were 0.667 / 1 / 1 / 1 / 0.333 — 3/5 solved every attempt, 5/5 at least once.
  The parenthetical reads like the true "(33/35)" next to it, but is not comparable.
- **The champion was never scored at the configuration it ships with.** `RESULTS.md` says
  the champion runs at `GITHUB_FETCH_CONCURRENCY=4`; `h9-confirm` recorded
  `maxConcurrent: 1`. Concurrency 4 on the frozen source had been run exactly once, at
  `attempts=1`, on the holdout. `repro-champion` closes that gap: it is the first n=3 score
  of the shipped configuration. The document also contradicts itself twice on this — the
  verbatim table says concurrency "1 → 1, No change: 0%" and the closing interpretation
  lists concurrency among things that did not improve, while "Met or supported" claims 1→4.
- **`neo4j.queries` is not the zero-noise counter it is presented as.** `h9-confirm` 261 vs
  `repro-champion` **264**, same code. The ingestion half is deterministic; the
  analysis-persistence half scales with whatever the model extracts that run
  (`solution_nodes` 37→38, `workaround_nodes` 23→25, `category_nodes` 118→121). The headline
  "610 → 261, −57.2%" therefore mixes a real structural reduction with a model-dependent term.
- **H2 missed its own acceptance bar.** `plan2.md` §8 set H2's target at **≥75%** fewer
  Neo4j queries. Achieved: 57.2%. `RESULTS.md` calls it "materially reduced" and never notes
  the miss.
- **H5's claimed yield gain does not hold in the shipped system.** `plan2.md` §8 required
  *both* `solution_nodes` and `workaround_nodes` to rise. `solution_nodes` never moved
  (35 → 35). `RESULTS.md` reports only the workaround half, and even that is transient: the
  shipped champion's `workaround_nodes` is **23 — identical to baseline** (holdout: 22).

### Correct but materially incomplete

- **The deterministic gain is real, but it is one 3-line prompt change.** `baseline-n3`
  failed exactly two tasks: `dev-003` (`open_count`) and `dev-004` (`closed_count`), both
  at pass rate **0.000** — the Cypher enum-casing trap (`i.state = 'open'` vs `'OPEN'`).
  H12 added three lines to `agent/config.ts` telling the agent to verify enum casing rather
  than trust an empty result, and both pass from `h12-confirm` onward. **Every hypothesis
  after H12 — H10, H1, H2, H3, H5, H8, H9 — contributed zero deterministic improvement**;
  H2 briefly regressed `dev-003` to 0.667. The re-run shows the fix is strong but not
  absolute: `dev-003` 3/3, `dev-004` 2/3.
- **The per-hypothesis table is not a set of ablations.** The runs were cumulative —
  `baseline 71c6 → h12 5449 → h10 5a17 → h1 a68b → h2 ba16 → h3 8a9e → h5 007f → h6 238e
  → h8 f2f2 → h9 9eeb` — so each `hN-confirm` measures everything up to and including hN.
  `h10-confirm` and `h12-confirm` were scored on 18-file trees with 0 constraints and 0
  indexes, before H1 existed. The table presents all eight KEEPs uniformly across eight
  distinct fingerprints.
- **Holdout semantic rests on 3 tasks, not 5** — never stated.
- **`RESULTS.md` on disk is a mangled concatenation of two non-identical revisions**
  (bytes 0–17124 and 17125–37688, glued mid-line at line 149). Lines 1–131 are identical in
  both copies; the "Final document digest bindings" section appears only in the first, and
  96 lines of comparison summary only in the second. The defect is sealed inside the
  document's own signed digest — the projection hash reproduces *over* the duplication, so
  the corrupted document is the one that was signed.

### What the canary failure actually means

`bench` treats a canary failure as "the harness or the graph is broken". Here it was not:
`dev-001` (total issues) passed 3/3, and `dev-002` (total comments) passed 2/3 — one
attempt simply didn't state the number. Integrity passed all 26 checks. The canary design
assumes a canary failure is systematic; a single flaky attempt out of three trips it just
as hard. That is worth knowing before anyone treats a future canary failure as a graph fault.

---

## 3. The baseline was reconstructed, byte-exact

`RESULTS.md` records `NO_GIT_METADATA`, and the baseline tree (`71c696b48a9da953`, 18
files) was not on disk — only the champion. It has now been recovered and **proven**.

- **Ingredient found:** `/tmp/astropods_agents`, a clean clone of the pre-campaign upstream
  (`astropods/agents` @ `2a881ce`, working tree clean). Preserved to
  `.upstream-snapshot/` with a `sha256sum` manifest and provenance file, because `/tmp` is
  one reboot from losing it.
- **Method:** peel each hypothesis off the champion — H12 and H10 (prompt/description
  strings), H8 (`fetchMultipleIssueDetails` worker pool), H1 (`setupDatabaseSchema`), H2
  (the `UNWIND` batch and its call site), H3 (issue-scoped orphan cleanup), H5 (source
  provenance in `openai.ts`/`analysis.ts` plus its test file), H9 (the `pipeline.readback`
  removal). The pre-baseline tracing and harness seams were kept throughout, which is why
  peeling from the champion is correct and rebuilding from upstream would not be.
- Two details the ledger's prose gets slightly wrong, recovered from the artifacts:
  H12 **replaced** an existing instruction line rather than adding three, and the champion
  still carries an orphaned duplicate file header in `neo4j.ts` — residue of the
  "accidentally appended duplicate implementations" incident the ledger records under H1 —
  which the baseline did not have. The exact pre-H9 `pipeline.readback` span
  (`{'pipeline.issue_count': 60}`) was recovered from the `baseline-n3` trace.

Per-hypothesis, what was reverted:

| Hypothesis | Reverted in |
|---|---|
| H12 | `agent/config.ts` — restored the single `If a query returns no results, say so honestly.` rule |
| H10 | `agent/tools/query-neo4j.ts` — removed the retry-from-exact-error sentence in the tool description |
| H8 | `src/services/github.ts` — restored the serial detail-fetch loop |
| H5 | `src/services/openai.ts`, `src/services/analysis.ts` — dropped `sourceType`, restored comment-only provenance; deleted `src/services/__tests__/analysis.test.ts` (19 → 18 files) |
| H3 | `src/services/analysis.ts` — restored the graph-wide orphan sweep |
| H2 | `src/services/neo4j.ts` — removed the `UNWIND` batch and its transaction, restored the per-issue loop |
| H1 | `src/services/neo4j.ts`, `src/services/pipeline.ts` — removed `setupDatabaseSchema()` and its call |
| H9 | `src/services/pipeline.ts` — restored `fetchMultipleIssueDetails` and the `pipeline.readback` span |

**Acceptance: byte-exact, first attempt, no bisect needed.**

```
reconstruction  →  71c696b48a9da953  (18 files)   == bench/jobs/baseline-n3/report.json
```

It also typechecks clean, passes 21/21 of its own unit tests (the champion's 27 include
H5's 6), ingests a real 60-issue corpus with all integrity checks passing, and shows the
baseline's ingestion signature: **313 statements, 61 sessions, 0 transactions, 0
constraints, 0 indexes** against the champion's 21 / 3 / 1.

---

## 4. `verification_bench/`

Built, typechecking, and passing its full gate against a stand-in split. It **reuses**
`bench/harness/*` rather than forking it: the meters, fake GitHub server, graders and
integrity checks are imported unchanged.

`bench/run.ts` and `bench/harness/preflight.ts` hardcode the SUT and benchmark directories
and `bench/` may not be edited (plan2 rule 1), so `verification_bench/derive.ts`
regenerates them with an explicit, reviewable patch — imports repointed, SUT taken from
`$SUT_DIR`. `bench/scripts/build-tasks.ts`, `smoke.ts` and `verify-oracles.ts` are derived
the same way. `derive.ts --check` is the first gate step, so the copies cannot drift.

The one behavioural change to the question generator: `bench/scripts/build-tasks.ts:107`
hardcodes a `huggingface/datasets` vocabulary (`parquet`, `load_dataset`, `push_to_hub`, …)
for the `mentions_term` template. It is replaced by terms mined from the corpus itself —
frequency-banded, deterministic, still subject to the same case-stability filter — so the
generator is corpus-independent rather than carrying another repo's word list.

`verify-sut-switch.ts` pins both trees by fingerprint before any spend. If `SUT_DIR`
silently fell back to its default, both runs would score the *same* code and produce a
beautiful, meaningless "no difference" — the failure mode that looks most like a finding.

Gate result (free, both SUTs):

```
derived · sut-pinning · typecheck:champion · typecheck:baseline · typecheck:bench
test:harness · smoke:baseline · oracles:baseline · smoke:champion · oracles:champion
gate PASSED
```

### Corpus

`sympy/sympy`, selected by SWE-bench. django was the first choice — most SWE-bench
instances — but **`django/django` has GitHub Issues disabled**; Django tracks bugs in Trac,
so its SWE-bench problem statements have no GitHub issue behind them to fetch. sympy is the
largest SWE-bench repo that actually uses GitHub Issues.

SWE-bench's role is **selection, not content**: each instance id names a merged PR, and the
issue that PR closed is fetched live from GitHub in the exact shape
`src/services/github.ts` returns. SWE-bench's test split has **386 distinct sympy resolving
PRs**. `closingIssuesReferences` — GitHub's own link — covers about 45% of them; another
45% state the same thing in the body with the keywords GitHub itself parses (`Fixes #123`),
and both forms are used so the corpus is not biased toward PRs that happened to use the
modern linking. That yields 421 referenced numbers, 408 of which are real issues (the rest
point at PRs), and **385 pass the same filters `bench/` applies** (author present,
200–30,000 chars, complete comment thread).

| Split | Issues | Open / closed | Labels | Authors | Comments |
|---|---:|---:|---:|---:|---:|
| dev | 60 | 6 / 54 | 30 | 38 | 283 |
| holdout | 40 | 2 / 38 | 18 | 29 | 196 |

Question sets match `bench/`'s shape: **40 dev tasks** (26 structural / 9 retrieval /
5 semantic) across 20 templates, **20 holdout tasks** (14 / 3 / 3) — the same quota, the
same 12.5% semantic cap, the same two canaries.

Unlike `bench/`'s corpus — scraped, with comment authors and per-user reactions
synthesised — every field here is real, which closes two documented fidelity gaps and
exercises the `Comment -> User` authorship path `bench/` never touches.

Splits are frozen and pinned in `verification_bench/SPLITS.sha256`, enforced by preflight
on every run.

### Two latent bugs in `bench/`, found by pointing it at a second corpus

Neither would ever fire on `huggingface/datasets`. Both are fixed in the derived copies;
`bench/` itself is untouched.

1. **A question that can never be passed.** `bench/scripts/build-tasks.ts` guards number
   questions with near-miss `forbid` values — `closed_count` forbids `issues.length` so a
   confident "60" cannot pass by accident. SWE-bench only contains issues that were resolved
   by a merged PR, so on a first cut of the corpus every issue was CLOSED, making
   `closed_count == issues.length`: the task forbade its own correct answer and would have
   silently cost **both** SUTs a point while looking like a genuine failure. Fixed once in
   `add()`, which every template routes through, by dropping any `forbid` entry equal to the
   answer. Also fixed at the source: the dev/holdout deal is now proportional per stratum
   rather than a prefix slice, so open issues land in both splits instead of all in dev —
   which matters because open/closed counting is exactly where the champion's one real
   improvement lives.

2. **Integrity expectations that assume `bench/`'s fidelity gaps.**
   `bench/harness/neo4j.ts` computes expected `user_count` from *issue* authors only and
   expected `reaction_count` from *issue* reactions only. That is exact for `bench/`'s
   corpus, where comment authors are null and comment reactions empty — and wrong for any
   corpus that has them: the gate failed with `user_count expected=38 actual=89` and
   `reaction_count expected=3 actual=13`. Generalised to count comment authors and comment
   reactions too. On `bench/`'s own corpus the generalised forms reduce to the originals
   exactly, since the extra terms are empty there.

   Verifying the reaction figure turned up a modelling detail worth recording: a `Reaction`
   node is `MERGE`d on `{content, issueId, userLogin}` — `commentId` is not part of its
   identity — so one user reacting the same way to two comments on the same issue is **one
   node**. Corpus totals say 16 reactions; the graph correctly holds 13. Both SUTs share
   this identity, so it cannot bias the comparison, but it means `Reaction` counts are
   distinct-key counts, not event counts.

### Gate

Free, both SUTs, both splits — all green:

```
derived · sut-pinning · typecheck:champion · typecheck:baseline · typecheck:bench
test:harness · smoke:baseline · oracles:baseline · smoke:champion · oracles:champion
```

`oracles` re-derives all 40 dev and 20 holdout answers from the graph with independent
hand-written Cypher, against graphs built by each SUT separately. `smoke` confirms both
ingest the corpus with every integrity assertion passing, and shows the two ingestion
signatures cleanly: **baseline 409 statements / 61 sessions / 0 transactions**, **champion
batched into 1 transaction**.

**Known limitation.** The corpus-mined `mentions_term` vocabulary produces generic terms
(`following`, `home`, `https`) rather than domain terms. The questions remain exact and
deterministic — the oracle uses the same substring rule the agent's Cypher can — and
`bench/`'s hardcoded list is comparably generic (`map`, `image`, `cache`), so this is not a
fairness problem between the two SUTs. It is a weaker retrieval test than a curated
vocabulary would give.

---

## 5. Does the improvement generalize? Yes — and it is one defect

Both trees scored on `verification_bench`, a corpus neither has ever seen.

### Sealed holdout — 40 unseen issues, 20 tasks, one attempt each

| | baseline `71c696b4` | champion `9eeb557d` |
|---|---:|---:|
| Deterministic | 88.24% | **100.00%** |
| Semantic | 100.00% | 100.00% |
| Overall | 90.00% | **100.00%** |
| Solved | 18/20 | **20/20** |
| Canary / tool use / agent errors | pass / 100% / 0% | pass / 100% / 0% |
| Neo4j queries | 452 | **175** |
| Neo4j sessions | 82 | **4** |
| Transactions | 0 | **1** |
| Constraints / indexes | 0 / 0 | **10 / 12** |
| GitHub requests | 81 | 81 |
| Ingest wall clock | 138.1s | **121.5s** |
| Integrity | all pass | all pass |

**Exactly two tasks differ, and they are `open_count` and `closed_count`.** Every other
task in the holdout scores identically. That is as clean an attribution as this kind of
benchmark can produce: the champion's entire accuracy advantage, on data it has never seen,
is one defect class.

### The defect

The graph stores `Issue.state` as `'OPEN'` / `'CLOSED'`. GitHub's UI and REST API use
lowercase, so a model that has to guess writes `i.state = 'open'`, gets zero rows back, and
answers *"There are currently no open issues."* A confident zero produced by a broken query
— the worst failure shape for an analytics agent, because it looks like an answer.

The baseline does this on essentially every attempt, on both corpora:

```
baseline   MATCH (i:Issue) WHERE i.state = 'open'   -> 0 rows -> "no open issues"
champion   MATCH (i:Issue {state: 'OPEN'})          -> 6 rows -> "6 open issues"
```

H12 — the three lines the campaign added — never mentions the permitted values. It says
*"if a query returns no results, verify enum casing and property names; never turn a
suspicious empty result into a confident zero."* That is a **hint**, and it works most of
the time by nudging the model toward uppercase. It is not a fix, and it is not reliable:
re-running the champion on the original corpus, `closed_count` still failed one attempt in
three, with the answer *"There are currently no closed issues."*

## 6. The proper fix

The root cause is that the schema block in `agent/config.ts` describes the field as
`state (STRING)` and never says what values are legal, so the model has to guess. The same
block already documents the other enum-ish field in the house style —
`Reaction — content (STRING, e.g. THUMBS_UP)`. The fix follows it:

```diff
- createdAt (STRING), updatedAt (STRING), state (STRING), authorLogin (STRING)
+ createdAt (STRING), updatedAt (STRING), state (STRING, one of: OPEN, CLOSED),
+ authorLogin (STRING)
```

One line. The fix commit is otherwise byte-identical to the champion (fingerprint
`73acfdc375576226`); its diff touches `agent/config.ts` alone, and the ingestion path never
imports that file. H12's guidance is deliberately kept — it still
covers enum mistakes the schema does not enumerate.

### Tested, not asserted

A full scored run costs about a dollar and spends 39/40 of it on unrelated questions.
`verification_bench/probe-enum-casing.ts` asks only the two questions that expose the
defect, many times, and records the Cypher the model actually wrote. Ground truth comes
from the live graph, so it works against whatever split is ingested.

| Variant | Correct answers | First state-query used stored casing | "Confident zero" answers |
|---|---:|---:|---:|
| baseline `71c696b4` | 8/40 | 3/20 | 32 |
| champion `9eeb557d` | 77/80 | 77/80 | 3 |
| **champion_fixed `73acfdc3`** | **80/80** | **80/80** | **0** |

Casing and correctness correlate one-to-one: **every single miss, in every variant, is a
query that wrote lowercase.** Documenting the enum takes the champion's residual ~4%
failure rate to zero across 80 trials, and removes the failure mode rather than papering
over it.

---

## 7. The measured gain, averaged over three runs per arm

Single runs are what produced the original report's overstated headline, so every arm here
is three independent `--attempts 3` runs on `verification_bench` dev — 120 graded attempts
per arm, on a corpus none of the three trees has ever been tuned against.

| arm | n | deterministic | semantic | overall | solved every attempt |
|---|---:|---|---|---|---|
| baseline `71c696b4` | 3 | 94.29% (92.38–95.24) | 97.78% (93.33–100.00) | 94.72% (92.50–95.83) | 37.0/40 |
| champion `9eeb557d` | 3 | **100.00%** (100.00–100.00) | 95.56% (86.67–100.00) | 99.44% (98.33–100.00) | 39.3/40 |
| champion_fixed `73acfdc3` | 3 | **100.00%** (100.00–100.00) | 100.00% (100.00–100.00) | **100.00%** (100.00–100.00) | **40.0/40** |

### Gain over baseline

| | deterministic | semantic | overall | solved |
|---|---:|---:|---:|---:|
| champion | **+5.71 pp** (+6.06%) | −2.22 pp | +4.72 pp (+4.99%) | +2.33 |
| champion_fixed | **+5.71 pp** (+6.06%) | +2.22 pp | +5.28 pp (+5.57%) | +3.00 |

### What the per-run detail shows

```
baseline    base-dev     open_count(0.00) closed_count(0.00) + 3 one-off flips
            base-dev-2   open_count(0.33) closed_count(0.00)
            base-dev-3   open_count(0.33) closed_count(0.00)
champion    champ-dev    -
            champ-dev-2  -
            champ-dev-3  summarize_issue(0.67) x2
fixed       fixed-dev-1  -   fixed-dev-2  -   fixed-dev-3  -
```

- **The baseline's only reproducible failures are `open_count` and `closed_count`.** They
  fail in all three runs. Every other baseline failure occurs once and never again.
- **The deterministic gain has zero spread.** Baseline 92.38–95.24, champion and fixed
  100.00–100.00 across three runs each. The ranges do not overlap. This is the one result
  in this whole exercise that is stable, mechanistically explained, and replicated on two
  independent corpora.
- **The semantic metric is noise, and now it is unambiguous.** The champion averaged
  **below** the baseline on it (−2.22 pp), driven by one run where two `summarize_issue`
  tasks flipped. Neither H5 nor the enum fix touches summarisation, so no causal story
  exists for a semantic difference in either direction. `champion_fixed`'s clean
  100.00/100.00/100.00 is luck on three draws, **not** an effect of the fix — the fix only
  changes one line of the schema block.
- **Efficiency transfers mechanically and reproducibly:** 698.0 → 254.7 Neo4j queries
  (−63.5%), 122 → 4 sessions, 0 → 1 managed transaction, 0 → 10 constraints and 0 → 12
  indexes. Ingestion wall clock 172.5s → 166.1s.

### The honest one-line summary

> On a benchmark it was never tuned against, the optimised system is **+5.7 percentage
> points** more accurate on deterministic questions than the baseline and does **63% less
> database work**. That accuracy gain is entirely one defect — the agent guessing the
> casing of `Issue.state` — and the campaign fixed it with a prompt hint that works ~96% of
> the time. Documenting the enum in the schema instead takes it to 100% across 80 targeted
> trials and 120 graded attempts. Nothing else the campaign changed moved accuracy at all.

## 8. Cost and scope

12 scored runs plus targeted probes, **≈$12.50** of OpenAI spend. `bench/` was never
modified. The three compared trees are commits on `github_issue/`; the new harness is
`verification_bench/`.

`plan.md` and `plan2.md` — the campaign's brief and its operating rules, cited throughout
this document — were removed from the working tree once the campaign closed. They remain
in history: `git show f5b3184:plan2.md`.

### Limitations, stated plainly

- Three runs per arm is enough to separate a 5.7 pp deterministic gap with no overlap; it
  is **not** enough to resolve the semantic metric, and no semantic claim is made here.
- Both benchmarks are single-repo. `verification_bench` is `sympy/sympy` only, so
  "generalises" means "held on a second, independent repository", not "holds universally".
- The corpus-mined `mentions_term` vocabulary is generic (`following`, `home`, `https`).
  Deterministic and fair to both arms, but a weaker retrieval test than curated terms.
- SWE-bench selects issues resolved by a merged PR, so the corpus skews closed
  (dev 6/60 open, holdout 2/40). Both splits do contain open issues, which is what the
  state questions need.
- Costs come from the local price table in `bench/harness/instrument.ts`, not OpenAI
  billing.
- `champion_fixed` was scored QA-only on the champion-built graph. Legitimate because the
  two commits differ solely in `agent/config.ts`, which the ingestion path never imports,
  but it means the fixed arm shares the champion's ingestion samples rather than having its
  own.

### Every campaign checkpoint replays — except one, and that is itself a finding

Reversing the hypotheses one at a time off the champion reproduces **eight of the nine**
fingerprints the campaign recorded, exactly:

```
champion  9eeb557db3e87c2d (19)   h2   ba16c67610ce9181 (18)
h8        f2f20f1072b41bd5 (19)   h1   a68bb7ced73b2374 (18)
h5        MISMATCH — see below     h10  5a171342ee9c4e1a (18)
h3        8a9efd42759f2fa2 (18)   h12  5449f4df144be297 (18)
                                   baseline 71c696b48a9da953 (18)
```

`h5` is the exception: removing H9 and H8 from the champion gives `3640acee24f75ce4`, not
the recorded `007fde4eb448998a`. The cause is H6, the one rejected hypothesis. It was
implemented between `h5-confirm` and `h8-confirm` and then reverted, and the ledger touts
that revert as clean. It was **behaviourally** clean — the champion contains no bot
filtering, no 2,000-character comment cap, nothing H6 added — but it was **not byte-exact**.
H6 touched `src/services/openai.ts` and `src/services/__tests__/analysis.test.ts`, which is
precisely where the residue must sit: `h8` reproduces and `h3` reproduces, so the difference
is confined to what H5's reversal rewrites intersected with what H6 touched.

Nothing downstream is invalidated — every scored fingerprint from `h8-confirm` onward,
including the champion and the sealed holdout, reproduces exactly. It is worth recording
only because "the change was reverted" and "the tree returned to its previous bytes" are
different claims, and the ledger makes the first while implying the second.

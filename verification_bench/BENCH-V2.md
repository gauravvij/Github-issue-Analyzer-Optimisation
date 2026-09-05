# Benchmark v2 — stratified, multi-repo, ablated

## Why there is a v2

The campaign's headline was **94.29% → 100.00% deterministic accuracy**. It is
true, and on its own it is close to useless:

- The denominator is **35 deterministic questions on one repo**, so a single
  question is worth 2.9 points.
- `VERIFICATION.md:122-129` already records that **two** of those 35 —
  `open_count` and `closed_count` — account for the entire gain. The aggregate
  percentage hides that completely.
- The gain is *attributed* to the `Issue.state` enum documentation by a probe,
  never *isolated* by an ablation. Nothing shows the one-line schema change is
  sufficient on its own.
- `README.md:184-188` records a fourth gap: extraction is ~29% of run cost and
  **nothing grades it**, so a cheaper extraction model would read as "cost down,
  score unchanged" whether or not it got worse.

v2 addresses all four. It adds nothing to `bench/` (still frozen) and edits no
file `derive.ts` generates except through `derive.ts` itself.

## What it is

**300 questions over six repos**, each question tagged with a stratum:

| split | repo | why this repo |
|---|---|---|
| `sympy2-dev` | sympy/sympy | the incumbent — keeps continuity with the old results |
| `skl-dev` | scikit-learn/scikit-learn | mixed-case labels (`Bug`, `help wanted`, `Easy`) |
| `mpl-dev` | matplotlib/matplotlib | prefixed and emoji labels (`status: confirmed bug`, `🌱 Good first issue`) |
| `req-dev` | psf/requests | deliberately sparse — the empty/zero-result path |
| `astropy-holdout` | astropy/astropy | **sealed.** Module labels (`io.fits`, `units`) |
| `pylint-holdout` | pylint-dev/pylint | **sealed.** The only SWE-bench repo with mixed-case labels (`Bug :beetle:`, `Enhancement ✨`) — the only one that can exercise the label-casing defect |

50 questions per split, filled to fixed per-stratum weights rather than the
alphabetical template round-robin `bench/` uses:

```
canary 2  enum_state 7  label 5  author 4  date_range 5  aggregation 5
text_search 3  multi_hop 4  true_zero 5  paraphrase 4  semantic 6
```

Every corpus is 60 issues, **~40% open / 60% closed**. That balance is the
reason the corpora are not pure SWE-bench: SWE-bench only contains issues a
merged PR resolved, so a corpus drawn from it alone is ~100% closed —
matplotlib 187/187, astropy 91/91, scikit-learn 211/212 across the full test
split. The enum stratum would have been degenerate on every new repo, testing
nothing. So each corpus is ~60% SWE-bench-linked, which preserves the gold-patch
provenance extraction is graded against, plus ~40% open issues sampled by the
same seeded LCG from the repo's whole open history.

`django/django` is absent despite having the most SWE-bench instances by far
(231 of 500 Verified): it has **GitHub Issues disabled** and uses Trac, so it has
no fetchable issues at all.

### The strata that did not exist before

- **`true_zero`** — questions whose correct answer really is zero. The enum fix
  moved the agent from wrong-zero to nonzero; nothing until now checked that it
  did not simply learn that zero is a suspicious answer.
- **`label_natural_casing`** — asks `"bug"` where the graph stores `Bug`. The
  same defect class as `Issue.state`, on a different property, never tested.
- **`paraphrase`** — the same underlying query in three wordings, scored
  separately, so sensitivity to phrasing is visible as itself.
- **`multi_hop`** — two-hop traversals ("which users commented on issues
  labelled X"). Both arms sit near 50% here; it is the hardest stratum.
- **`date_range`** — boundaries are chosen on days when **no** issue was created,
  so "before" and "on or before" cannot disagree.

## The arms

A 2×2: `{baseline, champion} × {enum documented, not}`.

| arm | tree | fingerprint |
|---|---|---|
| `A-baseline` | `.worktrees/baseline/github_issue` @ `f5b3184` | `71c696b48a9da953` |
| `B-baseline-enum` | `.worktrees/baseline-enum/github_issue` @ `f5b3184` + one line | `50bf9c564c4d8a20` |
| `C-champion` | `.worktrees/champion/github_issue` @ `ee48387` | `9eeb557db3e87c2d` |
| `D-champion-enum` | `.worktrees/champion-enum/github_issue` | `73acfdc375576226` |
| `E-freetext-fix` | `github_issue` (HEAD) | `f02bde21fe4ed0fd` |

`E` adds two rules the schema block never stated — match free text
case-insensitively, and re-anchor on the issue rather than chaining on from a
label — closing the two defects section "Four defects…" below is about finding.

B and D differ from A and C **only** in `agent/config.ts`, which the ingestion
path never imports — so each is scored `--stage qa --keep-graph` on the graph its
sibling built. Two ingests per corpus, not four, and the comparison is exact:
B sees the very bytes A ingested. `analyze.ts` asserts that from
`graphProvenance.sutHash` rather than trusting the job name.

## Four defects found in the frozen grader

Building the true-zero stratum required grading answers whose correct form is
"there are none", and that exposed four ways `bench/harness/grade.ts` scores a
correct answer wrong. `bench/` is the referee and is not edited; `grade-v2.ts`
wraps it, delegating every case it already handles correctly.

1. **A number ending a sentence.** `(?<![\d.])N(?![\d.])` rejects decimals
   (`60.5`, `3.60.1`) — and also the full stop of a sentence. `"The answer is 7."`
   scored zero. Narrowed to `(?!\.?\d)`.
2. **An empty expectation accepting silence.** `issue_set {expect: []}` passes
   whenever no issue is cited — which is also true of `""`, of a refusal, and of
   a crash. A completely broken arm would have aced the exact stratum built to
   catch it. Now an empty expectation must be met by an actual assertion of
   absence.
3. **A zero that echoes the question.** `"How many issues were created in
   2012-07?"` answered `"No issues were created in July 2012."` is correct;
   requiring the character `0` fails it. Numbers the question itself supplied are
   now excluded before deciding whether the answer stated a count.
4. **Counts spelled as words.** `"Three distinct users have commented"` is a
   correct answer to a how-many question. `one` is still not accepted — in prose
   it is an article and a pronoun far more often than a count.

**Measured blast radius.** Re-grading all 3,500 stored attempts in this
repository with all four repairs flips **exactly one**:

```
bench/jobs/repro-champion  dev-002  (total_comments, CANARY, want 228)
  "The total number of comments stored across all issues is 228."
```

`repro-champion` is the run behind the repo's central honesty finding — the
champion re-run at 98.10% instead of 100% on byte-identical source. Its stored
`score.canaryPass` is **`false`**, and the harness's own contract is *"a canary
failing means the HARNESS is broken, not the agent."* It was reported as a valid
measurement regardless. Corrected: **98.10% → 99.05%**, `canaryPass` → true. Its
remaining failures are real — `closed_count` answering *"There are currently no
closed issues"* (the enum defect, live in the champion) and one judge-noise
semantic.

**No headline result moves.** `baseline-n3`, `h9-confirm`, `holdout-final`,
`base-dev`, `champ-dev`, `base-holdout`, `champ-holdout` all flip zero attempts.
The 94.29 → 100 claim stands exactly as published.

`analyze.ts` recomputes deterministic outcomes from stored answers rather than
reading them out of the report, so a future grader repair costs nothing to apply
retroactively. Judge verdicts were model calls and are taken as recorded.

## Grading extraction

`score-extraction.ts` runs against a loaded graph with **no API spend** and does
three things:

1. **Dumps** every `Solution` / `Workaround` / `Category` / `Competitor` /
   `Keyword` node to `jobs/<job>/extraction.json`. Nothing in the repo contained
   a single extracted string before this: extracted text reaches Neo4j as a
   Cypher *parameter*, and the harness records statements without parameters.
2. **Grounding precision** — the share of extracted strings whose words actually
   occur in the issue. A cheaper model that starts inventing shows up here.
3. **Patch-module recall** — SWE-bench links each issue to the PR that fixed it,
   so the gold patch names the modules that mattered. Scored only over issues
   where a gold module token also appears in the issue text (65% of linked sympy
   issues); anything else would be scoring clairvoyance.

Read recall as a **comparison, not a grade**: it is lexical, and extraction names
concepts where a patch names files — `"CaseInsensitiveDict"` for an issue whose
patch touched `requests/structures.py` is the same answer in two vocabularies and
scores as a miss. Its use is holding the corpus fixed and moving the extraction
model, which is the experiment the repo says it cannot currently run.

## Commands

```bash
# --- free gates. Nothing below spends until run.ts is invoked with --job -----
bun verification_bench/derive.ts --check         # derived files have not drifted
bun test verification_bench/grade-v2.test.ts     # the four grader repairs
bun verification_bench/verify-all.ts             # the existing 10-step gate
bun verification_bench/verify-sut-switch.ts      # 4 arms, distinct, pinned

# per split: ingest for free, then re-derive every frozen answer with
# independently written Cypher
bun verification_bench/smoke.ts            --split skl-dev
bun verification_bench/verify-oracles-v2.ts --split skl-dev
bun verification_bench/verify-oracles-v2.ts --all     # needs the right graph loaded

# --- one-shot builders. Output is frozen and pinned in SPLITS.sha256 ---------
GITHUB_TOKEN=... bun verification_bench/scripts/build-corpus-v2.ts \
  --repo scikit-learn/scikit-learn --split skl-dev
bun verification_bench/scripts/build-tasks-v2.ts            # all splits

# --- scored runs ------------------------------------------------------------
bash verification_bench/run-v2-matrix.sh                    # the whole 2x2
SPLITS="astropy-holdout" bash verification_bench/run-v2-matrix.sh   # sealed holdout
bash verification_bench/run-v2-sealed.sh                   # A/D/E on sealed pylint
bash verification_bench/run-v2-regression.sh               # E vs D across the dev set

# --- reading results --------------------------------------------------------
bun verification_bench/analyze.ts
bun verification_bench/analyze.ts --arms A-baseline,D-champion-enum
bun verification_bench/analyze.ts --regrade bench/jobs/repro-champion
bun verification_bench/score-extraction.ts --split skl-dev --job A-baseline__skl-dev
```

Jobs are named `<arm>__<split>`; `analyze.ts` matches on that.

A new worktree needs a `node_modules` symlink or preflight's typecheck fails —
the fingerprint skips `node_modules`, so the link does not change the arm:

```bash
git worktree add .worktrees/baseline-enum f5b3184
ln -s ../../../github_issue/node_modules .worktrees/baseline-enum/github_issue/node_modules
```

## What this still does not do

- Corpus semantics differ from the frozen sympy corpus (the open-issue
  supplement), so **absolute** accuracy is not comparable across generations.
  Paired within-corpus arm deltas are.
- Extraction metrics are proxies for grounding and topical recall, never for
  whether an extracted solution is correct. No oracle here can do that.
- `stableTerms` mines generic tokens on any corpus, a known weakness of
  `text_search` that v2 inherits unchanged.
- `req-dev` under-fills `label` and `multi_hop` by construction (three labels
  across its open issues); its per-stratum intervals are wide and are reported
  that way rather than pooled.
- One pass at three attempts gives attempt-level variance, not run-level. The
  old campaign's spread came from re-running whole jobs; that would cost roughly
  another $21 per pass.

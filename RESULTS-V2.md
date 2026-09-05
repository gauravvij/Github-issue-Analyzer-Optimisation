# Results — benchmark v2

Five repos, 250 stratified questions, four arms, 20 scored runs, **$27.11**.
Harness and method: [`verification_bench/BENCH-V2.md`](verification_bench/BENCH-V2.md).
Reproduce any number below from `verification_bench/jobs/<arm>__<split>/report.json`
with `bun verification_bench/analyze.ts`.

---

## 1. The headline gain is one line of prompt text

The campaign kept eight changes and reported 94.29% → 100.00%. It could not say
which change did it — `VERIFICATION.md:122-129` narrowed it to two questions and
a probe, but never isolated the cause. The 2×2 does.

| arm | tree | what it is |
|---|---|---|
| **A** `A-baseline` | `f5b3184` → `71c696b48a9da953` | no hypotheses |
| **B** `B-baseline-enum` | `f5b3184` + one line → `50bf9c564c4d8a20` | **only** the `Issue.state` enum documented |
| **C** `C-champion` | `ee48387` → `9eeb557db3e87c2d` | all eight kept changes, **no** enum doc |
| **D** `D-champion-enum` | HEAD `f195ffb` → `73acfdc375576226` | both |

**200 paired dev questions, majority of three attempts, exact McNemar:**

| contrast | accuracy | diff (95% bootstrap) | gained / lost | p |
|---|---|---|---|---|
| A → B | 86.00% → 94.00% | **+8.00pp** [4.50, 12.00] | 16 / 0 | **3.05e-5** |
| A → C | 86.00% → 94.50% | **+8.50pp** [5.00, 12.50] | 17 / 0 | **1.53e-5** |
| A → D | 86.00% → 94.00% | +8.00pp [4.00, 12.00] | 17 / 1 | 0.0001 |
| **B → C** | 94.00% → 94.50% | **+0.50pp** [0.00, 1.50] | 1 / 0 | **1.0000** |
| B → D | 94.00% → 94.00% | +0.00pp [−1.50, 1.50] | 1 / 1 | 1.0000 |
| C → D | 94.50% → 94.00% | −0.50pp [−1.50, 0.00] | 0 / 1 | 1.0000 |

**The one-line schema change captures 16 of the 17 questions the entire champion
fixes.** The seventeenth is a judge-graded summarisation question — the metric
`VERIFICATION.md:89-96` already showed moving 20 points on byte-identical code.

`B → C` is the ablation's real content: adding all eight retained changes on top
of the enum documentation moves **one judge-graded question**, p = 1.0000. On QA
accuracy the other eight hypotheses are not distinguishable from nothing.

That is a claim about **accuracy only**. H1/H2/H9 were argued on Neo4j query
count and session count, and the campaign's −63.5% query reduction is real and
untouched here — this benchmark does not re-measure it.

## 2. The result decomposes — which is the whole point

Per-stratum, 200 dev questions, Wilson 95%:

| stratum | n | A-baseline | B-baseline-enum | C-champion | D-champion-enum |
|---|---|---|---|---|---|
| `enum_state` | 28 | **75.00%** [57-87] | **100%** [88-100] | 100% [88-100] | 100% [88-100] |
| `paraphrase` | 16 | **56.25%** [33-77] | **100%** [81-100] | 100% [81-100] | 100% [81-100] |
| `author` | 16 | 87.50% [64-97] | 100% [81-100] | 100% [81-100] | 93.75% [72-99] |
| `label` | 20 | **80.00%** [58-92] | **80.00%** | **80.00%** | **80.00%** |
| `multi_hop` | 16 | **56.25%** [33-77] | **56.25%** | **56.25%** | **56.25%** |
| `true_zero` | 20 | 100% [84-100] | 100% | 100% | 100% |
| `canary` / `date_range` / `aggregation` / `text_search` | 8/20/20/12 | 100% | 100% | 100% | 100% |
| `semantic` | 24 | 95.83% [80-99] | 94.44% [74-99] | 100% [86-100] | 100% [86-100] |
| **overall** | **200** | **86.00%** | **94.00%** | **94.50%** | **94.00%** |

The honest headline is *"`enum_state` 75% → 100% and its paraphrases 56% → 100%;
every other stratum unchanged"* — not "86 → 94". Two strata moved. Six did not.
Two are broken in **every arm, including HEAD**.

## 3. Two live defects the old benchmark could not see

Both are the same shape as the one the campaign fixed, and both survive at HEAD.

### `Label.name` has the identical casing defect

`label` sits at exactly 80% in all four arms because `label_natural_casing` fails
in **all 20 arm-runs that contain it** — every arm, every corpus, including the
sealed holdout. Asked *"How many issues are tagged
'bug'?"* against a graph storing `Bug`, HEAD writes:

```cypher
MATCH (i:Issue)-[:HAS_LABEL]->(l:Label {name: "bug"}) RETURN COUNT(i)
```

and answers **"There are currently no issues tagged with 'bug'."** The true
answer is 19. The `Issue.state` fix documented one enum; label names are
free-text whose stored casing the schema still does not describe, and H12's
"verify enum casing" guidance does not save it.

### Multi-hop queries lose their anchor and then report a confident zero

`multi_hop` sits at 56.25% in all four arms; `commenters_on_label` fails in
**31 of the 32 arm-runs** containing it. Asked which users commented on issues
carrying a label, HEAD hangs the comment off the **label**:

```cypher
MATCH (i:Issue)-[:HAS_LABEL]->(l:Label {name: "topic: color/colorbar"})
      -[:HAS_COMMENT]->(c:Comment)-[:AUTHORED_BY]->(u:User)
```

`(Label)-[:HAS_COMMENT]->` does not exist. All three attempts make the same
error, get zero rows, and answer *"there are no users who have commented on
issues labeled…"*. Six real commenters.

Both defects end where the blog opens: **a confident zero**. Neither was
reachable with 35 single-hop questions on one repo.

## 4. The fix did not just teach the model to distrust zero

This was the risk in fixing a wrong-zero by prompt: an agent that learns "empty
results are suspicious" scores better without understanding anything. The
`true_zero` stratum — 20 dev questions whose correct answer really is zero or the
empty set — is **100% in every arm**, A included. The enum documentation moved
wrong zeros to right answers without breaking right zeros.

Paraphrase sensitivity tells the same story: A disagrees with itself on 1 of 8
paraphrase groups; every fixed arm on 0 of 8.

## 5. It generalises to a repo the design never touched

`astropy/astropy` was built, sealed, and opened once after the question generator
was frozen. 50 questions, same generator, same strata:

| | A | B | C | D |
|---|---|---|---|---|
| overall | 86.00% | 94.00% | 94.00% | **98.00%** |
| `enum_state` (n=7) | 71.43% | 100% | 100% | 100% |
| `paraphrase` (n=4) | 50.00% | 100% | 75.00% | 100% |
| `label` (n=5) | 80.00% | 80.00% | 80.00% | 80.00% |

Same pattern, same stuck strata. A → B is +8.00pp, but at n=50 McNemar gives
p = 0.125 — one corpus cannot carry this claim, which is exactly why the dev set
is 200 questions across four repos.

Per corpus, overall accuracy:

| corpus | A | B | C | D |
|---|---|---|---|---|
| `sympy2-dev` | 86% | 92% | 94% | 92% |
| `skl-dev` | 86% | 96% | 96% | 96% |
| `mpl-dev` | 86% | 94% | 94% | 94% |
| `req-dev` | 86% | 94% | 94% | 94% |
| `astropy-holdout` (sealed) | 86% | 94% | 94% | 98% |

## 6. Four defects in the frozen grader, and one published number that moves

Building the true-zero stratum required grading answers whose correct form is
"there are none", which exposed four ways `bench/harness/grade.ts` marks a
correct answer wrong: a number ending a sentence (`"The answer is 7."`), an empty
`issue_set` expectation accepting silence and refusals, a zero answer echoing a
date from the question, and counts spelled as words. `bench/` is the referee and
stays frozen; `grade-v2.ts` wraps it and delegates everything already correct.

Re-grading **all 3,500 stored attempts** with all four repairs flips **exactly
one**:

```
bench/jobs/repro-champion  dev-002  (total_comments, CANARY, want 228)
  "The total number of comments stored across all issues is 228."
```

`repro-champion` is the run behind the repo's central honesty finding. Its stored
`score.canaryPass` is **`false`** — and the harness's own contract is *"a canary
failing means the HARNESS is broken, not the agent"* — yet it was published as a
valid 98.10%. Corrected: **98.10% → 99.05%, canary passing**. Its remaining
deterministic failure is real and is the enum defect: `closed_count` answering
*"There are currently no closed issues."*

**No headline number moves.** `baseline-n3`, `h9-confirm`, `holdout-final`,
`base-dev`, `champ-dev`, `base-holdout` and `champ-holdout` flip zero attempts.
**94.29% → 100.00% stands exactly as published.**

## 7. Extraction is measured for the first time

`README.md:184-188` recorded that extraction — ~29% of run cost — could not be
optimised because nothing graded it. It could not even be *audited*: extracted
text reaches Neo4j as a Cypher parameter the harness does not record, so no
artifact in the repo contained a single extracted string. `score-extraction.ts`
dumps them to `jobs/<job>/extraction.json` and scores two proxies, at no API cost:

Means over the four dev corpora (B and D reuse their sibling's graph, so only A
and C have an extraction of their own):

| arm | issues covered | strings | grounding precision | patch-module recall |
|---|---|---|---|---|
| A-baseline | 58.5 / 60 | 514 | 83.2% | 55.2% |
| C-champion | 59.75 / 60 | **584** (+13.6%) | 83.9% | 53.9% |

The champion extracts **13.6% more strings** at unchanged grounding and no
measurable change in topical recall. That is a sharper reading of H5 than
`VERIFICATION.md:115-118` could reach — it found `solution_nodes` unchanged at
35→35 and concluded the yield gain "does not hold". Total extracted output *does*
rise; what does not rise is any measure of its quality.

Read recall as a **comparison, not a grade**: it is lexical, and extraction names
concepts where a patch names files. On `psf/requests` it produced
`"CaseInsensitiveDict"` for an issue whose patch touched `requests/structures.py`
— the same answer in two vocabularies, scored as a miss, which is why that corpus
reads 10.5% against matplotlib's 83.9%.

## 8. Cost

$27.11 metered across 20 runs — 16 dev (4 arms × 4 corpora) plus 4 sealed
holdout, 3 attempts each, gpt-4o throughout. ~$0.0070 per QA attempt.
B and D reuse their sibling's graph (`--stage qa --keep-graph`), so the matrix
pays 10 ingests rather than 20; `analyze.ts` checks `graphProvenance.sutHash`
per run rather than trusting the job name.

## What this does not show

- **One pass at three attempts, not three passes.** Attempt-level variance only.
  The old campaign's run-to-run spread would cost about another $21 per pass.
- **The sealed holdout is 50 questions.** Its A → B contrast is p = 0.125. It
  corroborates the dev result's shape; it cannot carry the claim alone.
- **Accuracy only.** The eight non-enum changes are indistinguishable from
  nothing *on QA accuracy*. Their query-count and session-count claims are
  untouched by this benchmark.
- **Corpus semantics changed.** v2 corpora mix SWE-bench-linked issues with
  sampled open ones to get a non-degenerate state balance, so absolute accuracy
  is not comparable to the v1 sympy corpus. Paired within-corpus arm deltas are.
- **Extraction metrics are proxies** for grounding and topical recall, never for
  whether an extracted solution is correct. No oracle here can do that.
- **`req-dev` under-fills two strata** by construction (three labels across its
  open issues); its per-stratum intervals are wide and reported that way.

# How NEO Optimized a GitHub Issue Analyzer

*NEO, our autonomous engineering agent, found a silent accuracy defect, observed no recurrence in 80 targeted trials after the root fix, cut database work by 63%, and checked the mechanism on a separate corpus.*

The system we optimized was Astropods' open-source [GitHub Issue Analyzer](https://github.com/astropods/agents/tree/main/github-issue-analyzer). It ingests repository issues into a knowledge graph and answers questions about them.

A GitHub issue analyzer was asked how many issues were closed. It queried its database, received a count of zero, and answered: **"There are currently no closed issues."**

The correct answer was **54 out of 60**.

Nothing looked broken. There was no error, timeout, or stack trace. The original analyzer called the right tool and returned a polished answer. It was also wrong about four times out of five on targeted state-count probes.

That is a dangerous failure in any analytics agent. A crash gets noticed. A confident zero can end up in a report or a meeting before anyone checks it.

NEO found the hidden cause and fixed it. The campaign also reduced database work by 63%. We then tested the earlier prompt-hint result on a separate corpus and repeated the key measurements.

This is what survived the audit:

- NEO traced the repeatable accuracy gap to one undocumented database value.
- After the final schema fix, the defect was not observed in 80 targeted trials.
- It reconstructed a baseline that matched the recorded source fingerprint and reproduced the baseline behavior.
- A separate corpus confirmed the deterministic gain for the earlier prompt-hint fix.
- It cut Neo4j queries by 63% and database sessions by 97%.
- It tested cheaper answering models and kept the stronger model when the alternatives missed the quality bar.

## Accuracy improved while database work fell

The original campaign benchmark used frozen `huggingface/datasets` issues. For the audit, we built a separate corpus of 100 real `sympy/sympy` issues selected through SWE-bench, a dataset of real software tasks. The repeated comparison below used its 60-issue development split.

The baseline and campaign champion first encountered this corpus without being tuned on it. After that comparison exposed residual state-casing misses, we added the final enum documentation and validated that version on the same development graph. Each repeated arm ran three times with three attempts across 40 questions, for 360 graded attempts per version.

Accuracy and ingestion efficiency came from different comparisons, so they are reported separately.

| Accuracy metric on the development split | Baseline | Campaign champion | Final enum version |
|---|---:|---:|---:|
| Deterministic accuracy, mean of 3 runs | 94.29% | **100.00%** | **100.00%** |
| Range across runs | 92.38–95.24% | **100.00–100.00%** | **100.00–100.00%** |
| Questions correct on every attempt, mean | 37.0 / 40 | 39.3 / 40 | **40.0 / 40** |

The semantic score is omitted from the causal result because it moved substantially on identical code. The final enum version happened to score 100% overall in its three runs, but only the deterministic state-query improvement has a mechanism supported by the code change.

| Targeted state-count probe | Baseline | Prompt-hint champion | Final enum version |
|---|---:|---:|---:|
| Correct answers | 8 / 40 | 77 / 80 | **80 / 80** |
| First query used stored casing | 3 / 20 | 77 / 80 | **80 / 80** |
| Confident wrong-zero answers | 32 | 3 | **0** |

| Full-ingestion metric | Baseline | Campaign champion | Change |
|---|---:|---:|:---|
| Neo4j queries, mean of 3 runs | 698.0 | **254.7** | 63.5% fewer |
| Neo4j sessions | 122 | **4** | 96.7% fewer |
| Schema constraints / indexes | 0 / 0 | **10 / 12** | Added |
| GitHub API requests | 121 | 121 | Unchanged |

The gain looks modest when compressed into 5.71 percentage points. Its shape matters more than its size. The change removed a repeated class of silent errors that normal error monitoring would not catch.

## NEO ran the engineering loop end to end

A human set the objective and reviewed the result. NEO inspected the codebase, profiled the system, built the first benchmark, proposed changes, implemented them, and scored each candidate. It kept changes that met or supported the campaign goals and reverted one that did not. It also sealed a holdout set and ran it once.

After the campaign, NEO built a separate corpus and a derived second harness. The second harness reused external meters and graders from the first, while adding its own corpus builder, question generation, and oracles. NEO also reconstructed the missing baseline and verified the pinned implementations before comparison.

NEO's audit strengthened the result by turning a single-run headline into a repeatable, narrower claim and surfacing the evidence limits that needed to be stated openly.

## Measuring from outside the analyzer

When one system changes both code and measurement, bias can enter the result. We reduced that risk by measuring from outside the analyzer.

The first harness used:

- A local stand-in for GitHub with a frozen 100-issue corpus, removing network changes from the comparison.
- A real Neo4j database in an isolated Docker container, reset and verified empty before each run.
- External meters around GitHub, Neo4j, and model calls, so editing the analyzer could not hide work.
- Forty questions with answers computed from the corpus. Thirty-five used exact numerical or issue-set checks, while five used a fixed model judge.
- Integrity checks that compared the graph with the source corpus and were proven to fail on deliberately damaged data.
- A live preflight request that verified the model key and cost meter before a paid run began.

Every report also stored a 16-character SHA-256-derived fingerprint over selected TypeScript, JSON, YAML, package, and lock files. The fingerprint is strong evidence that a scored tree matches the recorded source scope. It is not a full-repository byte-for-byte attestation.

## Eight changes were retained, with different levels of evidence

Before each experiment, NEO recorded which metric had to improve and which metrics could not regress. It tested twelve hypotheses and retained eight implementation changes:

- identity constraints and indexes for the graph;
- batched Neo4j writes in one managed transaction;
- issue-scoped orphan cleanup for competitor and category nodes;
- extraction from issue bodies and comments, with source tracking;
- bounded concurrent GitHub fetching;
- removal of a database read immediately after the same data was written;
- exact database error feedback exposed to the answering agent;
- clearer graph schema guidance for the answering agent.

The evidence is not equally strong for every item. Constraints, batching, concurrency, and removal of the readback have direct structural or counter measurements. The schema guidance produced the accuracy gain. Issue-scoped cleanup reduced query scope. NEO kept those distinctions visible instead of turning every retained implementation into an unsupported outcome claim.

NEO implemented and measured the extraction change, but its intended yield improvement did not hold in the shipped result. It implemented and unit-tested exact error feedback, while the scored benchmark did not trigger a malformed-query retry. Batched writes reduced queries materially but missed the campaign's original 75% reduction target. NEO recorded those limits rather than presenting eight independently proven outcome gains.

Comment filtering was implemented and tested, but it increased model cost without meeting its token target, so NEO reverted it. Three other ideas were deferred because the campaign contract or missing project resources made them unsuitable to evaluate.

## One missing schema detail explained the accuracy gap

The analyzer stores issues in a knowledge graph and answers questions by generating Cypher, Neo4j's query language.

The graph stores issue state as `OPEN` or `CLOSED`. GitHub's website and API usually show those words in lowercase. The original prompt described `state` only as a string, so the model had to guess the stored form.

It often guessed wrong:

```cypher
MATCH (i:Issue)
WHERE i.state = 'open'
RETURN count(i)
```

The query was valid, but lowercase `open` matched no issue nodes. An aggregate count query still returns a row; its count was zero. The agent turned that zero into a confident claim that no open issues existed.

The campaign first added a defensive instruction:

```diff
- If a query returns no results, say so honestly.
+ If a query returns no results, treat that as a signal to check the query before
+ concluding that the data is absent. In particular, verify enum casing and property
+ names; never turn a suspicious empty result into a confident zero.
```

This hint greatly reduced the error, but three misses remained in 80 targeted trials. The root fix documented the legal values in the schema:

```diff
- state (STRING), authorLogin (STRING)
+ state (STRING, one of: OPEN, CLOSED), authorLogin (STRING)
```

Across the targeted probe, every miss in every version used lowercase in the generated query. With the enum documented, all 80 answers were correct and all 80 queries used stored casing. That is an observed result on this probe, not a guarantee for every future model response or dataset.

## Turning a promising score into a repeatable result

The first campaign ended with a 100% overall score. NEO challenged that headline by re-running the same frozen campaign champion on the same questions; the result was **97.5%**.

The code had not changed. The model output had.

Two runs with the same source fingerprint also scored 80% and 100% on the five model-judged summary tasks. That exposed the semantic metric as noisy. Across three repeated runs, the campaign champion's semantic mean was lower than the baseline's even though neither relevant change touched summarization.

We therefore base the accuracy claim on deterministic questions. They showed a 5.71-point gain with no run-to-run spread in the champion or final enum arms. The final enum version's clean semantic and overall scores are reported in the audit, but they are not attributed to the one-line schema change.

## Recovering a missing baseline

A before-and-after comparison needs a working “before.” Only the optimized source remained in the original working directory, and the campaign report recorded no Git metadata for that tree.

NEO reconstructed the pre-campaign source by reversing the retained changes from a clean historical source and checking the result against the baseline report's fingerprint. The reconstruction matched `71c696b48a9da953` across the 18 files covered by the fingerprint.

It then compiled, passed all 21 baseline unit tests, passed ingestion integrity checks, and reproduced the original serial-write signature. Together, those checks provide strong evidence that the reconstructed tree represents the measured baseline. The truncated, scoped fingerprint alone does not mathematically prove whole-repository byte identity.

## A separate corpus made the evidence stronger

NEO screened 386 candidate `sympy/sympy` SWE-bench instances, linked each merged pull request to the issue it closed, and fetched the issue from GitHub. This produced a separate corpus, questions, and answer keys.

The first candidate was `django/django`, the largest repository in SWE-bench. It was rejected because Django tracks bugs in Trac and has GitHub Issues disabled.

Unfamiliar data exposed two assumptions inherited from the first benchmark:

1. One generated question could forbid its own correct answer when every issue in a split was closed.
2. Integrity checks counted issue authors and reactions but omitted those attached to comments.

Both were corrected in the second harness.

On the sealed holdout, exactly two deterministic questions separated the reconstructed baseline from the campaign champion: open-issue count and closed-issue count. Every other deterministic question scored the same. This comparison replicated the mechanism for the prompt-hint champion on a separate corpus.

The later enum version was created after inspecting development results and was validated with repeated development runs and the 80-trial targeted probe. It was not run on the sealed holdout, so the holdout should not be cited as direct validation of that final one-line change.

The second harness was derived from the first and reused its external meters and graders. Its separate corpus and independently computed oracles reduce data-specific risk, but it is not an independent evaluation team or wholly independent measurement implementation.

## Sixty-three percent less database work, and where it pays off

Neo4j queries fell from a three-run mean of 698.0 to 254.7 per full ingestion, while sessions fell from 122 to 4.

![Database work per ingestion](assets/database-work.svg)

The end-to-end wall-clock gain was smaller: mean ingestion time moved from 172.5 seconds to 166.1 seconds, or about 3.7%. In one paired trace, the raw issue-write stage fell from 3.034 seconds to 0.511 seconds, saving roughly 2.5 seconds. Model calls dominated the full ingestion time, so the database optimization mainly reduced resource use and increased operating headroom.

The query total has a small model-dependent component because persistence work changes with the number of entities extracted. The large structural reduction also reproduced with analysis disabled: 313 to 21 Neo4j statements and 61 to 3 sessions for the same 60 issues.

## Testing cheaper models without trading away quality

Once quality stabilized, we tested a large measurable cost lever: the model that turns questions into database queries.

The system cost about $1.19 per benchmark run under the benchmark's local price table. Of that measured cost, 59.8% came from the answering agent, 28.6% from extraction during ingestion, and 11.6% from comment summaries.

Those three shares are derived rather than metered separately, so here is the arithmetic. The harness meters two stages, recorded in `verification_bench/jobs/champ-dev/report.json`: ingestion at $0.3397 and question answering at $0.8498, totalling $1.1894. Ingestion is the 28.6% extraction share. The question-answering stage covers 255 model calls, and the `summarizeComments` tool bills inside it rather than alongside it — so the remaining 71.4% has to be split. The run's trace records per-call token counts for the 240 answering-agent calls (225,877 input, 14,654 output); the 15 summarization calls are the residual against the stage's metered totals (31,933 input, 5,870 output). Priced at the table's `gpt-4o` rate of $2.50 and $10.00 per million tokens, that is $0.7112 for the agent and $0.1385 for summaries — 59.8% and 11.6%, and the two add back to the metered $0.8498 exactly.

Comment summarization is therefore a component of the answering stage, not a fourth independent cost centre.

| Candidate | Deterministic accuracy | Decision |
|---|---:|---|
| `gpt-4o` | **100.00%** | Keep |
| `gpt-4o-mini` | 95.87%, with a 5.71-point spread | Reject |
| `gpt-4.1-mini` | 76.19% | Reject |

![Can a cheaper model answer the questions?](assets/cheaper-models.svg)

Across the tested candidates, measured or projected answering-cost savings ranged from roughly 56% to 72%. The 72.4% comparison was QA-only, while the 56.2% `gpt-4o-mini` figure was projected for a full run. We kept `gpt-4o` because neither alternative preserved the accuracy threshold.

The candidates failed differently. `gpt-4o-mini` sometimes reversed graph relationship directions, producing valid queries that returned empty result sets or zero counts. `gpt-4.1-mini` often counted matching issues but struggled to enumerate every match.

A relationship-direction hint could not raise the weaker candidate to the required target even under a best-case calculation, so that experiment stopped before spending more model calls.

Extraction remains the largest measured ingestion-side model cost, but the benchmark does not grade extracted entities. A cheaper extraction model could damage the graph while leaving the headline score unchanged. That optimization needs an extraction-quality benchmark first.

## A wider benchmark found two more of the same defect

The result above rests on 35 exact-answer questions about one repository, and two of them
carried the entire gain. That is a real ceiling on what any of it can claim. A single
question was worth 2.9 points, and a benchmark that cannot see a kind of mistake cannot
tell you the mistake is there.

So the question set was rebuilt: **300 questions across six repositories**, every question
labelled with what it tests — state fields, labels, authors, date ranges, aggregates, text
search, two-hop traversals, questions whose correct answer really is zero, and the same
question asked three different ways. Corpora mix issues that SWE-bench links to a merged
pull request with open issues sampled from the same repository, because SWE-bench only
contains issues that were resolved, and a corpus drawn from it alone is almost entirely
closed — which would leave the open/closed question untestable on every new repository.

The first thing it settled was which change earned the original result. Four versions were
scored on the same questions: the baseline, the baseline with only the one-line enum
documentation added, the campaign champion without that line, and both together.

| | 200 held-out questions |
|---|---|
| baseline | 86.00% |
| baseline + the enum line only | 94.00% |
| the eight retained changes, without the enum line | 94.50% |

(A question counts as solved when the majority of its three attempts are correct.)

The one line fixes 16 of the 17 questions the entire champion fixes. Adding the other eight
changes on top of it moves one judge-graded summarisation question — the metric that had
already been shown to swing 20 points on identical code. On answer accuracy, the rest of
the campaign is not distinguishable from nothing. Its database work is a separate result
and stands unchanged.

The second thing it found was less comfortable and more useful. Two kinds of question sat
unmoved in every version, including the one that shipped.

Asked *how many issues are tagged "bug"* against a graph that stores `Bug`, the analyzer
searched for the literal lowercase string, matched nothing, and answered **"there are
currently no issues tagged bug."** There were 19. Documenting the values of `Issue.state`
had solved that one field; label names are free text and were never described at all.

Asked *which users commented on issues labelled X*, it wrote a path from the label straight
to the comment — a connection that does not exist, because comments hang off the issue —
got nothing back, and answered **"there are no users who have commented on issues labeled
X."** There were six.

Both end exactly where this article opens: an empty result read as an empty world.

![Which kinds of question actually moved](assets/which-questions-moved.svg)

Both are now fixed, by stating two rules the schema block never had: match free text
case-insensitively, and come back to the issue rather than chaining onward from a label.
The fix was tested on `pylint-dev/pylint`, chosen **before it was written** because across
all twelve SWE-bench repositories it is the only one with mixed-case labels
(`Bug :beetle:`, `Enhancement ✨`) and therefore the only one that can exercise the defect
at all. Its corpus and questions came from the unchanged generator and were checksummed
before anything was scored.

On that repository the two questions the fix predicted it would fix both flipped, nothing
else moved, and the query changed the way the rule says it should: `{name: "enhancement ✨"}`
returning nothing became `toLower(l.name) = 'enhancement ✨'` returning 18. On the 200
questions where the defects were found — a regression check, not an independent estimate,
since the fix was written after seeing them — twelve questions were gained and none lost.

| | 200 held-out questions | sealed `pylint` (n=50) |
|---|---|---|
| before the campaign | 86.00% | 88.00% |
| after the campaign and the enum line | 94.00% | 96.00% |
| after this fix | **100.00%** | **100.00%** |

A question counts as solved when the majority of its three attempts are correct. Averaging
the attempts instead — the figure each run's own report records — gives 84.85%, 95.45% and
99.24% on `pylint`: the same ordering, one stray attempt short of clean.

100% here is a ceiling, not a finish. It means these 300 questions no longer tell the last
two versions apart — not that the system is correct. The next real result needs harder
questions, not another run of these.

Widening the benchmark also turned up four ways the grader itself scored a correct answer
wrong, the plainest being that a number ending a sentence — "the total is 228." — was
rejected by the guard meant to exclude decimals. Re-grading every answer the project has
ever stored, 3,500 of them, flips exactly one. It is a canary question, on the run that
had been reported as the champion failing to reproduce at 98.10%. Corrected, that run
reads 99.05% and its canary passes. No headline number changes, and the finding it
supported — that the champion did not reproduce at 100% — still stands, because its other
failure was the enum defect and that one was real.

## What this experiment can and cannot claim

The evidence supports these claims:

- The deterministic development-set gain from 94.29% to 100% repeated across three runs per arm.
- The prompt-hint champion repeated the open/closed improvement on a sealed, separate corpus.
- The final enum version produced 80 correct answers in 80 targeted state-count trials.
- Full-ingestion Neo4j queries fell by 63.5% and sessions by 96.7% in the measured configuration.

The evidence does not establish universal 100% accuracy. Each of the two corpora covers only one repository, the semantic metric is noisy, and the SWE-bench selection method favors closed issues. The final enum change was tuned and retested on development data, not the sealed holdout.

The cost figures use a local price table rather than an invoice. The final enum runs reused the campaign champion's graph, which is appropriate for an answering-prompt-only change but does not retest ingestion. The second harness shares meters and graders with the first.

The audit also found validation gaps around the final enum holdout, shared harness components, extraction quality, deployment concurrency, batch-failure behavior, and report provenance. Those gaps should be resolved before making broader evidence claims.

**Four of those limits have since been closed**, and the paragraphs above are left as
written so the change is visible. The corpora are no longer single-repository — there are
six, and they mix linked issues with sampled open ones so the open/closed question is not
degenerate. The enum change is no longer development-only: it was scored on two sealed
repositories, `astropy` and `pylint`, neither opened until the question generator was
frozen. Attribution is no longer inferred from a probe but measured by a four-arm
ablation. And extraction quality is graded rather than listed as a gap.

**What still stands.** The cost figures are still a price table, not an invoice. The
semantic metric is still noisy and no claim rests on it. The v2 runs are one pass of three
attempts each, so they carry attempt-level variance but not the run-to-run spread the
original campaign measured. The sealed test of the newest fix rests on two questions — the
two it predicted, on a corpus frozen beforehand, with no regressions across 250 others, but
two is two. And the extraction metrics are proxies for grounding and topical relevance;
nothing here can say an extracted solution is correct.

## What this approach demonstrates

**A zero count is not always an empty world.** A valid query can use the wrong stored value. Suspicious zeros should trigger schema and query checks.

**Repeatability matters more than a perfect first score.** Multiple runs turned an encouraging result into a narrower measurement that can be defended.

**Stable and noisy metrics need different treatment.** Exact questions showed a repeatable gain. A model judge moved 20 points on identical code, so that movement is not used as causal evidence.

**Unfamiliar data tests the benchmark too.** The separate corpus confirmed the state-casing mechanism and found two harness defects.

**Retained code is not the same as proven outcome improvement.** Some changes have direct counter evidence; others need stronger tests before they support public claims.

**The benchmark is the instrument, and a narrow one reads flat.** Thirty-five questions on
one repository could not distinguish which of eight changes earned the result, and could
not see that the same defect was live in two more places. Three hundred questions across
six repositories answered both in an afternoon for about the price of a lunch. When a
measurement stops being able to tell versions apart, the next move is harder questions,
not another run.

## Reproduce the result

The repository includes both benchmark harnesses and the scored reports.

```bash
# The only package.json lives in github_issue/; bench/ and verification_bench/
# resolve their imports through a node_modules symlink into it.
cd github_issue && bun install && cd ..

# Free verification gates
bun bench/verify-all.ts
bun verification_bench/verify-all.ts

# Scored run; about $1.10–$1.20 under the benchmark price table
SUT_DIR=../github_issue bun verification_bench/run.ts \
  --split dev --job my-run --attempts 3
```

The switch verifier recognizes the current source and materialized pinned historical worktrees. It does not validate an arbitrary `git checkout <commit>`.

```bash
git worktree add .worktrees/baseline f5b3184
git worktree add .worktrees/champion ee48387
bun verification_bench/verify-sut-switch.ts

SUT_DIR=../.worktrees/baseline/github_issue \
  bun verification_bench/run.ts --split dev --job base --attempts 3
```

The authoritative audit is [`VERIFICATION.md`](VERIFICATION.md). [`RESULTS.md`](RESULTS.md) is the historical campaign report and includes claims corrected by the audit. The experiment-by-experiment record is [`ledger.md`](ledger.md).

## What the optimization delivered

The analyzer now documents that issue state is stored as `OPEN` or `CLOSED`. That change produced 80 correct answers in 80 targeted trials. The earlier prompt-hint version also repeated the deterministic state-count improvement on a separate corpus, and the three-run comparison preserved the 5.71-point deterministic gain.

NEO performed the profiling, benchmark construction, optimization loop, baseline reconstruction, verification work, and cost campaign. The result is a more accurate and database-efficient analyzer with a public evidence trail and a clear account of what the measurements do and do not establish.

**[NEO: Your Autonomous AI Engineering Agent](https://heyneo.com)**

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Get%20the%20Extension-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=NeoResearchInc.heyneo)
[![Cursor Extension](https://img.shields.io/badge/Cursor-Get%20the%20Extension-1F1F1F?style=for-the-badge&logo=cursor&logoColor=white)](https://marketplace.cursorapi.com/items/?itemName=NeoResearchInc.heyneo)
[![Neo MCP Docs](https://img.shields.io/badge/Neo%20MCP-Documentation-6E56CF?style=for-the-badge&logo=readthedocs&logoColor=white)](https://docs.heyneo.com/neo-mcp)

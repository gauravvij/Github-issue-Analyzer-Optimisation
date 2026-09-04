# How NEO Optimized a GitHub Issue Analyzer

*Our autonomous engineering agent eliminated a silent accuracy defect, cut database work by 63%, and independently verified the result.*

A GitHub issue analyzer was asked how many issues were closed. It queried its database, found no matching rows, and answered: **"There are currently no closed issues."**

The correct answer was **54 out of 60**.

Nothing looked broken. There was no error, timeout, or stack trace. The original analyzer called the right tool and returned a polished answer. It was also wrong about four times out of five.

That is a dangerous failure in any analytics agent. A crash gets noticed. A confident zero can end up in a report or a meeting before anyone checks it.

NEO, our autonomous engineering agent, found the hidden cause and fixed it. It also reduced database work by 63%. Then it strengthened the result by testing it again on a new benchmark.

This is what survived that audit:

- Our agent traced almost the entire accuracy gap to one undocumented database value.
- It eliminated the defect across 80 targeted trials.
- It rebuilt the missing baseline byte-for-byte, making a valid comparison possible.
- A fresh benchmark confirmed the deterministic gain on issues the system had never seen.
- It cut Neo4j queries by 63% and database sessions by 97%.
- It tested cheaper models and kept the stronger model when the alternatives missed the quality bar.

## Accuracy improved while database work fell

We built a corpus of 100 real `sympy/sympy` issues selected through SWE-bench, a dataset of real software tasks. The repeated comparison used its 60-issue development split. Neither version had been tuned on this corpus. Each ran three times, with three attempts across 40 questions, for 360 graded attempts per version.

| Metric | Before | After | Change |
|---|---:|---:|:---|
| Deterministic accuracy | 94.29% | **100.00%** | +5.71 percentage points |
| Overall benchmark score | 94.72% | **100.00%** | +5.28 percentage points |
| Questions right on every attempt | 37 / 40 | **40 / 40** | +3 |
| Confident wrong-zero answers | 32 in 40 trials | **0 in 80 trials** | Eliminated |
| Neo4j queries per ingestion | 698 | **255** | 63.5% fewer |
| Neo4j sessions per ingestion | 122 | **4** | 96.7% fewer |
| Schema constraints / indexes | 0 / 0 | **10 / 12** | Added |
| GitHub API requests | 121 | 121 | Unchanged |
| Agent error rate | 0% | 0% | Unchanged |

![Deterministic accuracy on a corpus it had never seen](assets/accuracy-on-unseen-data.svg)

The gain looks modest when compressed into 5.71 percentage points. Its shape matters more than its size. The fix removed a whole class of silent, repeated errors that normal error monitoring would not catch.

## Our agent ran the engineering loop end to end

A human set the objective and reviewed the result. Our agent handled the engineering loop.

It inspected the codebase, profiled the system, built the benchmark, proposed changes, implemented them, and scored each candidate. It kept changes that met their targets and reverted those that did not. It also sealed a holdout set, which is data reserved until the end, and ran it once.

After the campaign, it built a second benchmark and rebuilt the original implementation, which no longer existed on disk. It used both to verify the result independently.

That final stage refined the headline from a single-run result into a repeatable measurement. It is also what makes the remaining numbers credible.

## Measuring from outside the analyzer

When one system changes both code and measurement, bias can enter the result. We reduced that risk by measuring from outside the analyzer.

The first harness used:

- A local stand-in for GitHub with a frozen 100-issue corpus, removing network changes from the comparison.
- A real Neo4j database in an isolated Docker container, reset and verified empty before each run.
- External meters around GitHub, Neo4j, and model calls, so editing the analyzer could not hide work.
- Forty questions with answers computed from the corpus. Thirty-five used exact numerical or issue-set checks, while five used a fixed model judge.
- Integrity checks that compared the graph with the source corpus and were proven to fail on deliberately damaged data.
- A live preflight request that verified the model key and cost meter before a paid run began.

Every report also stored a source fingerprint: a SHA-256 digest over the source files and lockfile. That fingerprint tied each score to the exact code bytes that produced it. The decision looked like bookkeeping at the time. It later made the whole comparison possible.

## Eight evidence-backed improvements made the cut

Before each experiment, the agent recorded which metric had to improve and which metrics could not regress. It tested twelve hypotheses.

Eight changes stayed:

- identity constraints and indexes for the graph;
- batched Neo4j writes in one managed transaction;
- cleanup limited to the issue being processed;
- extraction from issue bodies and comments, with source tracking;
- bounded concurrent GitHub fetching;
- removal of a database read immediately after the same data was written;
- exact database error feedback for query retries;
- clearer graph schema guidance for the answering agent.

Comment filtering was fully implemented and tested, but it increased model cost without meeting its token target. The agent protected the stronger result by reverting it.

Three original ideas were deferred. The campaign contract ruled out one model substitution, while two embedding and vector-search ideas needed resources the project did not define. We did not present unmeasurable changes as progress. A later cost campaign tested model substitutions under a separate contract.

The eight retained changes improved different parts of the system. One moved accuracy, while the others improved database efficiency, integrity, and operating headroom.

## One missing schema detail explained the accuracy gap

The analyzer stores issues in a knowledge graph, a database that represents records and their relationships. It answers questions by generating Cypher, Neo4j's query language.

The graph stores issue state as `OPEN` or `CLOSED`. GitHub's website and application programming interface (API) usually show those words in lowercase. The prompt described `state` only as a string, so the model had to guess the stored form.

It often guessed wrong:

```cypher
MATCH (i:Issue)
WHERE i.state = 'open'
RETURN count(i)
```

The query was valid, but lowercase `open` matched nothing. The database returned zero rows, and the agent converted that empty result into a confident claim that no open issues existed.

The first change replaced a permissive instruction:

```diff
- If a query returns no results, say so honestly.
+ If a query returns no results, treat that as a signal to check the query before
+ concluding that the data is absent. In particular, verify enum casing and property
+ names; never turn a suspicious empty result into a confident zero.
```

An enum is a field limited to a known set of values. This hint pushed the model to check enum casing before trusting an empty result.

That small prompt change produced essentially the entire deterministic accuracy gain. Batching, indexes, concurrency, and the removed readback improved efficiency, but they added no accuracy.

## Turning a promising score into a repeatable result

The first campaign ended with a 100% score. Instead of stopping there, our agent reran the same frozen code on the same questions and got **97.5%**.

The code had not changed. The model output had.

This showed that a single run could not support the headline on its own. We replaced it with a three-run comparison that preserved the full deterministic gain.

The saved artifacts made the distinction clear. Two runs with the same source fingerprint scored 80% and 100% on the model-judged summary metric. That exposed the metric as noisy, so we kept it out of the causal claim.

The final claim focuses on the deterministic result because it showed no spread after the fix across three runs. This made the published result narrower, stronger, and easier to reproduce.

## Recovering a baseline that no longer existed

A before-and-after comparison needs a working "before". This project did not have one. The repository had no version history, and only the optimized code remained on disk. The fingerprint in an old report made it possible to recover the exact original implementation.

Our agent recovered a clean copy of the pre-campaign source. It then removed the eight retained changes one at a time and compared the result against the fingerprint stored in the original baseline report.

It matched exactly on the first attempt: `71c696b48a9da953`, across 18 files. A SHA-256 digest either matches or it does not, so the rebuilt version is provably the code the original numbers came from. It then compiled, passed all 21 of its own unit tests, ingested a corpus with every integrity check passing, and reproduced the original serial-write signature: one database session per issue, and no batched transaction.

This is what the fingerprint discipline bought. A digest recorded in every report turned an unrecoverable baseline into a recoverable one, and let every later comparison name the exact code on both sides.

## A second benchmark made the evidence stronger

To test whether the result transferred beyond the original benchmark, our agent built another one from scratch.

It wrote the corpus builder, the question generator, and the answer-key verifier. It screened 386 candidate `sympy/sympy` instances from SWE-bench, linked each merged pull request to the issue it closed, and fetched that issue from GitHub. This produced a new corpus, new questions, and new answer keys that neither system version had seen.

The first candidate was `django/django`, the largest repository in SWE-bench. We rejected it after checking the source because Django tracks bugs in Trac and has GitHub Issues disabled. There were no suitable GitHub issues to analyze.

The unfamiliar data also exposed two assumptions inherited from the first benchmark:

1. One generated question could forbid its own correct answer when every issue in a split was closed.
2. Integrity checks counted issue authors and reactions but omitted those attached to comments.

Both were corrected in the second harness. Testing on unfamiliar data improved the measurement system as well as confirming the product result.

On the sealed holdout, exactly two questions separated the baseline from the improved version: the open-issue count and the closed-issue count. Every other question scored the same. The independent benchmark confirmed that one schema defect explained the accuracy difference.

## Replacing a useful hint with the root fix

The three-line instruction was a useful defense. It was not the root fix because the prompt still failed to state the legal values.

The final change documented the allowed values in the schema itself:

```diff
- state (STRING), authorLogin (STRING)
+ state (STRING, one of: OPEN, CLOSED), authorLogin (STRING)
```

A targeted probe asked only the two questions that exposed the defect. It also recorded the Cypher generated on each attempt.

| Version | Correct answers | Used stored casing | Confident wrong zeros |
|---|---:|---:|---:|
| Baseline | 8 / 40 | 3 / 20 | 32 |
| Prompt hint | 77 / 80 | 77 / 80 | 3 |
| **Documented enum** | **80 / 80** | **80 / 80** | **0** |

Every miss across all three versions used lowercase in the query. Once the schema named the allowed values, that failure disappeared in all 80 targeted trials.

## Sixty-three percent less database work, and where that actually pays off

The database improvements were substantial. Neo4j queries fell from 698 to 255 per ingestion, while sessions fell from 122 to 4.

![Database work per ingestion](assets/database-work.svg)

Those savings did not make the analyzer feel much faster. Ingestion time improved by only 3.7%. Answer latency did not improve: it moved from 4,178ms to 4,385ms, which was treated as noise.

The timing data explains why.

![Where the 203 seconds of ingestion actually went](assets/where-ingestion-time-goes.svg)

Model calls consumed about 90% of ingestion time. Neo4j was only a small part of the total. Removing nearly two-thirds of the database work saved about 2.5 seconds from a 203-second job.

The database work still matters. Four sessions use fewer resources than 122, and batching creates more room to scale. But this was a resource-efficiency result, not a speed result.

## Testing cheaper models without trading away quality

Once quality stabilized, we tested the largest measurable cost lever: the model that turns user questions into database queries.

The system cost about $1.19 per benchmark run using `gpt-4o`. Of that measured cost, 59.8% came from the question-answering agent, 28.6% from extraction during ingestion, and 11.6% from comment summaries.

| Candidate | Deterministic accuracy | Decision |
|---|---:|---|
| `gpt-4o` | **100.00%** | Keep |
| `gpt-4o-mini` | 95.87%, with a 5.71-point spread | Reject |
| `gpt-4.1-mini` | 76.19% | Reject |

![Can a cheaper model answer the questions?](assets/cheaper-models.svg)

The cheaper model cut question-answering cost by about 72%. We kept `gpt-4o` because the alternatives did not preserve the required accuracy.

The two models also failed differently. `gpt-4o-mini` sometimes reversed the direction of graph relationships. It queried as if a user pointed to an issue when the schema defined the arrow in the other direction. Those valid but backward queries returned nothing and created more confident-zero answers.

`gpt-4.1-mini` struggled with exact enumeration. It could often count matching issues, but it failed questions that required listing every match.

The agent also considered adding a relationship-direction hint. Before spending time and model calls, it calculated the best possible outcome. Even a perfect repair would have reached only 98.10%, below the target, so the experiment stopped early.

One cost gap remains open. Extraction is the dominant production cost, but no benchmark question grades the extracted nodes. A cheaper extraction model could damage the graph while the current score remained unchanged. Until extraction quality is measured, that optimization cannot be evaluated safely.

## What this experiment can and cannot claim

The evidence supports a narrow, useful conclusion. On a second repository, the documented enum removed a repeated deterministic failure. The final system also used far fewer database queries and sessions.

The evidence does not show that the analyzer will score 100% everywhere. Both benchmarks cover one repository each, and three runs cannot settle a noisy model-judged metric. The SWE-bench corpus also favors closed issues because it starts from merged pull requests.

The cost figures come from the benchmark's local price table, not an OpenAI invoice. The fixed schema version reused the graph built by the previous champion. This was valid because only the answering prompt changed, not ingestion.

These limits narrow the claim. Its core still holds. The deterministic difference repeated on an independent corpus, matched a known mechanism, and disappeared when the schema supplied the missing information.

## What this approach demonstrates

**An empty result is not always an empty world.** A valid query can still ask the wrong question. Treat suspicious zeros as a reason to inspect the query and schema.

**Repeatability matters more than a perfect first score.** Multiple runs turned an encouraging result into a defensible measurement.

**Separate stable metrics from noisy ones.** Exact questions showed a repeatable gain. A model judge moved 20 points on identical code, so we stopped using that movement as evidence.

**Test a benchmark on unfamiliar data.** The second corpus confirmed the product fix and found two defects in the test harness itself.

**Optimize for evidence, not activity.** The loop reverted a weak change, deferred unmeasurable work, and rejected cheaper models that lost quality. Those decisions protected the result that mattered.

## Reproduce the result

The repository includes both benchmark harnesses and every scored report.

```bash
cd github_issue
bun install
cd ..

# Free verification gates
bun bench/verify-all.ts
bun verification_bench/verify-all.ts

# Scored run, about $1.10 to $1.20 using the benchmark price table
SUT_DIR=../github_issue bun verification_bench/run.ts \
  --split dev --job my-run --attempts 3
```

Each scored system version is pinned to its recorded source fingerprint.

Verify a checked-out version before scoring it:

```bash
git checkout <commit>
bun verification_bench/verify-sut-switch.ts
```

You can also compare an earlier version without changing the main working tree:

```bash
git worktree add .worktrees/baseline f5b3184
SUT_DIR=../.worktrees/baseline/github_issue \
  bun verification_bench/run.ts --split dev --job base --attempts 3
```

The detailed audit is in [`VERIFICATION.md`](VERIFICATION.md). The original campaign report is in [`RESULTS.md`](RESULTS.md), and the experiment-by-experiment record is in [`ledger.md`](ledger.md).

## What the optimization delivered

The analyzer now knows how many issues are closed because its schema tells it what `CLOSED` looks like. That sentence is backed by an independent benchmark, three repeated runs, 80 targeted trials, and a fingerprinted source version.

NEO performed the profiling, benchmark construction, optimization loop, baseline recovery, independent verification, and cost campaign. It delivered a more accurate and efficient analyzer, along with the evidence needed to trust it.

**[NEO: Your Autonomous AI Engineering Agent](https://heyneo.com)**

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Get%20the%20Extension-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=NeoResearchInc.heyneo)
[![Cursor Extension](https://img.shields.io/badge/Cursor-Get%20the%20Extension-1F1F1F?style=for-the-badge&logo=cursor&logoColor=white)](https://marketplace.cursorapi.com/items/?itemName=NeoResearchInc.heyneo)
[![Neo MCP Docs](https://img.shields.io/badge/Neo%20MCP-Documentation-6E56CF?style=for-the-badge&logo=readthedocs&logoColor=white)](https://docs.heyneo.com/neo-mcp)
# GitHub Issue Analyzer

This is a small system that loads GitHub issues into a Neo4j graph database and then answers plain-English questions about them. A person asks "how many open issues are tagged bug?", a language model turns that into a database query, runs it, and reports the answer.

This repository contains two things: the analyzer itself, and a complete record of how it was measured, what was wrong with it, what was changed, and what each change actually did. The second part is the reason the repository exists. Everything below is reproducible from the stored run reports in `verification_bench/jobs/`.

The work was carried out autonomously by [NEO](https://heyneo.com), an AI engineering agent that profiled the code, built the benchmark, ran the optimization loop, and then re-verified its own result at larger scale. Because the same agent both built the benchmark and optimized against it, the measurement design leans heavily toward independent checks: sealed holdout corpora chosen before fixes were written, oracles derived from the raw data rather than from the system, and a re-run of everything at larger scale after the first result looked too clean.

---

## 1. Final outcome

This is the largest comparison that was run. It covers 300 questions across six real repositories (sympy, requests, scikit-learn, matplotlib, astropy, pylint), 60 issues per repository, every question asked three times. "Baseline" is the code as it was before any work started, reconstructed from its recorded source fingerprint. "Final" is the current HEAD of this branch.

| Measure | Baseline | Final | What changed |
|---|---:|---:|---|
| Accuracy, 200 development questions (4 repos) | 86.0% | 100.0% | +14 points. 30 questions gained, 0 lost. |
| Accuracy, 50 sealed pylint questions (never seen during any fix) | 88.0% | 100.0% | +12 points. Repo chosen before the fix was written. |
| Neo4j queries per ingestion of 60 issues (mean of 5 repos) | 779 | 281 | 64% fewer. |
| Neo4j sessions per ingestion | 122 | 4 | 97% fewer. |
| Ingestion wall-clock time, 60 issues (mean of 5 repos) | 140 s | 146 s | No improvement. Within run-to-run noise. |
| Answer latency per question attempt (mean) | 3.56 s | 3.71 s | No improvement. Slightly up. |
| LLM cost per 50-question benchmark run, including ingestion | $1.34 | $1.60 | 19% higher. |

Three things to take from this table before reading further.

The accuracy gain is real, large, and holds on a repository the fix never saw. The database work reduction is real and holds on every repository. Neither of those two improvements caused the other. And two things did not improve: the system is not faster, and it costs more to run. Those are reported here rather than left out.

A question counts as solved when at least two of its three attempts match the oracle answer. The 200-question set excludes the 24 judge-graded "semantic" questions per repo because that metric was shown to move by 20 points on identical code; the numbers above are for questions with an exact computable answer only.

---

## 2. What caused each number

### Accuracy: three missing lines in a prompt

The entire accuracy gain, all 30 questions, comes from one place: the text that describes the database schema to the language model before it writes a query. That description was incomplete in three ways, and each gap produced the same kind of failure. The model guessed at how data was stored, guessed wrong, got zero rows back, and reported the zero as a fact.

The first gap was the issue state field. The graph stores `OPEN` and `CLOSED`. The prompt did not say so. The model wrote `state = 'open'`, got nothing, and told users there were no open issues. On the first benchmark this was 2 questions out of 35; on the wider one it was 16 of the 30.

The second gap was label names. Repositories store labels like `Bug`, `Enhancement ✨`, `status: confirmed bug`. Asked about "bug" issues, the model wrote `name = 'bug'`, matched nothing, and answered "there are currently no issues tagged bug" when there were 19. This failed in every arm of every run until it was fixed.

The third gap was traversal direction. Asked which users commented on issues with a given label, the model invented a relationship `(Label)-[:HAS_COMMENT]->(Comment)` that does not exist in the graph, got nothing, and reported no users. The real path goes from the label back to the issue and then to its comments.

![Which kinds of question actually moved](assets/which-questions-moved.svg)

*Per-stratum accuracy on the 200 development questions, before the campaign, after the enum line, and after the free-text fix. The five strata that were already at 100% in the baseline are not shown. Chart source: `verification_bench/analyze.ts`.*

The fix for all three is documentation. The schema block in `agent/config.ts` now states the enum values, says that free-text matches should be case-insensitive, and says that traversals from a label must return to the issue before continuing. That is the whole change. No model was swapped, no retrieval was added, no query rewriting was introduced.

This was established by ablation, not inference. Four versions were scored on the same 200 questions:

| Version | Accuracy |
|---|---:|
| Baseline | 86.0% |
| Baseline plus only the enum line | 94.0% |
| All eight optimization changes, without the enum line | 94.5% |
| All eight changes plus the enum line | 94.0% |

![Which change earned the accuracy gain](assets/which-change-earned-it.svg)

*The same four versions as the table, on the 200 development questions across four repositories.*

Adding the eight optimization changes on top of the enum line moved one judge-graded question and nothing else (McNemar p = 1.0). The eight changes did not make the system more accurate. Adding the two remaining schema lines then took 94% to 100%.

One check that mattered: the benchmark includes questions whose correct answer really is zero. Those pass at 100% in every version including the baseline. The fix moved wrong zeros to right answers without teaching the model to distrust zeros in general.

### Database work: batching

The baseline wrote each issue to Neo4j in its own session with its own statements, and read back what it had just written. For 60 issues that produced roughly 780 queries across 122 sessions. The optimized ingestion collects all issues and writes them in a handful of `UNWIND` statements inside one transaction, with uniqueness constraints and two indexes created once up front. That produces about 280 queries across 4 sessions. The saving is 61% to 67% on every repository tested, and 122 sessions to 4 on all of them.

![Database work per ingestion](assets/database-work.svg)

*Measured on the first benchmark's 60-issue sympy corpus, same GitHub and OpenAI calls in both versions. The large run in section 1 shows the same ratio on every repository.*

This change and the accuracy change are independent. The batching touches ingestion code the question-answering path never reads. The prompt fix touches a config file the ingestion path never imports. The ablation confirmed this: versions differing only in the prompt were scored on byte-identical graphs.

### Ingestion time: unchanged, because the database was never the bottleneck

Ingestion of 60 issues takes about 140 seconds in both versions. Of that, roughly 3 seconds in the baseline was Neo4j writes, now under 1 second. The remaining time is 60 sequential calls to `gpt-4o` to extract structured information from each issue body. Cutting database work by two thirds removed about 2 seconds from a 140-second job.

![Where ingestion time goes](assets/where-ingestion-time-goes.svg)

*OpenTelemetry spans from one baseline ingestion. OpenAI calls account for about 90% of wall-clock time; Neo4j for under 4%. Spans overlap so shares sum to more than 100%.* The batching is still worth having, because the cost of per-issue sessions grows with corpus size while the cost of four sessions does not, but it does not make this system faster at this scale and the README does not claim it does.

### Answer latency: unchanged

Each question attempt takes about 3.5 seconds, nearly all of it waiting for the language model. The final prompt is slightly longer than the baseline prompt, which shows up as a small increase.

### Cost: higher

The baseline benchmark run cost about $1.34 in model calls. The final version costs about $1.60. Two things drove this. The longer schema prompt adds input tokens to every question. And the fixed version answers more questions correctly, which for list-type questions means longer answers.

Three attempts were made to reduce cost by switching the question-answering model to cheaper alternatives. All three were rejected: `gpt-4o-mini` scored 95.9% with a 5.7-point spread between runs, and the other two were worse. The saving on the QA stage was 72%, but the quality was not acceptable.

![Can a cheaper model answer the questions](assets/cheaper-models.svg)

*Question-answering model swapped, same graph, three runs each. Whiskers show the run-to-run range.* Extraction cost, which is the largest cost in production use, was not optimized because until this branch there was no way to measure extraction quality. A first extraction metric now exists (`score-extraction.ts`, grounding precision against the issue body and recall against SWE-bench gold patches) and shows the optimized version extracting 13.6% more strings at unchanged precision. Cheaper extraction models can now be evaluated against it.

---

## 3. How this was reached, in order

### Step 1: profiling

The starting point was reading the code. Issues were fetched from GitHub one at a time, written to Neo4j one at a time in their own sessions, read back after writing, and stored in a graph with no uniqueness constraints or indexes. The prompt that described this graph to the query-writing model documented the node types and relationships but not the values fields could take.

### Step 2: a first benchmark, small

Before changing anything, a benchmark was built so that changes could be scored. It used 100 sympy issues selected through SWE-bench (SWE-bench was used only to pick issues with a known resolving pull request; no SWE-bench task was run). 60 issues went to a development corpus and 40 to a sealed holdout. 40 questions were written against the development corpus and 20 against the holdout, with answers computed directly from the corpus rather than from the system under test. Each question was asked three times and scored by exact match against that oracle. Five questions per corpus were judge-graded and reported separately.

### Step 3: the optimization loop

Eight changes were made and kept, each scored against the benchmark before being accepted: batched writes, constraints and indexes, removal of the read-back, parallel GitHub fetching, and several smaller pipeline changes, plus one line added to the prompt as a hint about the state field. One ninth change, filtering comments before extraction, raised cost without improving anything and was reverted.

The combined result on the development corpus, averaged over three runs: deterministic accuracy from 94.3% to 100%, Neo4j queries from 698 to 255.

### Step 4: re-verification on the sealed holdout

The 40 held-back issues were ingested and their 20 questions scored once per version. Baseline 88.2%, optimized 100%. Queries 452 to 175.

![Accuracy on unseen data](assets/accuracy-on-unseen-data.svg)

*The first benchmark's development comparison: 100 sympy issues, three runs per version, three attempts per question. The whisker is the range across the three baseline runs.*

This is where the first result stood when it was published, and it looked strong. It had three weaknesses that a careful reader would notice. The whole accuracy difference was 2 questions of 35, both about open and closed counts. There was no way to tell which of the eight changes had produced the gain. And 35 questions of one shape on one repository cannot find a mistake they never ask about.

### Step 5: the harness caught a problem in its own earlier run

While preparing the larger benchmark, the grader was found to reject four kinds of correct answer: a number followed by a period, a count written as a word, an empty set expressed in a sentence, and a zero that echoed a date from the question. A repaired grader was applied to all 3,500 stored attempts. Exactly one outcome changed: a canary question in an earlier "reproduction" run that had been published as valid at 98.10% had in fact failed its canary. The corrected score is 99.05% with the canary passing. No headline number moved, but the run had been published with a broken integrity check, and that is recorded.

### Step 6: scaling up

The benchmark was rebuilt with 300 questions over six repositories, 50 per repository, each question labelled with what it tests: state fields, labels, authors, date ranges, aggregates, text search, two-hop traversals, questions whose true answer is zero, and paraphrases of the same question. Corpora mixed SWE-bench-linked issues with open issues from the same repository, because a corpus drawn only from SWE-bench is nearly 100% closed and cannot test the state field at all. Django was excluded because it uses Trac rather than GitHub Issues.

Four versions were scored on 200 development questions from four of the repositories, and astropy was held sealed. That produced the ablation table in section 2 and showed the accuracy gain was the one enum line.

It also showed two question types failing in every version, including the shipped one: label names with mixed casing, and the label-to-commenter traversal. Both were the same defect as the state field.

### Step 7: the second fix, and its own holdout

Before writing the fix, pylint was chosen as the sealed test repository because it is the only SWE-bench repository with mixed-case labels, so it is the only one that can exercise the defect. Its corpus and questions were generated by the unchanged generator and checksummed before scoring. The two schema lines were then added and every corpus re-scored.

Development questions: 94% to 100%. Sealed pylint: 96% to 100%. Twelve questions gained, none lost, in any stratum on any repository.

### Where it stands

The benchmark is now saturated. The last two versions both score 100% on all 300 questions, so it can no longer tell them apart. The next improvement needs harder questions, not another run.

The remaining caveats are these. The large run used one run per version per repository with three attempts per question, not the three full runs the small benchmark used, so run-to-run variance at scale is not characterised. The 200 development questions are where the two later defects were discovered, so the honest generalisation number for the final fix is the pylint result alone. And all of this was carried out and written up by the same agent that built the system; the sealed corpora and computed oracles are the guard against that, not a substitute for outside review.

---

## 4. Repository layout

| Path | What it is |
|---|---|
| `github_issue/` | The analyzer: ingestion pipeline, Neo4j graph, question-answering agent |
| `bench/` | The first benchmark harness (frozen; acts as the referee for the small run) |
| `verification_bench/` | The second harness, corpora, tasks, and all stored run reports |
| `verification_bench/jobs/*/report.json` | One report per scored run; every number above is recomputable from these |
| `verification_bench/tasks/*.jsonl` | The question sets, with strata labels and oracle answers |
| `verification_bench/analyze.ts` | Per-stratum accuracy, McNemar tests, paired bootstrap, regrading |
| `verification_bench/score-extraction.ts` | Extraction quality metric |
| `RESULTS.md`, `RESULTS-V2.md`, `VERIFICATION.md` | Long-form records of the small run, the large run, and the re-verification |
| `ledger.md` | Every hypothesis tried, kept, or rejected, with cost |

---

## 5. Running it

Requirements: Bun, Docker (for Neo4j), a GitHub token, and an OpenAI key in `github_issue/.env`.

Free checks that need no API key:

```
bun verification_bench/verify-all.ts        # oracles, graders, fingerprints, v1 and v2
bun verification_bench/analyze.ts           # recompute every table above from stored reports
```

Scored runs cost money. The full matrix that produced section 1 is about $27 in `gpt-4o` calls and roughly six hours sequential:

```
bash verification_bench/run-v2-matrix.sh    # four versions, four corpora
bash verification_bench/run-v2-sealed.sh    # astropy and pylint
bash verification_bench/run-v2-fixup.sh     # the final fix on every corpus
```

To score a different version of the analyzer, put it in a git worktree and pass its path as `SUT_DIR`. The harness fingerprints the source tree and refuses to score two identical trees as different arms.

To use the analyzer itself rather than the benchmark, see `github_issue/README.md`.

---

## 6. Built with NEO

Every step recorded above, from the initial profiling through the optimization loop, the sealed re-verification, the cost campaign with its rejected results, and the 300-question scale-up, was carried out by [NEO](https://heyneo.com) running autonomously. The negative results and the grader defect it found in its own earlier run are reported here in full because a record that only contains the wins is not a record.

Long-form write-ups of each stage:

| Document | Covers |
|---|---|
| [`RESULTS.md`](RESULTS.md) | The first benchmark and the optimization loop |
| [`VERIFICATION.md`](VERIFICATION.md) | Re-verification on the sealed sympy holdout |
| [`RESULTS-V2.md`](RESULTS-V2.md) | The 300-question benchmark, the ablation, and the second fix |
| [`verification_bench/BENCH-V2.md`](verification_bench/BENCH-V2.md) | How the wider harness and its oracles are built |
| [`ledger.md`](ledger.md) | Every hypothesis tried, with outcome and cost |
| [`blog.md`](blog.md) | A narrative walkthrough of the whole run |

[**NEO, Your Autonomous AI Engineering Agent**](https://heyneo.com) ·
[VS Code extension](https://marketplace.visualstudio.com/items?itemName=NeoResearchInc.heyneo) ·
[Cursor extension](https://marketplace.cursorapi.com/items/?itemName=NeoResearchInc.heyneo) ·
[Neo MCP docs](https://docs.heyneo.com/neo-mcp)

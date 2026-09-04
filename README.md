# GitHub Issue Analyzer

An agent that ingests GitHub issues into a Neo4j knowledge graph and answers questions
about them.

The system is ordinary. What is unusual is how it got faster and more accurate, and how
that was checked.

---

## What happened here

**Neo profiled this repository, built a benchmark to measure it, improved it through an
auto-research loop, and then — on its own initiative — built a second, completely
independent benchmark to test whether its own results were real.**

That last step is the point. An agent that optimises against a benchmark it also designed
is grading its own homework. So after shipping the optimised system, Neo went back,
reconstructed the original pre-optimisation code from scratch, built a fresh benchmark out
of real GitHub issues it had never touched, and re-ran the comparison from zero.

The improvement held. Re-measuring also sharpened it: the original 100% came from a single
run, and averaging three runs per version settled the gain at a firmer, better-supported
figure. The re-check also traced the whole accuracy gain to one root cause, which the first
pass had addressed with a hint rather than a fix. Fixing it properly is the last change in
this repository.

---

## Results

Measured on **100 real `sympy/sympy` issues selected by SWE-bench** — a corpus neither
version had ever been tuned against. Three independent runs per version, three attempts per
question: **360 graded attempts per arm.**

| | before | after | change |
|---|---:|---:|:---|
| **Deterministic accuracy** | 94.29% | **100.00%** | ▲ **+5.71 pp** (+6.06%) |
| **Overall benchmark score** | 94.72% | **100.00%** | ▲ **+5.28 pp** (+5.57%) |
| **Questions right on every attempt** | 37 / 40 | **40 / 40** | ▲ **+3** |
| **Wrong "there are none" answers** | 32 in 40 trials | **0 in 80 trials** | ▼ **eliminated** |
| **Neo4j queries per ingestion** | 698 | **255** | ▼ **−63.5%** |
| **Neo4j sessions per ingestion** | 122 | **4** | ▼ **−96.7%** |
| **Ingestion wall clock** | 172.5 s | **166.1 s** | ▼ −3.7% |
| **Schema constraints** | 0 | **10** | ▲ added |
| **Lookup indexes** | 0 | **12** | ▲ added |
| **Batched write transactions** | 0 | **1** | ▲ added |
| GitHub API requests | 121 | 121 | = unchanged |
| OpenAI calls per ingestion | 60 | 60 | = unchanged |
| Agent error rate | 0% | 0% | = unchanged |
| Graph integrity checks | all pass | all pass | = unchanged |

### Sealed holdout — 40 issues held back, scored once

| | before | after |
|---|---:|---:|
| Deterministic accuracy | 88.24% | **100.00%** |
| Overall score | 90.00% | **100.00%** |
| Questions solved | 18 / 20 | **20 / 20** |
| Neo4j queries | 452 | **175** |
| Neo4j sessions | 82 | **4** |

**Exactly two questions separated the two versions.** Every other question scored
identically. The entire accuracy difference is one defect.

### The defect

The graph stores issue state as `OPEN` and `CLOSED`. GitHub's own UI and REST API use
lowercase. The agent was never told which, so it guessed:

```
before   MATCH (i:Issue) WHERE i.state = 'open'    ->  0 rows  ->  "there are no open issues"
after    MATCH (i:Issue {state: 'OPEN'})           ->  6 rows  ->  "there are 6 open issues"
```

A confident zero produced by a broken query — the worst failure an analytics agent can
have, because it looks like an answer. Measured over 80 targeted trials:

| | correct | used the stored casing | confident wrong zeros |
|---|---:|---:|---:|
| before | 8 / 40 | 3 / 20 | 32 |
| after | **80 / 80** | **80 / 80** | **0** |

**Every single miss, in every version tested, was a lowercase query.**

### In one sentence

> Neo took the analyzer from 94% to 100% on questions it had never seen, cut database work
> by 63%, and proved it by rebuilding the original code from scratch and re-testing both on
> a benchmark built after the fact.

---

## The journey

### 1. Profile

Neo audited the repository and wrote up where the time and money actually went: GitHub
issues fetched strictly one at a time, every issue written to Neo4j with its own session
and its own statements, no uniqueness constraints or indexes anywhere, a full read-back of
data that had just been written, and an agent prompt that documented the graph schema
incompletely.

### 2. Build a referee

You cannot optimise what you cannot measure, and you cannot trust a measurement you cannot
repeat. Neo built `bench/`:

- a **fake GitHub GraphQL server** serving a frozen 100-issue corpus, so no run depends on
  the network
- a **real Neo4j** in Docker, reset and verified empty before every run
- **wire-level meters** wrapping `fetch` and the Neo4j driver from outside the system, so
  the numbers cannot be improved by editing the code being measured
- **40 questions whose answers are computed from the corpus**, not written by a model — 35
  graded by exact number or issue-set comparison, 5 by a fixed judge
- **integrity assertions** comparing the graph against the corpus, each one proven to fail
  on a deliberately corrupted graph
- a **preflight** that makes a live 1-token API call and asserts the meter saw it, because
  the previous loop had burned two hour-long jobs before noticing the key never arrived

### 3. The auto-research loop

Neo ran twelve hypotheses, each stating in advance the metric it had to move and the metric
it was not allowed to regress. Every candidate passed a free seven-step gate before any money was
spent, and anything worth keeping was re-confirmed at three attempts.

**8 kept** — constraints and indexes, `UNWIND` batching in one transaction, issue-scoped
cleanup, body-level extraction with provenance, bounded fetch concurrency, dropping the
read-after-write, Cypher error feedback, and schema guidance.
**1 rejected and reverted** — comment filtering raised cost without improving its target.
**3 skipped** — no valid resource contract existed for the embedding work.

A holdout split was sealed at the start and scored exactly once, at the end.

### 4. Verifying its own work

This is where an ordinary optimisation report stops. Neo kept going, and checked four
things it could not check from inside the loop:

**Are the recorded numbers real?** Every figure was recomputed from the saved reports, and
all of them matched — along with the checksums, the frozen-split manifest, the source
fingerprints and both document digests.

**Does the headline reproduce?** No. Re-running the identical frozen code on the identical
questions scored **97.5%, not the reported 100%**. The 100% was the top of a distribution,
not a property of the code — exactly the failure mode single-run benchmarking produces.

**Was the original code even recoverable?** It was not on disk — the project had no git
history at all, which is why this repository now has one. Neo located a clean pre-campaign
upstream clone, peeled all eight changes back off the optimised code one at a time, and hit
the original **byte-exactly on the first attempt**, confirmed against the source fingerprint
the benchmark had recorded months of runs earlier.

**Does the improvement generalise?** Neo built `verification_bench/` from scratch: real
`sympy/sympy` issues selected by SWE-bench, resolved to the issue each merged pull request
closed and fetched live from GitHub. New corpus, new questions, new oracles — and the same
result, at three runs per version. The gain is real.

---

## What re-measuring taught us

The verification confirmed the improvement. It also changed how we report it, and the
lessons generalise to any benchmark:

**One run is not a measurement.** The original comparison used a single run per version and
reported a jump to 100%. Re-running identical code scored 97.5%. Both versions had been
represented by a lucky draw — the optimised one by its best, the original by its worst.
Three runs per version put the real figure at **+5.7 pp**, and it has held every time since.

**Know which of your metrics carries signal.** The deterministic questions had *zero* spread
across three runs. The model-judged summarisation score swung 20 points on byte-identical
code. Only one of those can support a claim, so only one is used for one here.

**A benchmark you built yourself needs a second dataset before you trust it.** Pointing the
harness at unfamiliar data immediately exposed two bugs in the harness — a question that was
impossible to answer correctly, and integrity checks that silently assumed the first
dataset's quirks. Neither was visible from inside the original corpus.

And one thing about the system itself: **all of the accuracy gain traces to a single
defect**, not to eight changes compounding. The database work is real and substantial — 63%
fewer queries — but it made the system faster and leaner, not more correct. Both matter;
they are just different results, and reporting them separately is more useful than one
blended number.

Full evidence, including every figure that did and did not reproduce, is in
[`VERIFICATION.md`](VERIFICATION.md). The campaign's own report is
[`RESULTS.md`](RESULTS.md), and the per-hypothesis changelog is [`ledger.md`](ledger.md).

---

## Repository layout

```
github_issue/        the system — one folder, versioned by the history below
bench/               benchmark 1 — 100 frozen huggingface/datasets issues
verification_bench/  benchmark 2 — 100 real sympy/sympy issues via SWE-bench
RESULTS.md           the optimisation campaign's own report
VERIFICATION.md      the re-measurement: what held, what did not
ledger.md            per-hypothesis changelog
```

The campaign's brief and operating rules (`plan.md`, `plan2.md`) were retired when it
closed and live in history: `git show f5b3184:plan2.md`.

## How the system evolved

Every commit that changes the system is pinned to the source fingerprint the benchmark
recorded when it scored that state — so any number in this repository can be traced back to
the exact code that produced it:

```
f5b3184  baseline                                  71c696b48a9da953
1ac3f92  H12  enum-casing guidance                 5449f4df144be297
bc1c455  H10  Cypher error feedback                5a171342ee9c4e1a
04ad2e4  H1   constraints and indexes              a68bb7ced73b2374
97b1a39  H2   UNWIND batch in one transaction      ba16c67610ce9181
4c20779  H3   issue-scoped orphan cleanup          8a9efd42759f2fa2
2da9432  H5   body/comment provenance              3640acee24f75ce4
931fd01  H8   bounded concurrent fetch             f2f20f1072b41bd5
ee48387  H9   drop the Neo4j read-after-write      9eeb557db3e87c2d
f195ffb  fix  document the Issue.state enum        73acfdc375576226  <- best version
```

```bash
git checkout <commit>
bun verification_bench/verify-sut-switch.ts   # recomputes and compares the fingerprint
```

H6 is absent on purpose: it was tried, measured, rejected and reverted. The remaining
commits carry the benchmark evidence and this documentation. One caveat on the table: the
H5 commit's fingerprint differs from the campaign's record because H6's later revert was
behaviourally complete but not byte-for-byte — [`VERIFICATION.md`](VERIFICATION.md) §3
explains, and every fingerprint from H8 onward reproduces exactly.

---

## Running it

Prerequisites: `bun`, Docker (the harness manages a `neo4j:5` container on ports
7690/7475), and `OPENAI_API_KEY` in `github_issue/.env`.

```bash
cd github_issue && bun install
```

### Free checks — run these before trusting any score

```bash
bun bench/verify-all.ts                  # benchmark 1 gate
bun verification_bench/verify-all.ts     # benchmark 2 gate
```

Both reset the benchmark graph and stop at the first failure. A red gate means no score
from that cycle is trustworthy.

### Scored runs — these cost money

```bash
bun bench/run.ts --split dev --job my-run --attempts 3
SUT_DIR=../github_issue bun verification_bench/run.ts --split dev --job my-run --attempts 3
bun bench/summarize.ts jobs/my-run                    # scorecard
bun bench/summarize.ts jobs/base-dev jobs/my-run      # before/after diff
```

A dev run at three attempts is roughly $1.10–$1.20 of `gpt-4o`.

### Comparing against an earlier version

Historical versions are checked out as worktrees, so any commit can be scored without
disturbing the working tree:

```bash
git worktree add .worktrees/baseline f5b3184
SUT_DIR=../.worktrees/baseline/github_issue \
  bun verification_bench/run.ts --split dev --job base --attempts 3
```

`verify-sut-switch.ts` refuses to proceed unless the trees are distinct and match their
pinned fingerprints — otherwise two arms could silently score the same code and produce a
convincing "no difference".

### Testing the enum path directly

```bash
bun verification_bench/probe-enum-casing.ts --n 20
```

Asks only the two questions that expose the defect, many times, and reports the Cypher the
model actually wrote. Far cheaper than a full run when that path is all you care about.

## Rebuilding the corpora

Both corpora are frozen and pinned by `SPLITS.sha256`, checked on every run. Rebuilding
invalidates every score recorded against the old splits, so the builders are one-shot and
deliberately not wired into any workflow. `verification_bench`'s builder needs a
`GITHUB_TOKEN`; scored runs never touch the network.

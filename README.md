# GitHub Issue Analyzer

An agent that ingests GitHub issues into a Neo4j knowledge graph and answers questions
about them, plus two independent benchmarks that measure it.

The interesting thing about this repository is not the agent — it is that every performance
claim made about it has been re-measured, and the history is arranged so any claim can be
re-checked against the exact code that produced it.

```
github_issue/        the system under test — one folder, versioned by the history below
bench/               benchmark 1: 100 frozen huggingface/datasets issues
verification_bench/  benchmark 2: 100 real sympy/sympy issues selected by SWE-bench
RESULTS.md           the original optimisation campaign's report
VERIFICATION.md      what held up under re-measurement, and what did not
ledger.md            per-hypothesis changelog from the campaign
plan.md / plan2.md   the campaign's brief and its operating rules
```

## The history is the story

Each commit that changes `github_issue/` is pinned to the source fingerprint that the
benchmark recorded when it scored that state, so you can verify any commit is the code a
given number came from:

```bash
git checkout <commit>
bun verification_bench/verify-sut-switch.ts   # recomputes and compares the fingerprint
```

```
f5b3184  baseline                                  71c696b48a9da953
1ac3f92  H12  enum-casing guidance in instructions 5449f4df144be297
bc1c455  H10  exact Cypher errors + retry guidance 5a171342ee9c4e1a
04ad2e4  H1   Neo4j constraints and indexes        a68bb7ced73b2374
97b1a39  H2   UNWIND batch in one transaction      ba16c67610ce9181
4c20779  H3   issue-scoped orphan cleanup          8a9efd42759f2fa2
2da9432  H5   body/comment solution provenance     3640acee24f75ce4 *
931fd01  H8   bounded concurrent GitHub fetch      f2f20f1072b41bd5
ee48387  H9   drop the Neo4j read-after-write      9eeb557db3e87c2d   <- campaign champion
73606bc  fix  document the Issue.state enum        73acfdc375576226   <- HEAD, best version
```

`*` The H5 commit does not carry the fingerprint the campaign recorded for that state
(`007fde4eb448998a`). H6 was implemented after it and then rejected, and that revert was
behaviourally complete but not byte-exact. The commit message explains; every fingerprint
from H8 onward reproduces exactly.


H6 is absent on purpose: it was tried, measured, rejected and reverted. The ledger records
it.

## What the measurements actually say

Averaged over three runs per arm on `verification_bench` — a corpus the system was never
tuned against:

| | deterministic | overall | Neo4j queries |
|---|---:|---:|---:|
| baseline | 94.29% | 94.72% | 698 |
| HEAD | **100.00%** | **100.00%** | **255** |

The accuracy gain is **one defect**: the agent was guessing the casing of `Issue.state`,
querying `'open'` against a graph storing `'OPEN'`, getting zero rows, and reporting a
confident zero. Nothing else the campaign changed moved accuracy. The database work is
real and transfers: 63% fewer queries, 122 sessions down to 4.

Read [`VERIFICATION.md`](VERIFICATION.md) for the evidence, including the claims from
[`RESULTS.md`](RESULTS.md) that do **not** reproduce.

## Running it

Prerequisites: `bun`, Docker (the harness manages a `neo4j:5` container on ports
7690/7475), and `OPENAI_API_KEY` in `github_issue/.env`.

```bash
cd github_issue && bun install
```

### Free checks — run these before trusting any score

```bash
bun bench/verify-all.ts                  # benchmark 1 gate: 7 steps, no spend
bun verification_bench/verify-all.ts     # benchmark 2 gate
```

Both reset the benchmark graph and stop at the first failure. A red gate means no score
from that cycle is trustworthy.

### Scored runs — these cost money

```bash
bun bench/run.ts --split dev --job my-run --attempts 3
SUT_DIR=../github_issue bun verification_bench/run.ts --split dev --job my-run --attempts 3
bun bench/summarize.ts jobs/my-run                      # scorecard
bun bench/summarize.ts jobs/base-dev jobs/my-run        # before/after diff
```

A dev run at `--attempts 3` is roughly $1.10–$1.20 of `gpt-4o`.

### Scoring a historical version

`verification_bench` takes the tree under test from `SUT_DIR`, so any commit can be scored
without disturbing the working tree:

```bash
git worktree add .worktrees/baseline f5b3184    # the baseline
git worktree add .worktrees/champion ee48387    # the campaign champion
SUT_DIR=../.worktrees/baseline/github_issue \\
  bun verification_bench/run.ts --split dev --job base --attempts 3
```

`verify-sut-switch.ts` refuses to proceed unless the trees are distinct and match their
pinned fingerprints — otherwise two arms could silently score the same code and produce a
convincing "no difference".

### Targeted probe

```bash
bun verification_bench/probe-enum-casing.ts --n 20
```

Asks only the two questions that expose the enum defect, many times, and reports the Cypher
the model actually wrote. Far cheaper than a full run when you only care about that path.

## Rebuilding the corpora

Both corpora are frozen and pinned by `SPLITS.sha256`, checked on every run. Rebuilding
invalidates every score recorded against the old splits, so the builders are one-shot and
deliberately not wired into any workflow. `verification_bench`'s builder needs a
`GITHUB_TOKEN` (it resolves each SWE-bench instance to the issue its PR closed and fetches
that issue live); scored runs never touch the network.

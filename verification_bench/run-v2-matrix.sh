#!/usr/bin/env bash
# The v2 ablation: {baseline, champion} x {no enum doc, enum doc}, per corpus.
#
# B and D differ from A and C only in agent/config.ts, which the ingestion path
# never imports — so each reuses its sibling's graph via --stage qa --keep-graph
# instead of paying for an identical ingest. That is two ingests per corpus, not
# four, and it also makes the comparison exact: B is scored on the very bytes A
# ingested, so nothing but the prompt can differ.
#
# A worktree needs a node_modules symlink or preflight's typecheck fails:
#   git worktree add .worktrees/baseline-enum <commit>
#   ln -s ../../../github_issue/node_modules .worktrees/baseline-enum/github_issue/node_modules
# The fingerprint skips node_modules, so the link does not change the arm.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./github_issue/.env; set +a

ATT=${ATT:-3}
CONC=${CONC:-6}
SPLITS=${SPLITS:-"req-dev sympy2-dev skl-dev mpl-dev"}

run() {  # run <sut> <job> <split> [extra...]
  local sut=$1 job=$2 split=$3; shift 3
  # A failed preflight still writes a report.json, so "the file exists" is not
  # "this job was scored" — require a QA section before skipping.
  if [ -f "verification_bench/jobs/$job/report.json" ] &&
     bun -e "const r=require('./verification_bench/jobs/$job/report.json');process.exit(r.qa?.tasks?.length?0:1)" 2>/dev/null; then
    echo "== skip $job (already scored)"; return
  fi
  echo "== $job  (SUT=$sut)"
  SUT_DIR="$sut" bun verification_bench/run.ts \
    --split "$split" --job "$job" --attempts "$ATT" --qa-concurrency "$CONC" "$@" 2>&1 | tail -6
}

for s in $SPLITS; do
  echo "################ $s ################"
  run ../.worktrees/baseline/github_issue      "A-baseline__$s"       "$s"
  bun verification_bench/score-extraction.ts --split "$s" --job "A-baseline__$s" 2>&1 | tail -6
  run ../.worktrees/baseline-enum/github_issue "B-baseline-enum__$s"  "$s" --stage qa --keep-graph

  run ../.worktrees/champion/github_issue      "C-champion__$s"       "$s"
  bun verification_bench/score-extraction.ts --split "$s" --job "C-champion__$s" 2>&1 | tail -6
  run ../github_issue                          "D-champion-enum__$s"  "$s" --stage qa --keep-graph
done
echo "MATRIX COMPLETE"

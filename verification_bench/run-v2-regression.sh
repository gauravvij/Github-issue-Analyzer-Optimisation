#!/usr/bin/env bash
# Does the free-text/path fix cost anything on the questions already scored?
#
# A fix validated only on the sealed repo is half a result. E is scored on all
# four dev corpora against D's numbers, on a champion-built graph so the only
# difference is agent/config.ts. Ingest-only first, because D's QA is already
# recorded and re-running it would just repay for the same number.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./github_issue/.env; set +a

for S in sympy2-dev skl-dev mpl-dev req-dev; do
  echo "== regraph $S (champion tree)"
  SUT_DIR=../.worktrees/champion/github_issue bun verification_bench/run.ts \
    --split "$S" --job "_regraph-champion-$S" --stage ingest 2>&1 | tail -3
  echo "== E-freetext-fix__$S"
  SUT_DIR=../github_issue bun verification_bench/run.ts \
    --split "$S" --job "E-freetext-fix__$S" --attempts 3 --qa-concurrency 6 \
    --stage qa --keep-graph 2>&1 | grep -E "score:|solved|canaries" || true
done
echo "REGRESSION SWEEP COMPLETE"

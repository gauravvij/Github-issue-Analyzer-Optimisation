#!/usr/bin/env bash
# Re-score arm B on req-dev. Its first attempt died in preflight (the new
# worktree had no node_modules symlink), and the failed run still left a
# report.json, which the driver's original "does the file exist" guard read as
# "already scored". The graph now holds another split, so the baseline tree has
# to rebuild it before B can be scored against the same bytes A saw.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./github_issue/.env; set +a

SUT_DIR=../.worktrees/baseline/github_issue bun verification_bench/run.ts \
  --split req-dev --job _regraph-baseline-req --stage ingest 2>&1 | tail -4

SUT_DIR=../.worktrees/baseline-enum/github_issue bun verification_bench/run.ts \
  --split req-dev --job B-baseline-enum__req-dev --attempts 3 --qa-concurrency 6 \
  --stage qa --keep-graph 2>&1 | tail -6

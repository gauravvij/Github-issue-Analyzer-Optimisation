/**
 * Prove SUT_DIR actually selects the tree it names.
 *
 * The whole point of verification_bench is comparing two implementations. If
 * SUT_DIR silently fell back to the default, both runs would score the SAME
 * code and produce a beautiful, meaningless "no difference" result — the
 * failure mode that looks most like a finding. So the two trees are pinned by
 * fingerprint before any money is spent.
 *
 * The hashes are the ones the campaign reports under bench/jobs recorded:
 * the champion the optimisation loop shipped, and the baseline it was measured
 * against. The algorithm is re-implemented here rather than imported, so this
 * is an independent derivation of the same number bench/run.ts writes.
 *
 *   bun verification_bench/verify-sut-switch.ts
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * Every tree this repository can be scored at, pinned by the fingerprint
 * `bench/run.ts` records in each report. `github_issue/` is the working tree;
 * the historical ones are materialised on demand:
 *
 *   git worktree add .worktrees/baseline <baseline commit>   # SUT is then .worktrees/baseline/github_issue
 *
 * A missing worktree is skipped with a note, not an error — you only need the
 * ones you intend to score.
 */
const PINNED: { dir: string; hash: string; files: number; what: string }[] = [
  { dir: 'github_issue', hash: 'f02bde21fe4ed0fd', files: 19, what: 'HEAD — enum + free-text casing + path anchoring (v2 arm E)' },
  // Arm D, the tree HEAD was before the v2 question set found two more instances
  // of the same defect. Preserved so the fix has something to be measured against:
  //   git worktree add .worktrees/champion-enum <the commit before the fix>
  { dir: '.worktrees/champion-enum/github_issue', hash: '73acfdc375576226', files: 19, what: 'champion + documented Issue.state enum (v2 arm D)' },
  { dir: '.worktrees/baseline/github_issue', hash: '71c696b48a9da953', files: 18, what: 'baseline (baseline-n3 anchor)' },
  { dir: '.worktrees/champion/github_issue', hash: '9eeb557db3e87c2d', files: 19, what: 'campaign champion (h9-confirm, sealed holdout)' },
  // The v2 ablation's missing cell: baseline with ONLY the Issue.state enum
  // documented, so the fix can be attributed on its own rather than inferred
  // from the champion. Created with:
  //   git worktree add .worktrees/baseline-enum f5b3184
  // then the one-line schema change from f195ffb applied to agent/config.ts.
  { dir: '.worktrees/baseline-enum/github_issue', hash: '50bf9c564c4d8a20', files: 18, what: 'baseline + documented Issue.state enum (v2 arm B)' },
];

function fingerprint(sut: string): { hash: string; files: number } {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
        walk(p);
      } else if (/\.(ts|json|yml)$/.test(entry)) {
        files.push(p);
      }
    }
  };
  for (const d of ['src', 'agent', 'ingestion']) walk(join(sut, d));
  for (const f of ['package.json', 'bun.lock']) {
    if (existsSync(join(sut, f))) files.push(join(sut, f));
  }
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(sut, f));
    h.update(readFileSync(f));
  }
  return { hash: h.digest('hex').slice(0, 16), files: files.length };
}

let failed = false;
let checked = 0;
const seen = new Set<string>();
for (const pin of PINNED) {
  if (!existsSync(join(ROOT, pin.dir, 'package.json'))) {
    console.log(`  skip ${pin.dir.padEnd(22)} not materialised — ${pin.what}`);
    continue;
  }
  checked++;
  const got = fingerprint(join(ROOT, pin.dir));
  const ok = got.hash === pin.hash && got.files === pin.files;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${pin.dir.padEnd(22)} ${got.hash} (${got.files} files) — ${pin.what}`,
  );
  if (!ok) {
    console.log(`       expected ${pin.hash} (${pin.files} files)`);
    failed = true;
  }
  seen.add(got.hash);
}

if (seen.size !== checked) {
  console.log('  FAIL the materialised trees are not distinct — two arms would score the same code');
  failed = true;
}

if (failed) {
  console.error('\nSUT pinning FAILED — a champion-vs-baseline comparison would be meaningless.');
  process.exit(1);
}
console.log(`\nSUT pinning ok: ${checked} distinct tree(s), each matching its pinned fingerprint.`);

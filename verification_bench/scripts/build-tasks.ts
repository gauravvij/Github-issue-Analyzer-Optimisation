/**
 * Generate the verification question set from a frozen corpus.
 *
 * DERIVED FROM bench/scripts/build-tasks.ts BY verification_bench/derive.ts —
 * DO NOT EDIT. The only behavioural change is `stableTerms`: bench/ hardcodes a
 * huggingface/datasets vocabulary there, which is meaningless for another repo.
 *
 * Every question's answer is COMPUTED from the corpus, not written by a model.
 * That makes grading deterministic (substring / set comparison) for all but a
 * handful of summarisation questions, which keeps run-to-run variance low
 * enough that a 2-point score move means something.
 *
 * Templates only emit a question when the oracle is unambiguous — no ties for
 * "the most", no near-miss numbers, no term whose match set depends on casing.
 * An ambiguous question is worse than no question: it scores noise.
 *
 * Run ONCE per corpus. Output is frozen alongside the corpus.
 *
 *   bun bench/scripts/build-tasks.ts
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Corpus, CorpusIssue } from '../../bench/scripts/build-corpus';

const CORPUS_DIR = join(import.meta.dirname, '..', 'corpus');
const OUT_DIR = join(import.meta.dirname, '..', 'tasks');

const QUOTA = { dev: 40, holdout: 20 };

// ---------------------------------------------------------------------------
// Task shape
// ---------------------------------------------------------------------------

export type Check =
  | { type: 'number'; value: number; forbid?: number[] }
  | { type: 'contains_all'; values: string[]; forbid?: string[] }
  | { type: 'issue_set'; expect: number[]; mode: 'exact' | 'superset'; forbid?: number[] }
  | { type: 'judge'; rubric: string; reference: string };

export interface Task {
  id: string;
  template: string;
  /** structural = graph shape/counts, retrieval = find issues by content,
   *  semantic = free-text quality (judge-graded). */
  kind: 'structural' | 'retrieval' | 'semantic';
  /** A canary failing means the HARNESS is broken, not the agent. */
  canary?: boolean;
  question: string;
  check: Check;
  /** Human-readable expected answer, for debugging failures. */
  oracle: string;
}

// ---------------------------------------------------------------------------
// Oracle helpers
// ---------------------------------------------------------------------------

const yyyymm = (iso: string) => iso.slice(0, 7);

function countBy<T>(items: T[], key: (t: T) => string | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k == null) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Strict argmax — returns null on a tie, so "which has the most" is never ambiguous. */
function strictMax<T>(items: T[], score: (t: T) => number): T | null {
  let best: T | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let tied = false;
  for (const it of items) {
    const s = score(it);
    if (s > bestScore) {
      best = it;
      bestScore = s;
      tied = false;
    } else if (s === bestScore) {
      tied = true;
    }
  }
  return tied || bestScore <= 0 ? null : best;
}

/** Distinctive words from a title, for checking the agent quoted the right issue. */
function titleTerms(title: string, n: number): string[] {
  const stop = new Set([
    'the','a','an','of','to','in','on','for','and','or','with','is','are','when','how','not',
    'from','by','it','this','that','be','as','at','can','if','using','use','via','no','error',
  ]);
  return title
    .split(/[^A-Za-z0-9_.]+/)
    .filter((w) => w.length > 3 && !stop.has(w.toLowerCase()))
    .slice(0, n);
}

function issueText(i: CorpusIssue): string {
  return `${i.title}\n${i.bodyText}`;
}

/**
 * Terms that appear in a stable, unambiguous number of issues AND whose match
 * set is identical case-sensitively and case-insensitively — otherwise the
 * oracle and the agent's Cypher can legitimately disagree.
 */
function stableTerms(issues: CorpusIssue[], min: number, max: number): { term: string; hits: number[] }[] {
  // Mined from the corpus rather than hand-listed, so the generator is
  // corpus-independent instead of swapping one repo's vocabulary for another's.
  // Deterministic: frequency desc, then alphabetical, capped so the O(terms x
  // issues) scan below stays cheap. The case-stability filter still applies.
  const freq = new Map<string, number>();
  for (const issue of issues) {
    for (const word of new Set(issueText(issue).match(/[A-Za-z_][A-Za-z0-9_.]{3,}/g) ?? [])) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  const candidates = [...freq.entries()]
    .filter(([, n]) => n >= min && n <= max)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 200)
    .map(([word]) => word);
  const out: { term: string; hits: number[] }[] = [];
  for (const term of candidates) {
    const cs = issues.filter((i) => issueText(i).includes(term)).map((i) => i.number);
    const ci = issues
      .filter((i) => issueText(i).toLowerCase().includes(term.toLowerCase()))
      .map((i) => i.number);
    if (cs.length !== ci.length) continue; // casing-dependent -> ambiguous
    if (cs.length < min || cs.length > max) continue;
    out.push({ term, hits: cs.sort((a, b) => a - b) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** A forbidden value that IS the answer makes a task unpassable. Never intended. */
function dropSelfForbids(check: Check): Check {
  switch (check.type) {
    case 'number':
      return { ...check, forbid: check.forbid?.filter((v) => v !== check.value) };
    case 'issue_set':
      return { ...check, forbid: check.forbid?.filter((v) => !check.expect.includes(v)) };
    case 'contains_all':
      return { ...check, forbid: check.forbid?.filter((v) => !check.values.includes(v)) };
    default:
      return check;
  }
}

function buildTasks(corpus: Corpus, split: string, quota: number): Task[] {
  const issues = corpus.issues;
  const repo = `${corpus.meta.owner}/${corpus.meta.repo}`;
  const tasks: Task[] = [];
  let seq = 0;
  const add = (t: Omit<Task, 'id'>) => {
    tasks.push({ id: `${split}-${String(++seq).padStart(3, '0')}`, ...t, check: dropSelfForbids(t.check) });
  };

  const open = issues.filter((i) => i.state === 'OPEN');
  const closed = issues.filter((i) => i.state === 'CLOSED');
  const totalComments = issues.reduce((s, i) => s + i.totalComments, 0);
  const labelCounts = countBy(
    issues.flatMap((i) => i.labels.nodes.map((l) => ({ n: l.name }))),
    (x) => x.n,
  );
  const authorCounts = countBy(issues, (i) => i.author?.login);

  // --- canaries: if these fail the harness is broken, not the agent ---------
  add({
    template: 'total_issues',
    kind: 'structural',
    canary: true,
    question: `How many issues are in the knowledge graph in total?`,
    check: { type: 'number', value: issues.length, forbid: [issues.length * 2] },
    oracle: `${issues.length}`,
  });
  add({
    template: 'total_comments',
    kind: 'structural',
    canary: true,
    question: `How many comments are stored across all issues in total?`,
    check: { type: 'number', value: totalComments, forbid: [totalComments * 2] },
    oracle: `${totalComments}`,
  });

  // --- counts --------------------------------------------------------------
  add({
    template: 'open_count',
    kind: 'structural',
    question: `How many issues are currently open?`,
    check: { type: 'number', value: open.length, forbid: [closed.length, issues.length] },
    oracle: `${open.length}`,
  });
  add({
    template: 'closed_count',
    kind: 'structural',
    question: `How many issues are closed?`,
    check: { type: 'number', value: closed.length, forbid: [open.length, issues.length] },
    oracle: `${closed.length}`,
  });
  add({
    template: 'distinct_labels',
    kind: 'structural',
    question: `How many distinct labels exist in the knowledge graph?`,
    check: { type: 'number', value: labelCounts.size },
    oracle: `${labelCounts.size}`,
  });
  add({
    template: 'distinct_authors',
    kind: 'structural',
    question: `How many distinct users have authored issues in the knowledge graph?`,
    check: { type: 'number', value: authorCounts.size, forbid: [issues.length] },
    oracle: `${authorCounts.size}`,
  });
  const zeroComment = issues.filter((i) => i.totalComments === 0);
  if (zeroComment.length > 0) {
    add({
      template: 'zero_comment_count',
      kind: 'structural',
      question: `How many issues have no comments at all?`,
      check: { type: 'number', value: zeroComment.length },
      oracle: `${zeroComment.length}`,
    });
  }

  // --- superlatives (only when strictly unambiguous) ------------------------
  const mostComments = strictMax(issues, (i) => i.totalComments);
  if (mostComments) {
    add({
      template: 'most_comments',
      kind: 'structural',
      question: `Which issue has the most comments? Give its issue number.`,
      check: { type: 'issue_set', expect: [mostComments.number], mode: 'superset' },
      oracle: `#${mostComments.number} (${mostComments.totalComments} comments)`,
    });
  }
  const mostReactions = strictMax(issues, (i) => i.reactions.totalCount);
  if (mostReactions) {
    add({
      template: 'most_reactions',
      kind: 'structural',
      question: `Which issue has received the most reactions? Give its issue number.`,
      check: { type: 'issue_set', expect: [mostReactions.number], mode: 'superset' },
      oracle: `#${mostReactions.number} (${mostReactions.reactions.totalCount} reactions)`,
    });
  }
  const mostProlific = [...authorCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (mostProlific.length > 1 && mostProlific[0][1] > mostProlific[1][1]) {
    add({
      template: 'top_author',
      kind: 'structural',
      question: `Which user has authored the most issues, and how many did they author?`,
      check: { type: 'contains_all', values: [mostProlific[0][0], String(mostProlific[0][1])] },
      oracle: `${mostProlific[0][0]} (${mostProlific[0][1]})`,
    });
  }

  // --- recency -------------------------------------------------------------
  const recent5 = [...issues]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);
  add({
    template: 'recent_5',
    kind: 'structural',
    question: `List the 5 most recently created issues. Give their issue numbers.`,
    check: { type: 'issue_set', expect: recent5.map((i) => i.number), mode: 'exact' },
    oracle: recent5.map((i) => `#${i.number}`).join(', '),
  });

  // --- per-label -----------------------------------------------------------
  for (const [label, count] of [...labelCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const members = issues
      .filter((i) => i.labels.nodes.some((l) => l.name === label))
      .map((i) => i.number)
      .sort((a, b) => a - b);
    if (count >= 2) {
      add({
        template: 'label_count',
        kind: 'structural',
        question: `How many issues carry the label "${label}"?`,
        check: { type: 'number', value: count, forbid: [issues.length] },
        oracle: `${count}`,
      });
    }
    if (members.length >= 2 && members.length <= 8) {
      add({
        template: 'label_members',
        kind: 'structural',
        question: `List the issue numbers of every issue labelled "${label}".`,
        check: { type: 'issue_set', expect: members, mode: 'exact' },
        oracle: members.map((n) => `#${n}`).join(', '),
      });
    }
  }

  // --- per-month -----------------------------------------------------------
  const monthCounts = countBy(issues, (i) => yyyymm(i.createdAt));
  for (const [month, count] of [...monthCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    if (count < 2) continue;
    add({
      template: 'month_count',
      kind: 'structural',
      question: `How many issues were created in ${month}?`,
      check: { type: 'number', value: count, forbid: [issues.length] },
      oracle: `${count}`,
    });
  }

  // --- per-author ----------------------------------------------------------
  for (const [login, count] of [...authorCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < 2 || count > 4) continue;
    const members = issues
      .filter((i) => i.author?.login === login)
      .map((i) => i.number)
      .sort((a, b) => a - b);
    add({
      template: 'author_issues',
      kind: 'structural',
      question: `Which issues were opened by the user "${login}"? Give their issue numbers.`,
      check: { type: 'issue_set', expect: members, mode: 'exact' },
      oracle: members.map((n) => `#${n}`).join(', '),
    });
  }

  // --- per-issue facts -----------------------------------------------------
  const withComments = issues.filter((i) => i.totalComments >= 3).sort((a, b) => a.number - b.number);
  for (const issue of withComments) {
    add({
      template: 'issue_comment_count',
      kind: 'structural',
      question: `How many comments does issue #${issue.number} have?`,
      check: { type: 'number', value: issue.totalComments, forbid: [issue.totalComments + 1] },
      oracle: `${issue.totalComments}`,
    });
  }
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const terms = titleTerms(issue.title, 3);
    if (terms.length >= 3) {
      add({
        template: 'issue_title',
        kind: 'retrieval',
        question: `What is the title of issue #${issue.number}?`,
        check: { type: 'contains_all', values: terms },
        oracle: issue.title,
      });
    }
    if (issue.author?.login) {
      add({
        template: 'issue_author',
        kind: 'retrieval',
        question: `Who opened issue #${issue.number}?`,
        check: { type: 'contains_all', values: [issue.author.login] },
        oracle: issue.author.login,
      });
    }
  }

  // --- content retrieval ---------------------------------------------------
  for (const { term, hits } of stableTerms(issues, 2, 6)) {
    add({
      template: 'mentions_term',
      kind: 'retrieval',
      question: `Which issues mention "${term}" in their title or body? Give their issue numbers.`,
      check: { type: 'issue_set', expect: hits, mode: 'exact' },
      oracle: hits.map((n) => `#${n}`).join(', '),
    });
  }

  // --- semantic (judge-graded) --------------------------------------------
  const summarisable = issues
    .filter((i) => i.totalComments >= 4)
    .sort((a, b) => b.totalComments - a.totalComments)
    .slice(0, 8);
  for (const issue of summarisable) {
    // The agent reads the whole issue from the graph, so the judge gets the
    // whole issue too. A truncated reference makes a correct, fuller answer
    // look like it invented things, which pinned this metric at zero.
    const reference = [
      `Issue #${issue.number} in ${repo}`,
      `Title: ${issue.title}`,
      `State: ${issue.state}`,
      `Author: ${issue.author?.login ?? 'unknown'}`,
      `Comments: ${issue.totalComments}`,
      `Body: ${issue.bodyText.slice(0, 6000)}`,
      `Comments:\n${issue.comments.map((c, i) => `[${i + 1}] ${c.bodyText.slice(0, 1200)}`).join('\n')}`,
    ].join('\n');
    add({
      template: 'summarize_issue',
      kind: 'semantic',
      question: `Summarize the discussion on issue #${issue.number}. What is the problem and what did people say about it?`,
      check: {
        type: 'judge',
        rubric:
          `Judge whether the answer is a usable summary of issue #${issue.number}.\n\n` +
          `PASS if ALL of these hold:\n` +
          `  1. it is about the same issue as the reference — the same core problem or request;\n` +
          `  2. it contradicts none of the reference facts (title, state, author, comment count);\n` +
          `  3. it is not a refusal, an error, or a claim that no data was found.\n\n` +
          `FAIL only if one of those is violated, or if the summary is so vague it could ` +
          `describe any issue.\n\n` +
          `Do NOT fail an answer for: including detail the reference does not mention; ` +
          `omitting detail the reference does mention; or differing in structure, length or ` +
          `emphasis. Completeness is not being graded — only "same issue, nothing contradicted".`,
        reference,
      },
      oracle: issue.title,
    });
  }

  // --- select the quota ----------------------------------------------------
  return selectQuota(tasks, quota, split);
}

/**
 * Pick `quota` tasks with a fixed template mix. Canaries always in; semantic
 * capped so judge noise cannot dominate; the rest round-robins across
 * templates so no single template can be gamed into the whole score.
 */
function selectQuota(all: Task[], quota: number, split: string): Task[] {
  const semanticCap = Math.max(2, Math.round(quota * 0.125));
  const chosen: Task[] = all.filter((t) => t.canary);
  const taken = new Set(chosen.map((t) => t.id));

  const semantic = all.filter((t) => t.kind === 'semantic' && !taken.has(t.id)).slice(0, semanticCap);
  for (const t of semantic) {
    chosen.push(t);
    taken.add(t.id);
  }

  const byTemplate = new Map<string, Task[]>();
  for (const t of all) {
    if (taken.has(t.id) || t.kind === 'semantic') continue;
    if (!byTemplate.has(t.template)) byTemplate.set(t.template, []);
    byTemplate.get(t.template)!.push(t);
  }
  const templates = [...byTemplate.keys()].sort();
  while (chosen.length < quota) {
    let progressed = false;
    for (const name of templates) {
      if (chosen.length >= quota) break;
      const next = byTemplate.get(name)!.shift();
      if (next) {
        chosen.push(next);
        taken.add(next.id);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  if (chosen.length < quota) {
    throw new Error(`${split}: only ${chosen.length} tasks available, quota ${quota}`);
  }

  // Renumber so ids are contiguous and stable for the frozen file.
  return chosen
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t, i) => ({ ...t, id: `${split}-${String(i + 1).padStart(3, '0')}` }));
}

// ---------------------------------------------------------------------------

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [split, quota] of Object.entries(QUOTA)) {
    const corpus = JSON.parse(readFileSync(join(CORPUS_DIR, `${split}.json`), 'utf-8')) as Corpus;
    const tasks = buildTasks(corpus, split, quota);
    const path = join(OUT_DIR, `${split}.jsonl`);
    writeFileSync(path, `${tasks.map((t) => JSON.stringify(t)).join('\n')}\n`);

    const mix = countBy(tasks, (t) => t.kind);
    const tmpl = countBy(tasks, (t) => t.template);
    console.log(`${split}: ${tasks.length} tasks -> ${path}`);
    console.log(`  kinds: ${[...mix].map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`  templates: ${[...tmpl].sort().map(([k, v]) => `${k}:${v}`).join(' ')}`);
  }
}

main();

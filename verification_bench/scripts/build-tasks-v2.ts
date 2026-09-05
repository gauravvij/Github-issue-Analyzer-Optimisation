/**
 * Generate a stratified v2 question set from a frozen v2 corpus.
 *
 * Two things change from scripts/build-tasks.ts, whose oracle helpers this
 * imports rather than copying:
 *
 * 1. STRATA. Every question carries a `stratum`, and the quota is filled by
 *    explicit per-stratum weights instead of an alphabetical round-robin over
 *    templates. Without that a result cannot decompose: the campaign's whole
 *    measured gain was two questions out of thirty-five, and the aggregate
 *    percentage hid that completely.
 *
 * 2. NEW STRATA the old generator had no question for at all — true zeros,
 *    multi-hop traversals, date ranges, label casing, and paraphrases of one
 *    underlying query. The true-zero questions matter most: the enum fix moved
 *    the agent from wrong-zero to nonzero, and nothing so far checks that it
 *    did not simply learn that zero is always a suspicious answer.
 *
 * Every oracle is still COMPUTED from the corpus, and a template still emits
 * nothing when the answer would be ambiguous. That rule is what keeps a
 * two-point move signal rather than noise.
 *
 *   bun verification_bench/scripts/build-tasks-v2.ts --split skl-dev
 *   bun verification_bench/scripts/build-tasks-v2.ts --all
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Corpus, CorpusIssue } from '../../bench/scripts/build-corpus';
import type { Check, Task } from '../../bench/scripts/build-tasks';
import {
  countBy,
  dropSelfForbids,
  issueText,
  stableTerms,
  strictMax,
  titleTerms,
  yyyymm,
} from './build-tasks';

const CORPUS_DIR = join(import.meta.dirname, '..', 'corpus');
const OUT_DIR = join(import.meta.dirname, '..', 'tasks');

export const STRATA = [
  'canary',
  'enum_state',
  'label',
  'author',
  'date_range',
  'aggregation',
  'text_search',
  'multi_hop',
  'true_zero',
  'paraphrase',
  'semantic',
] as const;
export type Stratum = (typeof STRATA)[number];

/** Target questions per stratum, per corpus. Sums to the quota. */
const WEIGHTS: Record<Stratum, number> = {
  canary: 2,
  enum_state: 7,
  label: 5,
  author: 4,
  date_range: 5,
  aggregation: 5,
  text_search: 3,
  multi_hop: 4,
  true_zero: 5,
  paraphrase: 4,
  semantic: 6, // 12% — the judge is noisy, so it never dominates a split
};
const QUOTA = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

export interface TaskV2 extends Task {
  stratum: Stratum;
  /** Questions asking the same thing in different words share this. */
  paraphraseGroup?: string;
}

// ---------------------------------------------------------------------------
// Helpers the old generator has no equivalent of
// ---------------------------------------------------------------------------

const ymd = (iso: string) => iso.slice(0, 10);

/**
 * A date on which NO issue was created, so "before" and "on or before" give the
 * same answer. A boundary that lands on an issue makes the question ambiguous
 * and the oracle a coin flip.
 */
function cleanBoundaries(issues: CorpusIssue[]): string[] {
  const taken = new Set(issues.map((i) => ymd(i.createdAt)));
  const days = [...new Set(issues.map((i) => i.createdAt))].sort();
  const out: string[] = [];
  for (let q = 1; q <= 3; q++) {
    const anchor = days[Math.floor((days.length * q) / 4)];
    if (!anchor) continue;
    // Walk forward to the first date nobody used.
    for (let d = 0; d < 400; d++) {
      const day = new Date(new Date(anchor).getTime() + d * 86_400_000).toISOString().slice(0, 10);
      if (!taken.has(day)) {
        if (!out.includes(day)) out.push(day);
        break;
      }
    }
  }
  return out;
}

/** Distinct commenter logins on an issue. */
const commenters = (i: CorpusIssue) =>
  new Set(i.comments.map((c) => (c.author as { login: string } | null)?.login).filter(Boolean) as string[]);

/** Labels/terms/authors that exist in SIBLING corpora but not in this one. */
interface Foreign {
  labels: string[];
  terms: string[];
  authors: string[];
}

function foreignPool(self: Corpus): Foreign {
  const mine = {
    labels: new Set(self.issues.flatMap((i) => i.labels.nodes.map((l) => l.name.toLowerCase()))),
    authors: new Set(self.issues.map((i) => i.author?.login.toLowerCase()).filter(Boolean) as string[]),
  };
  const myText = self.issues.map((i) => issueText(i).toLowerCase()).join('\n');

  const labels = new Set<string>();
  const terms = new Set<string>();
  const authors = new Set<string>();
  for (const file of readdirSync(CORPUS_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const split = file.replace(/\.json$/, '');
    // Never mine the sealed holdout — nothing about it should reach a dev split.
    if (split === self.meta.split || split.includes('holdout')) continue;
    const other = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf-8')) as Corpus;
    for (const i of other.issues) {
      for (const l of i.labels.nodes) {
        if (!mine.labels.has(l.name.toLowerCase()) && !myText.includes(l.name.toLowerCase())) labels.add(l.name);
      }
      if (i.author && !mine.authors.has(i.author.login.toLowerCase()) && !myText.includes(i.author.login.toLowerCase())) {
        authors.add(i.author.login);
      }
    }
    for (const { term } of stableTerms(other.issues, 3, 30)) {
      if (!myText.includes(term.toLowerCase())) terms.add(term);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return { labels: sorted(labels), terms: sorted(terms), authors: sorted(authors) };
}

// ---------------------------------------------------------------------------

function buildTasks(corpus: Corpus, split: string, foreign: Foreign): TaskV2[] {
  const issues = corpus.issues;
  const repo = `${corpus.meta.owner}/${corpus.meta.repo}`;
  const tasks: TaskV2[] = [];
  let seq = 0;
  const add = (t: Omit<TaskV2, 'id'>) => {
    tasks.push({ id: `${split}-${String(++seq).padStart(3, '0')}`, ...t, check: dropSelfForbids(t.check) });
  };

  const open = issues.filter((i) => i.state === 'OPEN');
  const closed = issues.filter((i) => i.state === 'CLOSED');
  const totalComments = issues.reduce((s, i) => s + i.totalComments, 0);
  const labelCounts = countBy(issues.flatMap((i) => i.labels.nodes.map((l) => ({ n: l.name }))), (x) => x.n);
  const authorCounts = countBy(issues, (i) => i.author?.login);
  const byLabel = (label: string) => issues.filter((i) => i.labels.nodes.some((l) => l.name === label));

  // === canary ==============================================================
  add({
    template: 'total_issues', stratum: 'canary', kind: 'structural', canary: true,
    question: `How many issues are in the knowledge graph in total?`,
    check: { type: 'number', value: issues.length, forbid: [issues.length * 2] },
    oracle: `${issues.length}`,
  });
  add({
    template: 'total_comments', stratum: 'canary', kind: 'structural', canary: true,
    question: `How many comments are stored across all issues in total?`,
    check: { type: 'number', value: totalComments, forbid: [totalComments * 2] },
    oracle: `${totalComments}`,
  });

  // === enum_state ==========================================================
  // The defect this whole benchmark exists to measure: Issue.state is stored
  // uppercase, and a query written with 'open' returns nothing at all.
  add({
    template: 'open_count', stratum: 'enum_state', kind: 'structural',
    question: `How many issues are currently open?`,
    check: { type: 'number', value: open.length, forbid: [closed.length, issues.length] },
    oracle: `${open.length}`,
  });
  add({
    template: 'closed_count', stratum: 'enum_state', kind: 'structural',
    question: `How many issues are closed?`,
    check: { type: 'number', value: closed.length, forbid: [open.length, issues.length] },
    oracle: `${closed.length}`,
    paraphraseGroup: 'closed_count',
  });
  for (const i of [...issues].sort((a, b) => a.number - b.number).slice(0, 6)) {
    add({
      template: 'state_of_issue', stratum: 'enum_state', kind: 'retrieval',
      question: `Is issue #${i.number} open or closed?`,
      check: { type: 'contains_all', values: [i.state === 'OPEN' ? 'open' : 'closed'] },
      oracle: i.state,
    });
  }
  for (const [label] of [...labelCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const members = byLabel(label);
    const o = members.filter((i) => i.state === 'OPEN');
    const c = members.filter((i) => i.state === 'CLOSED');
    if (o.length >= 1 && c.length >= 1) {
      add({
        template: 'open_label_count', stratum: 'enum_state', kind: 'structural',
        question: `How many OPEN issues carry the label "${label}"?`,
        check: { type: 'number', value: o.length, forbid: [members.length, c.length] },
        oracle: `${o.length}`,
      });
    }
    if (o.length >= 2 && o.length <= 8) {
      add({
        template: 'open_with_label', stratum: 'enum_state', kind: 'structural',
        question: `List the issue numbers of every OPEN issue labelled "${label}".`,
        check: { type: 'issue_set', expect: o.map((i) => i.number).sort((a, b) => a - b), mode: 'exact' },
        oracle: o.map((i) => `#${i.number}`).join(', '),
      });
    }
  }

  // === label ===============================================================
  add({
    template: 'distinct_labels', stratum: 'label', kind: 'structural',
    question: `How many distinct labels exist in the knowledge graph?`,
    check: { type: 'number', value: labelCounts.size },
    oracle: `${labelCounts.size}`,
  });
  for (const [label, count] of [...labelCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const members = byLabel(label).map((i) => i.number).sort((a, b) => a - b);
    if (count >= 2) {
      add({
        template: 'label_count', stratum: 'label', kind: 'structural',
        question: `How many issues carry the label "${label}"?`,
        check: { type: 'number', value: count, forbid: [issues.length] },
        oracle: `${count}`,
      });
    }
    if (members.length >= 2 && members.length <= 8) {
      add({
        template: 'label_members', stratum: 'label', kind: 'structural',
        question: `List the issue numbers of every issue labelled "${label}".`,
        check: { type: 'issue_set', expect: members, mode: 'exact' },
        oracle: members.map((n) => `#${n}`).join(', '),
      });
    }
    // Ask with the casing a human would type. Only safe when exactly one stored
    // label matches case-insensitively, otherwise the oracle is ambiguous.
    const lower = label.toLowerCase();
    const collisions = [...labelCounts.keys()].filter((l) => l.toLowerCase() === lower);
    if (lower !== label && collisions.length === 1 && count >= 2) {
      add({
        template: 'label_natural_casing', stratum: 'label', kind: 'structural',
        question: `How many issues are tagged "${lower}"?`,
        check: { type: 'number', value: count, forbid: [issues.length] },
        oracle: `${count} (stored as "${label}")`,
      });
    }
  }

  // === author ==============================================================
  add({
    template: 'distinct_authors', stratum: 'author', kind: 'structural',
    question: `How many distinct users have authored issues in the knowledge graph?`,
    check: { type: 'number', value: authorCounts.size, forbid: [issues.length] },
    oracle: `${authorCounts.size}`,
    paraphraseGroup: 'distinct_authors',
  });
  const prolific = [...authorCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (prolific.length > 1 && prolific[0][1] > prolific[1][1]) {
    add({
      template: 'top_author', stratum: 'author', kind: 'structural',
      question: `Which user has authored the most issues, and how many did they author?`,
      check: { type: 'contains_all', values: [prolific[0][0], String(prolific[0][1])] },
      oracle: `${prolific[0][0]} (${prolific[0][1]})`,
    });
  }
  for (const [login, count] of prolific) {
    if (count < 2 || count > 4) continue;
    const members = issues.filter((i) => i.author?.login === login).map((i) => i.number).sort((a, b) => a - b);
    add({
      template: 'author_issues', stratum: 'author', kind: 'structural',
      question: `Which issues were opened by the user "${login}"? Give their issue numbers.`,
      check: { type: 'issue_set', expect: members, mode: 'exact' },
      oracle: members.map((n) => `#${n}`).join(', '),
    });
  }
  for (const i of [...issues].sort((a, b) => a.number - b.number)) {
    if (i.author?.login) {
      add({
        template: 'issue_author', stratum: 'author', kind: 'retrieval',
        question: `Who opened issue #${i.number}?`,
        check: { type: 'contains_all', values: [i.author.login] },
        oracle: i.author.login,
      });
    }
    const people = commenters(i);
    if (i.totalComments >= 3 && people.size >= 2) {
      add({
        template: 'commenter_count', stratum: 'author', kind: 'structural',
        question: `How many distinct users have commented on issue #${i.number}?`,
        check: { type: 'number', value: people.size, forbid: [i.totalComments] },
        oracle: `${people.size}`,
      });
    }
  }

  // === date_range ==========================================================
  const monthCounts = countBy(issues, (i) => yyyymm(i.createdAt));
  for (const [month, count] of [...monthCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    if (count < 2) continue;
    add({
      template: 'month_count', stratum: 'date_range', kind: 'structural',
      question: `How many issues were created in ${month}?`,
      check: { type: 'number', value: count, forbid: [issues.length] },
      oracle: `${count}`,
    });
  }
  const bounds = cleanBoundaries(issues);
  for (const day of bounds) {
    const before = issues.filter((i) => ymd(i.createdAt) < day).length;
    if (before >= 2 && before <= issues.length - 2) {
      add({
        template: 'created_before', stratum: 'date_range', kind: 'structural',
        question: `How many issues were created before ${day}?`,
        check: { type: 'number', value: before, forbid: [issues.length] },
        oracle: `${before}`,
      });
      add({
        template: 'created_after', stratum: 'date_range', kind: 'structural',
        question: `How many issues were created after ${day}?`,
        check: { type: 'number', value: issues.length - before, forbid: [issues.length] },
        oracle: `${issues.length - before}`,
      });
    }
  }
  if (bounds.length >= 2) {
    const [a, b] = [bounds[0], bounds[bounds.length - 1]];
    const between = issues.filter((i) => ymd(i.createdAt) > a && ymd(i.createdAt) < b).length;
    if (between >= 2 && between <= issues.length - 2) {
      add({
        template: 'created_between', stratum: 'date_range', kind: 'structural',
        question: `How many issues were created between ${a} and ${b}?`,
        check: { type: 'number', value: between, forbid: [issues.length] },
        oracle: `${between}`,
      });
    }
  }

  // === aggregation =========================================================
  const zeroComment = issues.filter((i) => i.totalComments === 0);
  if (zeroComment.length > 0) {
    add({
      template: 'zero_comment_count', stratum: 'aggregation', kind: 'structural',
      question: `How many issues have no comments at all?`,
      check: { type: 'number', value: zeroComment.length },
      oracle: `${zeroComment.length}`,
    });
  }
  const mostComments = strictMax(issues, (i: CorpusIssue) => i.totalComments);
  if (mostComments) {
    add({
      template: 'most_comments', stratum: 'aggregation', kind: 'structural',
      question: `Which issue has the most comments? Give its issue number.`,
      check: { type: 'issue_set', expect: [mostComments.number], mode: 'superset' },
      oracle: `#${mostComments.number} (${mostComments.totalComments} comments)`,
    });
  }
  const mostReactions = strictMax(issues, (i: CorpusIssue) => i.reactions.totalCount);
  if (mostReactions) {
    add({
      template: 'most_reactions', stratum: 'aggregation', kind: 'structural',
      question: `Which issue has received the most reactions? Give its issue number.`,
      check: { type: 'issue_set', expect: [mostReactions.number], mode: 'superset' },
      oracle: `#${mostReactions.number} (${mostReactions.reactions.totalCount} reactions)`,
    });
  }
  for (const n of [3, 5, 10, 20]) {
    const count = issues.filter((i) => i.totalComments >= n).length;
    if (count >= 2 && count <= issues.length - 2) {
      add({
        template: 'issues_with_ge_n_comments', stratum: 'aggregation', kind: 'structural',
        question: `How many issues have at least ${n} comments?`,
        check: { type: 'number', value: count, forbid: [issues.length] },
        oracle: `${count}`,
      });
    }
  }
  for (const i of issues.filter((x) => x.totalComments >= 3).sort((a, b) => a.number - b.number)) {
    add({
      template: 'issue_comment_count', stratum: 'aggregation', kind: 'structural',
      question: `How many comments does issue #${i.number} have?`,
      check: { type: 'number', value: i.totalComments, forbid: [i.totalComments + 1] },
      oracle: `${i.totalComments}`,
    });
  }

  // === text_search =========================================================
  for (const i of [...issues].sort((a, b) => a.number - b.number)) {
    const terms = titleTerms(i.title, 3);
    if (terms.length >= 3) {
      add({
        template: 'issue_title', stratum: 'text_search', kind: 'retrieval',
        question: `What is the title of issue #${i.number}?`,
        check: { type: 'contains_all', values: terms },
        oracle: i.title,
      });
    }
  }
  for (const { term, hits } of stableTerms(issues, 2, 6)) {
    add({
      template: 'mentions_term', stratum: 'text_search', kind: 'retrieval',
      question: `Which issues mention "${term}" in their title or body? Give their issue numbers.`,
      check: { type: 'issue_set', expect: hits, mode: 'exact' },
      oracle: hits.map((n: number) => `#${n}`).join(', '),
    });
  }

  // === multi_hop ===========================================================
  for (const [label] of [...labelCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const members = byLabel(label);
    const people = new Set<string>();
    for (const i of members) for (const p of commenters(i)) people.add(p);
    if (people.size >= 2 && people.size <= 6) {
      add({
        template: 'commenters_on_label', stratum: 'multi_hop', kind: 'retrieval',
        question: `Which users have commented on issues labelled "${label}"? Give their usernames.`,
        check: { type: 'contains_all', values: [...people].sort() },
        oracle: [...people].sort().join(', '),
      });
    }
    const co = new Set<string>();
    for (const i of members) for (const l of i.labels.nodes) if (l.name !== label) co.add(l.name);
    if (co.size >= 2 && co.size <= 5) {
      const expect = [...co].sort();
      // `contains_all` is superset-only, so without a forbid list an answer that
      // simply names every label in the repo would score. Forbid the labels that
      // do NOT co-occur — skipping any that overlap an expected name as a
      // substring, since the grader matches substrings and would misfire.
      const forbid = [...labelCounts.keys()].filter(
        (l) =>
          l !== label &&
          // A short or numeric label ("3.0") turns up incidentally in prose and
          // would fail a correct answer, so it is never forbidden.
          l.length >= 4 &&
          /[A-Za-z]{3}/.test(l) &&
          !co.has(l) &&
          !expect.some((e) => e.toLowerCase().includes(l.toLowerCase()) || l.toLowerCase().includes(e.toLowerCase())) &&
          !label.toLowerCase().includes(l.toLowerCase()) &&
          !l.toLowerCase().includes(label.toLowerCase()),
      ).sort();
      add({
        template: 'labels_cooccurring', stratum: 'multi_hop', kind: 'retrieval',
        question: `Which other labels appear on issues that also carry the label "${label}"?`,
        check: { type: 'contains_all', values: expect, forbid },
        oracle: `${expect.join(', ')}${forbid.length ? ` (not: ${forbid.join(', ')})` : ''}`,
      });
    }
  }
  if (mostComments?.author?.login) {
    add({
      template: 'author_of_most_commented', stratum: 'multi_hop', kind: 'retrieval',
      question: `Who opened the issue that has the most comments?`,
      check: { type: 'contains_all', values: [mostComments.author.login] },
      oracle: `${mostComments.author.login} (#${mostComments.number})`,
    });
  }
  if (mostReactions?.author?.login) {
    add({
      template: 'author_of_most_reacted', stratum: 'multi_hop', kind: 'retrieval',
      question: `Who opened the issue with the most reactions?`,
      check: { type: 'contains_all', values: [mostReactions.author.login] },
      oracle: `${mostReactions.author.login} (#${mostReactions.number})`,
    });
  }

  // === true_zero ===========================================================
  // The other half of the enum fix. An agent taught that an empty result is
  // suspicious can "fix" its score by never answering zero — these are the
  // questions where zero is the truth, and they are graded so that silence and
  // a refusal both fail.
  for (const label of foreign.labels.slice(0, 3)) {
    add({
      template: 'absent_label_count', stratum: 'true_zero', kind: 'structural',
      question: `How many issues carry the label "${label}"?`,
      check: { type: 'number', value: 0 },
      oracle: `0 (no such label in this repo)`,
    });
    add({
      template: 'absent_label_members', stratum: 'true_zero', kind: 'structural',
      question: `List the issue numbers of every issue labelled "${label}".`,
      check: { type: 'issue_set', expect: [], mode: 'exact' },
      oracle: `none`,
    });
  }
  for (const term of foreign.terms.slice(0, 3)) {
    add({
      template: 'absent_term', stratum: 'true_zero', kind: 'retrieval',
      question: `Which issues mention "${term}" in their title or body? Give their issue numbers.`,
      check: { type: 'issue_set', expect: [], mode: 'exact' },
      oracle: `none`,
    });
  }
  for (const login of foreign.authors.slice(0, 2)) {
    add({
      template: 'absent_author_issues', stratum: 'true_zero', kind: 'structural',
      question: `Which issues were opened by the user "${login}"? Give their issue numbers.`,
      check: { type: 'issue_set', expect: [], mode: 'exact' },
      oracle: `none`,
    });
  }
  {
    const months = [...monthCounts.keys()].sort();
    const [lo, hi] = [months[0], months[months.length - 1]];
    for (let y = Number(lo.slice(0, 4)); y <= Number(hi.slice(0, 4)); y++) {
      for (let m = 1; m <= 12; m++) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        if (key < lo || key > hi || monthCounts.has(key)) continue;
        add({
          template: 'absent_month_count', stratum: 'true_zero', kind: 'structural',
          question: `How many issues were created in ${key}?`,
          check: { type: 'number', value: 0 },
          oracle: `0`,
        });
      }
    }
  }

  // === paraphrase ==========================================================
  // Same oracle, different wording, scored separately — so wording sensitivity
  // is visible as itself rather than smeared across every other stratum.
  const paraphrases: [string, string, string[]][] = [
    ['closed_count', `How many issues are closed?`, [
      `What is the number of issues in a closed state?`,
      `Count the issues in this repository that have been closed.`,
    ]],
    ['distinct_authors', `How many distinct users have authored issues in the knowledge graph?`, [
      `How many different people opened issues?`,
      `What is the number of unique issue authors?`,
    ]],
  ];
  for (const [group, , variants] of paraphrases) {
    const base = tasks.find((t) => t.paraphraseGroup === group);
    if (!base) continue;
    for (const question of variants) {
      add({
        template: `${group}_paraphrase`, stratum: 'paraphrase', kind: 'structural',
        question,
        check: base.check,
        oracle: base.oracle,
        paraphraseGroup: group,
      });
    }
  }

  // === semantic ============================================================
  for (const issue of issues.filter((i) => i.totalComments >= 4).sort((a, b) => b.totalComments - a.totalComments).slice(0, 10)) {
    const reference = [
      `Issue #${issue.number} in ${repo}`,
      `Title: ${issue.title}`,
      `State: ${issue.state}`,
      `Author: ${issue.author?.login ?? 'unknown'}`,
      `Comments: ${issue.totalComments}`,
      `Body: ${issue.bodyText.slice(0, 6000)}`,
      `Comments:\n${issue.comments.map((c, k) => `[${k + 1}] ${c.bodyText.slice(0, 1200)}`).join('\n')}`,
    ].join('\n');
    add({
      template: 'summarize_issue', stratum: 'semantic', kind: 'semantic',
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

  return selectQuota(tasks, split);
}

/**
 * Fill each stratum to its weight, round-robining across templates inside the
 * stratum so no single template owns a stratum. A stratum that cannot be filled
 * (requests has three labels, so `multi_hop` runs dry) donates its shortfall to
 * the strata that can — and the realised mix is printed, never silently skewed.
 */
function selectQuota(all: TaskV2[], split: string): TaskV2[] {
  const pools = new Map<Stratum, Map<string, TaskV2[]>>();
  for (const s of STRATA) pools.set(s, new Map());
  for (const t of all) {
    const byTemplate = pools.get(t.stratum)!;
    if (!byTemplate.has(t.template)) byTemplate.set(t.template, []);
    byTemplate.get(t.template)!.push(t);
  }

  const drawFrom = (s: Stratum, n: number): TaskV2[] => {
    const byTemplate = pools.get(s)!;
    const names = [...byTemplate.keys()].sort();
    const out: TaskV2[] = [];
    let progressed = true;
    while (out.length < n && progressed) {
      progressed = false;
      for (const name of names) {
        if (out.length >= n) break;
        const next = byTemplate.get(name)!.shift();
        if (next) {
          out.push(next);
          progressed = true;
        }
      }
    }
    return out;
  };

  const chosen: TaskV2[] = [];
  const realised: Record<string, number> = {};
  let shortfall = 0;
  for (const s of STRATA) {
    const want = WEIGHTS[s];
    const got = drawFrom(s, want);
    chosen.push(...got);
    realised[s] = got.length;
    shortfall += want - got.length;
  }
  // Back-fill, largest weight first, from whatever still has stock.
  for (const s of [...STRATA].sort((a, b) => WEIGHTS[b] - WEIGHTS[a])) {
    if (shortfall <= 0) break;
    if (s === 'semantic' || s === 'canary') continue; // judge noise capped; canaries fixed
    const extra = drawFrom(s, shortfall);
    chosen.push(...extra);
    realised[s] += extra.length;
    shortfall -= extra.length;
  }
  if (shortfall > 0) {
    throw new Error(`${split}: ${chosen.length} tasks available, quota ${QUOTA} (short ${shortfall})`);
  }

  const ordered = chosen.sort((a, b) => STRATA.indexOf(a.stratum) - STRATA.indexOf(b.stratum) || a.id.localeCompare(b.id));
  console.log(`  strata: ${STRATA.map((s) => `${s}=${realised[s]}/${WEIGHTS[s]}`).join(' ')}`);
  return ordered.map((t, i) => ({ ...t, id: `${split}-${String(i + 1).padStart(3, '0')}` }));
}

// ---------------------------------------------------------------------------

function main() {
  const i = process.argv.indexOf('--split');
  const splits = i >= 0
    ? [process.argv[i + 1]]
    : readdirSync(CORPUS_DIR)
        .filter((f) => f.endsWith('.json') && !['dev.json', 'holdout.json'].includes(f))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();

  mkdirSync(OUT_DIR, { recursive: true });
  for (const split of splits) {
    const path = join(CORPUS_DIR, `${split}.json`);
    if (!existsSync(path)) throw new Error(`no corpus at ${path}`);
    const corpus = JSON.parse(readFileSync(path, 'utf-8')) as Corpus;
    console.log(`${split}:`);
    const tasks = buildTasks(corpus, split, foreignPool(corpus));
    const out = join(OUT_DIR, `${split}.jsonl`);
    writeFileSync(out, `${tasks.map((t) => JSON.stringify(t)).join('\n')}\n`);
    const tmpl = countBy(tasks, (t: TaskV2) => t.template);
    console.log(`  ${tasks.length} tasks -> ${out}`);
    console.log(`  templates: ${[...tmpl].sort().map(([k, v]) => `${k}:${v}`).join(' ')}\n`);
  }
}

if (import.meta.main) main();

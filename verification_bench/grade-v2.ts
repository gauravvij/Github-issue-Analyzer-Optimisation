/**
 * Grading, with two defects in `bench/harness/grade.ts` repaired.
 *
 * `bench/` is the frozen referee and must not be edited, so this wraps it:
 * every check type it already handles correctly is delegated verbatim, and
 * `createJudge` is re-exported unchanged (moving the judge would move every
 * historical score).
 *
 * --- Defect 1: a number that ends a sentence was graded wrong -------------
 *
 * `bench/harness/grade.ts:39` matches a number with
 *
 *     (?<![\d.])N(?![\d.])
 *
 * The trailing `(?![\d.])` exists to reject decimals — `60.5` must not satisfy
 * "60", and `3.60.1` must not either. It does that. But it ALSO rejects the
 * final `.` of a sentence, so a correct answer phrased
 *
 *     "The total number of comments stored across all issues is 228."
 *
 * scored zero. Re-grading all 3,500 stored attempts in this repo with the fix
 * flips exactly one: bench/jobs/repro-champion dev-002 — which is a CANARY, so
 * that run's `score.canaryPass` was false and, by the harness's own contract
 * ("a canary failing means the HARNESS is broken, not the agent"), it should
 * never have been reported as a 98.10% measurement at all.
 *
 * The fix narrows the trailing guard to `(?!\.?\d)`: reject a following digit,
 * and reject a `.` only when a digit follows it. `60.5` and `3.60.1` are still
 * rejected; `is 228.` now passes.
 *
 * --- Defect 2: an empty set accepted an empty answer ----------------------
 *
 * `issue_set` with `expect: []` and `mode: 'exact'` is the natural way to ask a
 * true-zero question ("list every issue labelled X", where nothing is). The
 * stock grader passes it whenever the answer cites no issue number — which is
 * also true of `""`, of a refusal, and of a crash. That would let a completely
 * broken arm score 100% on the exact stratum built to catch it.
 *
 * So an empty expectation additionally requires the answer to actually assert
 * absence. Nothing else about `issue_set` changes.
 *
 * --- Defect 3: a count of zero could only be written as a digit -----------
 *
 * The same true-zero stratum also asks counts, and "how many issues carry the
 * label X" when the answer is none is naturally answered "there are no issues
 * with that label" — no digit anywhere. Requiring the character `0` grades
 * phrasing, not correctness, and worse, it rewards exactly the behaviour the
 * enum fix was meant to remove: never saying zero.
 *
 * So `value: 0` also accepts a word-form negative — but only when the answer
 * states no number of its own. Digits ECHOED FROM THE QUESTION do not count:
 * "How many issues were created in 2012-07?" answered "No issues were created
 * in July 2012." is a correct zero, and the 2012 in it is the question talking.
 *
 * --- Defect 4: counts spelled as words were graded wrong -------------------
 *
 * "Three distinct users have commented on issue #649" is a correct answer to
 * "how many distinct users commented", and bench/ scores it zero because it
 * wants the character 3. Across all 1,484 stored number-check attempts in this
 * repo, accepting number words flips exactly two attempts, both of them real
 * false negatives, and creates zero false positives.
 *
 * "one" is deliberately NOT accepted: in English prose it is an article and a
 * pronoun ("one of the issues", "no one") far more often than a count, so it
 * is the one word form that would start passing answers that mean nothing.
 */

import { gradeDeterministic, type Grade } from '../bench/harness/grade';
import type { Check } from '../bench/scripts/build-tasks';

export { createJudge, citedIssueNumbers, type Judge } from '../bench/harness/grade';
export type { Grade };

/** Same stripping as bench/: numbers inside code, URLs and #refs are not answers. */
function numericHaystack(answer: string): string {
  return answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1');
}

/** `(?!\.?\d)` instead of `(?![\d.])` — see Defect 1 above. */
export function hasNumber(haystack: string, n: number): boolean {
  return new RegExp(`(?<![\\d.])${n}(?!\\.?\\d)`).test(haystack);
}

/**
 * Does the answer actually say "none"? Deliberately generous — the point is to
 * separate a real negative answer from silence, not to police phrasing.
 */
/** Spelled-out counts. `one` is excluded on purpose — see Defect 4 above. */
const NUMBER_WORDS: Record<number, string> = {
  0: 'zero', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
  9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen',
  15: 'fifteen', 16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty',
};

function statesNumber(haystack: string, n: number): boolean {
  if (hasNumber(haystack, n)) return true;
  const word = NUMBER_WORDS[n];
  return !!word && new RegExp(`\\b${word}\\b`, 'i').test(haystack);
}

const ASSERTS_ABSENCE =
  /\b(none|no\s+\w+|not\s+any|zero|nothing|empty|0)\b|there\s+are\s+no|does\s+not\s+(exist|appear)/i;

export function gradeDeterministicV2(check: Check, answer: string, question = ''): Grade {
  if (check.type === 'number') {
    const hay = numericHaystack(answer);
    // Numbers the question itself supplied (a date, an issue number, a
    // threshold) are the question talking, not the answer asserting a count.
    const echoed = new Set(question.match(/\d+/g) ?? []);
    const residual = hay.replace(/\d+/g, (m) => (echoed.has(m) ? ' ' : m));
    const wordZero = check.value === 0 && !/\d/.test(residual) && ASSERTS_ABSENCE.test(hay);
    if (!wordZero && !statesNumber(hay, check.value)) {
      return { pass: false, reason: `expected ${check.value}, not present in answer` };
    }
    for (const bad of check.forbid ?? []) {
      if (bad !== check.value && statesNumber(hay, bad)) {
        return { pass: false, reason: `answer also asserts near-miss value ${bad}` };
      }
    }
    return { pass: true, reason: wordZero ? 'stated absence' : `found ${check.value}` };
  }

  if (check.type === 'issue_set' && check.expect.length === 0) {
    const text = answer.trim();
    if (text === '') return { pass: false, reason: 'empty answer is not an assertion of absence' };
    if (!ASSERTS_ABSENCE.test(text)) {
      return { pass: false, reason: 'answer neither cites issues nor states that there are none' };
    }
    // Fall through so the stock grader still rejects any cited issue number.
  }

  return gradeDeterministic(check, answer);
}

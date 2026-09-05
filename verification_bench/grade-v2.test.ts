/**
 * The two repairs in grade-v2, and proof that nothing else moved.
 *
 *   bun test verification_bench/grade-v2.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { gradeDeterministic } from '../bench/harness/grade';
import { gradeDeterministicV2 } from './grade-v2';
import type { Check } from '../bench/scripts/build-tasks';

const num = (value: number, forbid?: number[]): Check => ({ type: 'number', value, forbid });
const emptySet: Check = { type: 'issue_set', expect: [], mode: 'exact' };

describe('defect 1 — a number ending a sentence', () => {
  // These are correct answers that bench/ marks wrong. The real one, from
  // bench/jobs/repro-champion dev-002 (a canary), is first.
  for (const answer of [
    'The total number of comments stored across all issues is 228.',
    'The total number of issues is 60.',
    'The answer is 7.',
    'The count is 0.',
  ]) {
    const value = Number(answer.match(/(\d+)\.$/)![1]);
    test(`fixed: ${answer}`, () => {
      expect(gradeDeterministic(num(value), answer).pass).toBe(false); // the defect
      expect(gradeDeterministicV2(num(value), answer).pass).toBe(true); // the repair
    });
  }

  test('decimals are still rejected', () => {
    expect(gradeDeterministicV2(num(60), 'Version 3.60.1 was released').pass).toBe(false);
    expect(gradeDeterministicV2(num(60), 'The value is 60.5 percent').pass).toBe(false);
    expect(gradeDeterministicV2(num(7), 'It took 7.5 seconds').pass).toBe(false);
  });

  test('forbidden near-misses are still rejected', () => {
    expect(gradeDeterministicV2(num(0, [60]), 'There are 0 issues, out of 60 total.').pass).toBe(false);
  });

  test('phrasings bench/ already accepted are unchanged', () => {
    for (const [a, v] of [
      ['There are 60 issues in the graph.', 60],
      ['The answer is 7', 7],
      ['The answer is 7!', 7],
      ['The answer is 7, as shown above.', 7],
    ] as const) {
      expect(gradeDeterministic(num(v), a).pass).toBe(true);
      expect(gradeDeterministicV2(num(v), a).pass).toBe(true);
    }
  });

  test('natural zero phrasings now score', () => {
    for (const a of [
      'There are no issues with that label.',
      'Zero issues match.',
      'I found none in the knowledge graph.',
      'There are 0 issues with that label.',
    ]) {
      expect(gradeDeterministicV2(num(0), a).pass).toBe(true);
    }
  });

  test('a word-form negative does not excuse a stated count', () => {
    // "none of which" must not turn an answer that states 5 into a zero.
    expect(gradeDeterministicV2(num(0), 'There are 5 issues, none of which are open.').pass).toBe(false);
    // and the word-form path is zero-only
    expect(gradeDeterministicV2(num(5), 'There are no issues with that label.').pass).toBe(false);
  });
});

describe('defect 3 — a zero answer that echoes a number from the question', () => {
  test('a date in the question is not a count in the answer', () => {
    const q = 'How many issues were created in 2012-07?';
    const a = 'No issues were created in July 2012.';
    expect(gradeDeterministic(num(0), a).pass).toBe(false); // the defect
    expect(gradeDeterministicV2(num(0), a, q).pass).toBe(true); // the repair
  });

  test('a number the answer introduces still has to be the right one', () => {
    const q = 'How many issues were created in 2012-07?';
    expect(gradeDeterministicV2(num(0), 'There were 4 issues in July 2012.', q).pass).toBe(false);
  });
});

describe('defect 4 — counts spelled as words', () => {
  test('spelled counts score', () => {
    expect(gradeDeterministic(num(3), 'Three distinct users have commented.').pass).toBe(false);
    expect(gradeDeterministicV2(num(3), 'Three distinct users have commented.').pass).toBe(true);
    expect(gradeDeterministicV2(num(12), 'twelve issues carry it').pass).toBe(true);
  });

  test('"one" is never read as a count', () => {
    expect(gradeDeterministicV2(num(1), 'One of the issues is still open.').pass).toBe(false);
    expect(gradeDeterministicV2(num(1), 'There is 1 such issue.').pass).toBe(true);
  });

  test('a forbidden value spelled out still fails the answer', () => {
    expect(gradeDeterministicV2(num(3, [4]), 'Three users commented on four issues.').pass).toBe(false);
  });

  test('a word does not match a different number', () => {
    expect(gradeDeterministicV2(num(3), 'Seven distinct users have commented.').pass).toBe(false);
  });
});

describe('defect 2 — an empty expectation accepting a non-answer', () => {
  test('bench/ passes silence; v2 does not', () => {
    for (const a of ['', '   ']) {
      expect(gradeDeterministic(emptySet, a).pass).toBe(true); // the defect
      expect(gradeDeterministicV2(emptySet, a).pass).toBe(false); // the repair
    }
  });

  test('a real negative answer passes', () => {
    for (const a of [
      'No issues carry that label.',
      'There are none.',
      'The result set is empty.',
      'I found 0 matching issues.',
    ]) {
      expect(gradeDeterministicV2(emptySet, a).pass).toBe(true);
    }
  });

  test('citing an issue still fails', () => {
    expect(gradeDeterministicV2(emptySet, 'None, except #12345.').pass).toBe(false);
  });
});

describe('every other check type is delegated verbatim', () => {
  const cases: [Check, string][] = [
    [{ type: 'contains_all', values: ['alice'] }, 'Opened by alice.'],
    [{ type: 'contains_all', values: ['alice'] }, 'Opened by bob.'],
    [{ type: 'contains_all', values: ['a'], forbid: ['b'] }, 'a and b'],
    [{ type: 'issue_set', expect: [12, 34], mode: 'exact' }, 'Issues #12 and #34.'],
    [{ type: 'issue_set', expect: [12, 34], mode: 'exact' }, 'Issues #12, #34 and #56.'],
    [{ type: 'issue_set', expect: [12], mode: 'superset' }, 'Issues #12 and #56.'],
    [{ type: 'number', value: 42 }, 'There are 42 things here'],
    [{ type: 'number', value: 42 }, 'There are 41 things here'],
  ];
  for (const [check, answer] of cases) {
    test(`${check.type}: ${JSON.stringify(answer)}`, () => {
      expect(gradeDeterministicV2(check, answer)).toEqual(gradeDeterministic(check, answer));
    });
  }
});

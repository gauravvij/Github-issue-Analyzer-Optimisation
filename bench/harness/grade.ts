/**
 * Grading. Structural and retrieval questions are graded deterministically —
 * no model in the loop, so re-grading the same transcript always gives the
 * same score and a 2-point move is signal rather than judge noise. Only
 * `judge` checks call a model, and they are capped at ~12% of each split.
 */

import type { Check, Task } from '../scripts/build-tasks';

export interface Grade {
  pass: boolean;
  reason: string;
}

/**
 * Strip the parts of an answer that contain numbers which are not the answer:
 * fenced Cypher (`LIMIT 60`), issue references (`#60`, `/issues/60`) and
 * thousands separators. Without this, "I ran ... LIMIT 60" scores a free point
 * on "how many issues are there".
 */
function numericHaystack(answer: string): string {
  return answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1');
}

/** Issue numbers the answer actually cites, from `#123` or `.../issues/123`. */
export function citedIssueNumbers(answer: string): Set<number> {
  const found = new Set<number>();
  for (const m of answer.matchAll(/#(\d{2,6})\b/g)) found.add(Number(m[1]));
  for (const m of answer.matchAll(/\/issues\/(\d{2,6})\b/g)) found.add(Number(m[1]));
  return found;
}

function hasNumber(haystack: string, n: number): boolean {
  return new RegExp(`(?<![\\d.])${n}(?![\\d.])`).test(haystack);
}

const sortNums = (s: Iterable<number>) => [...s].sort((a, b) => a - b).join(',');

export function gradeDeterministic(check: Check, answer: string): Grade {
  switch (check.type) {
    case 'number': {
      const hay = numericHaystack(answer);
      if (!hasNumber(hay, check.value)) {
        return { pass: false, reason: `expected ${check.value}, not present in answer` };
      }
      for (const bad of check.forbid ?? []) {
        if (bad !== check.value && hasNumber(hay, bad)) {
          return { pass: false, reason: `answer also asserts near-miss value ${bad}` };
        }
      }
      return { pass: true, reason: `found ${check.value}` };
    }

    case 'contains_all': {
      const lower = answer.toLowerCase();
      const missing = check.values.filter((v) => !lower.includes(v.toLowerCase()));
      if (missing.length > 0) return { pass: false, reason: `missing: ${missing.join(', ')}` };
      const bad = (check.forbid ?? []).filter((v) => lower.includes(v.toLowerCase()));
      if (bad.length > 0) return { pass: false, reason: `contains forbidden: ${bad.join(', ')}` };
      return { pass: true, reason: 'all required strings present' };
    }

    case 'issue_set': {
      const cited = citedIssueNumbers(answer);
      const expect = new Set(check.expect);
      const missing = [...expect].filter((n) => !cited.has(n));
      if (missing.length > 0) {
        return { pass: false, reason: `missing issues: ${missing.map((n) => `#${n}`).join(', ')}` };
      }
      for (const bad of check.forbid ?? []) {
        if (cited.has(bad)) return { pass: false, reason: `cites forbidden issue #${bad}` };
      }
      if (check.mode === 'exact') {
        const extra = [...cited].filter((n) => !expect.has(n));
        if (extra.length > 0) {
          return {
            pass: false,
            reason: `extra issues cited: ${extra.map((n) => `#${n}`).join(', ')} (expected exactly ${sortNums(expect)})`,
          };
        }
      }
      return { pass: true, reason: `cited ${sortNums(expect)}` };
    }

    case 'judge':
      throw new Error('judge checks are graded by gradeWithJudge');
  }
}

const JUDGE_SCHEMA = {
  type: 'object' as const,
  properties: {
    pass: { type: 'boolean' as const },
    reason: { type: 'string' as const },
  },
  required: ['pass', 'reason'] as const,
  additionalProperties: false,
};

export interface Judge {
  model: string;
  grade(task: Task, answer: string): Promise<Grade>;
}

/**
 * The judge model is fixed and MUST NOT be changed by the optimisation loop —
 * moving the judge moves every historical score.
 */
export function createJudge(model = 'gpt-4o'): Judge {
  // `openai` is imported lazily on purpose. Its shim captures `globalThis.fetch`
  // at import time, so loading it before installOpenAIMeter() makes the meter
  // permanently blind and every cost reads $0. Keep this import inside the
  // function; never hoist it to the top of the file.
  const clientPromise = import('openai').then(
    (m) => new m.default({ apiKey: process.env.OPENAI_API_KEY }),
  );
  return {
    model,
    async grade(task, answer) {
      if (task.check.type !== 'judge') throw new Error('not a judge check');
      const { rubric, reference } = task.check;

      const client = await clientPromise;
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'verdict', schema: JUDGE_SCHEMA, strict: true },
        },
        messages: [
          {
            role: 'system',
            content:
              'You grade an assistant answer against ground truth. Be strict and literal. ' +
              'Reply only with the JSON verdict.',
          },
          {
            role: 'user',
            content: [
              `QUESTION:\n${task.question}`,
              `GROUND TRUTH (from the source data):\n${reference}`,
              `RUBRIC:\n${rubric}`,
              `ANSWER TO GRADE:\n${answer || '(empty answer)'}`,
            ].join('\n\n'),
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content;
      if (!raw) return { pass: false, reason: 'judge returned no content' };
      const verdict = JSON.parse(raw) as Grade;
      return { pass: !!verdict.pass, reason: verdict.reason ?? '' };
    },
  };
}

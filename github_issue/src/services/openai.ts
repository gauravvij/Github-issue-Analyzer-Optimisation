/**
 * OpenAI analysis — sends issue data to GPT-4o and extracts structured info
 * (summary, categories, competitors, solutions, workarounds).
 */

import OpenAI from 'openai';
import { withSpan } from './tracing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisInput {
  issueId: string;
  issueNumber: number;
  title: string;
  description: string;
  labels: string[];
  comments: { commentId: string; author: string; text: string }[];
}

export interface SolutionAnalysis {
  solutionText: string;
  source: string; // commentId or issueId
  sourceType: 'commentId' | 'issueId';
  keywords: string[];
}

export interface WorkaroundAnalysis {
  workaroundText: string;
  source: string; // commentId or issueId
  sourceType: 'commentId' | 'issueId';
  keywords: string[];
}

export interface CompetitorAnalysis {
  name: string;
  source: string; // commentId
}

export interface IssueAnalysis {
  summary: string;
  categories: string[];
  competitors: CompetitorAnalysis[];
  solutions: SolutionAnalysis[];
  workarounds: WorkaroundAnalysis[];
}

export interface AnalysisResult {
  analysis: IssueAnalysis;
  tokenUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// Transform database issue data → analysis input
// ---------------------------------------------------------------------------

export function transformIssueDataForAnalysis(issueData: {
  issue: { issueId: string; number: number; title: string; bodyText: string | null };
  labels: string[];
  comments: { commentId: string; authorLogin?: string | null; bodyText: string | null }[];
}): AnalysisInput {
  return {
    issueId: issueData.issue.issueId,
    issueNumber: issueData.issue.number,
    title: issueData.issue.title,
    description: issueData.issue.bodyText ?? '',
    labels: issueData.labels,
    comments: issueData.comments.map((c) => ({
      commentId: c.commentId,
      author: c.authorLogin ?? 'unknown',
      text: c.bodyText ?? '',
    })),
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: { type: 'string' as const, description: 'One-sentence summary of the issue' },
    categories: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Relevant categories',
    },
    competitors: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          source: { type: 'string' as const, description: 'commentId where mentioned' },
        },
        required: ['name', 'source'] as const,
        additionalProperties: false,
      },
    },
    solutions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          solutionText: {
            type: 'string' as const,
            description: 'AI-generated description of the solution',
          },
          source: {
            type: 'string' as const,
            description: 'commentId or issueId where the solution is explicitly stated',
          },
          sourceType: {
            type: 'string' as const,
            enum: ['commentId', 'issueId'] as const,
            description: 'Whether source is a commentId or the issueId for the issue body',
          },
          keywords: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['solutionText', 'source', 'sourceType', 'keywords'] as const,
        additionalProperties: false,
      },
    },
    workarounds: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          workaroundText: {
            type: 'string' as const,
            description: 'AI-generated description of the workaround',
          },
          source: {
            type: 'string' as const,
            description: 'commentId or issueId where the workaround is explicitly stated',
          },
          sourceType: {
            type: 'string' as const,
            enum: ['commentId', 'issueId'] as const,
            description: 'Whether source is a commentId or the issueId for the issue body',
          },
          keywords: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['workaroundText', 'source', 'sourceType', 'keywords'] as const,
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'categories', 'competitors', 'solutions', 'workarounds'] as const,
  additionalProperties: false,
};

/** Model used for structured extraction. Named so the span and the request
 *  can never report different models. */
const ANALYSIS_MODEL = 'gpt-4o';

export async function analyzeIssueWithOpenAI(issueData: AnalysisInput): Promise<AnalysisResult> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = `
You are analyzing a GitHub issue and its comments to extract structured information.

**CRITICAL INSTRUCTIONS:**
- Only extract information that is explicitly stated in the text
- Do NOT infer or assume anything
- For competitors: ONLY extract explicit mentions from COMMENTS, not from the issue description
- For solutions and workarounds: extract explicit statements from either the ISSUE BODY or COMMENTS; do not infer or assume
- For each solution/workaround, provide the exact source identifier: the issueId for an issue-body source or the commentId for a comment source, plus the matching sourceType
- For solutions and workarounds, generate a clear descriptive sentence explaining what it is
- Then extract relevant keywords from your generated descriptive sentence
- Keywords should be technical terms, features, tools, concepts, or important terms
- IMPORTANT: Keywords must be present in your generated description text
- If you cannot find explicit information, return empty arrays/strings

**Input Data:**
Issue ID: ${issueData.issueId}
Issue Title: ${issueData.title}
Issue Description (source is issueId when used): ${issueData.description}
Issue Labels: ${issueData.labels.join(', ')}

Comments:
${issueData.comments.map((c) => `Comment ID: ${c.commentId}\nText: ${c.text}\n---`).join('\n')}

**Extract the following:**
1. Summary: One-sentence summary of the issue
2. Categories: Array of relevant categories
3. Competitors: Only from comments — explicit mentions of competitor tools/services; source is always a commentId
4. Solutions: From the issue body or comments — user-proposed solutions mentioned explicitly; set sourceType to issueId for body text and commentId for comments
5. Workarounds: From the issue body or comments — user-found workarounds mentioned explicitly; set sourceType to issueId for body text and commentId for comments
6. For every body-derived solution/workaround, source must equal the supplied Issue ID exactly
`;

  const completion = await withSpan(
    'openai.chat',
    {
      'gen_ai.system': 'openai',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': ANALYSIS_MODEL,
      'analysis.issue_number': issueData.issueNumber,
      'analysis.comment_count': issueData.comments.length,
      'analysis.prompt_chars': prompt.length,
    },
    async (span) => {
      const res = await openai.chat.completions.create({
    model: ANALYSIS_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are an expert at analyzing GitHub issues and extracting structured information. Only extract explicitly stated information, do not infer or assume anything.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'issue_analysis', schema: JSON_SCHEMA },
    },
    temperature: 0.1,
      });
      span.setAttribute('gen_ai.response.model', res.model);
      span.setAttribute('gen_ai.usage.input_tokens', res.usage?.prompt_tokens ?? 0);
      span.setAttribute('gen_ai.usage.output_tokens', res.usage?.completion_tokens ?? 0);
      return res;
    },
  );

  const analysis = JSON.parse(completion.choices[0].message.content!) as IssueAnalysis;
  const usage = completion.usage!;

  console.log(
    `  Token usage — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`,
  );

  return {
    analysis,
    tokenUsage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
  };
}

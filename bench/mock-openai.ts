/**
 * Minimal OpenAI-compatible server for offline verification of the runner.
 *
 * It speaks the two APIs this system actually uses:
 *   /v1/chat/completions  — the ingestion analyser and the judge (openai SDK)
 *   /v1/responses         — the Mastra agent (ai-sdk), a different request AND
 *                           usage shape (`input_tokens` vs `prompt_tokens`)
 *
 * It is NOT a quality oracle. It exists to prove the plumbing — metering, cost
 * attribution, the tool loop, grading, reporting — works before real money is
 * spent on it. Answers are canned; scores from a mock run mean nothing.
 */

export interface MockStats {
  chatCompletions: number;
  responses: number;
  toolCallsIssued: number;
}

export interface MockOpenAI {
  baseUrl: string;
  stats: MockStats;
  stop(): Promise<void>;
}

/** Build the smallest object satisfying a JSON schema, for structured outputs. */
function fromSchema(schema: any): unknown {
  if (!schema || typeof schema !== 'object') return null;
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? Object.keys(schema.properties ?? {})) {
        out[key] = fromSchema(schema.properties?.[key]);
      }
      return out;
    }
    case 'array':
      return [];
    case 'string':
      return 'mock';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

const tokensFor = (s: string) => Math.max(1, Math.ceil(s.length / 4));

export function startMockOpenAI(): MockOpenAI {
  const stats: MockStats = { chatCompletions: 0, responses: 0, toolCallsIssued: 0 };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const bodyText = await req.text();
      const body = bodyText ? JSON.parse(bodyText) : {};
      const model = body.model ?? 'gpt-4o';
      const inTokens = tokensFor(bodyText);

      if (path.endsWith('/chat/completions')) {
        stats.chatCompletions++;
        const schema = body.response_format?.json_schema?.schema;
        const content = schema ? JSON.stringify(fromSchema(schema)) : 'mock summary';
        return Response.json({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: inTokens,
            completion_tokens: tokensFor(content),
            total_tokens: inTokens + tokensFor(content),
          },
        });
      }

      if (path.endsWith('/responses')) {
        stats.responses++;
        const input: any[] = Array.isArray(body.input) ? body.input : [];
        const toolOutput = input.find((i) => i?.type === 'function_call_output');
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

        // First turn with tools available: call one, so the real tool loop,
        // the Neo4j read path and toolUseRate all get exercised.
        if (hasTools && !toolOutput) {
          stats.toolCallsIssued++;
          const args = JSON.stringify({ cypher: 'MATCH (i:Issue) RETURN count(i) AS c' });
          return Response.json({
            id: 'resp-mock',
            created_at: Math.floor(Date.now() / 1000),
            model,
            output: [
              { type: 'function_call', call_id: 'call_mock_1', name: 'queryNeo4j', arguments: args, id: 'fc_mock_1' },
            ],
            usage: { input_tokens: inTokens, output_tokens: tokensFor(args) },
          });
        }

        // Second turn: answer using whatever the tool returned, so the answer
        // is at least derived from the real graph.
        const text = `Based on the graph: ${String(toolOutput?.output ?? 'no tool output').slice(0, 400)}`;
        return Response.json({
          id: 'resp-mock',
          created_at: Math.floor(Date.now() / 1000),
          model,
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg_mock_1',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          ],
          usage: { input_tokens: inTokens, output_tokens: tokensFor(text) },
        });
      }

      if (path.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'gpt-4o' }] });

      return Response.json({ error: { message: `mock: unhandled ${path}`, type: 'invalid_request_error', code: 'unhandled' } }, { status: 404 });
    },
  });

  return {
    baseUrl: `http://localhost:${server.port}/v1`,
    stats,
    async stop() {
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  const m = startMockOpenAI();
  console.log(`mock OpenAI listening on ${m.baseUrl}`);
}

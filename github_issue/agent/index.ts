/**
 * GitHub Issue Analyzer — Agent
 *
 * Researches GitHub issues in the knowledge graph and answers questions
 * using Cypher queries and comment summarization.
 *
 * The agent's instructions, model and tool registry live in `agent/config.ts`
 * so the eval suite and benchmark harness construct the same agent.
 *
 * Environment variables (auto-injected by ast dev):
 *   GRPC_SERVER_ADDR  — Messaging service address (default: localhost:9090)
 *   OPENAI_API_KEY    — OpenAI API key
 *   NEO4J_HOST        — Neo4j host (default: localhost)
 *   NEO4J_URI         — Neo4j bolt URI (default: bolt://{NEO4J_HOST}:7687)
 *   NEO4J_AUTH        — Set to enable auth (default: disabled)
 */

import { serve } from '@astropods/adapter-mastra';
import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { getTraceFilePath, initTracing } from '../src/services/tracing';
import { INSTRUCTIONS, MODEL, TOOLS } from './config';

initTracing();
const tracePath = getTraceFilePath();
if (tracePath) console.log(`Tracing to ${tracePath}`);

const memory = new Memory({
  storage: new LibSQLStore({
    id: 'memory',
    url: ':memory:',
  }),
});

const agent = new Agent({
  id: 'github-issue-analyzer',
  name: 'github-issue-analyzer',
  instructions: INSTRUCTIONS,
  model: MODEL,
  tools: TOOLS,
  memory,
});

serve(agent);

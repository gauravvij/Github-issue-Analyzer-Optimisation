# GitHub Issue Analyzer Optimization & Enhancement Plan

## Goal
Transform the GitHub Issue Analyzer into a high-performance, cost-effective, resilient, and semantically searchable agent system. We will optimize ingestion latency, cut OpenAI API costs by ~90%+, introduce atomic batched Neo4j transactions with unique constraints and vector indexing, and harden agent tool execution and retrieval accuracy.

---

## Research Summary & Baseline Profiling

From auditing the original codebase in `/home/azureuser/githubIssue/github_issue`:
1. **Concurrency & Latency**:
   - Issue fetching (`getIssuesData`), comment pagination (`fetchCompleteIssue`), database ingestion (`ingestMultipleIssues`), and OpenAI analysis (`runPipeline`) are executed in strictly sequential `for` loops.
   - For 100 issues, ingestion takes 5-8+ minutes due to serial I/O bottlenecks and hundreds of individual database roundtrips.
2. **Cost Economics**:
   - `gpt-4o` is used across all stages (issue analysis, comment summarization, and agent orchestrator).
   - Structured JSON extraction does not require frontier model reasoning and can be handled by `gpt-4o-mini` at ~94% lower cost with near-identical extraction fidelity.
   - Full uncurated comment histories (including bot spam and giant stack traces) are dumped into prompts without token bounds.
3. **Graph Data Integrity & Performance**:
   - Neo4j lacks database constraints (e.g., uniqueness on `Issue.number`, `Issue.issueId`, `User.login`, `Label.name`, `Category.name`, `Competitor.name`). Every `MERGE` performs a slow label scan.
   - Schema defines empty embedding arrays (`s.embedding = []`) on `Solution` and `Workaround` nodes, but no vector embeddings or Neo4j vector indexes were ever implemented.
   - `clearExistingAnalysis` runs an unbounded global delete for orphan competitors on every issue update (`MATCH (comp:Competitor) WHERE NOT (comp)<-[:MENTIONS_COMPETITOR]-() DELETE comp`), creating full-database locks.
4. **Accuracy & Prompt Design**:
   - Prompt explicitly restricts extracting competitors, solutions, and workarounds to comments only (`ONLY extract from COMMENTS, not from the issue description`), losing solutions documented in the initial issue description.
   - The agent tool `queryNeo4j` sends arbitrary LLM-generated Cypher to Neo4j without query linting, parameter validation, or automated retry on syntax errors.

---

## Technical Approach & Architecture

### 1. Ingestion Pipeline Optimization
- **Concurrent Ingestion with Bounded Concurrency**: Introduce `p-limit` to fetch GitHub issues, run OpenAI analysis, and write to Neo4j concurrently (configurable concurrency: 5–10 workers).
- **In-Memory Cache Handoff**: Eliminate redundant Neo4j read-after-write (`fetchMultipleIssueDetails`) by passing already-fetched GitHub issue data directly to the OpenAI analysis stage.
- **Bot & Noise Filtering**: Clean comment threads before sending to LLM (truncate large stack traces, filter bot comments like Dependabot/github-actions).

### 2. Cost & Model Tier Optimization
- **Migrate Extraction & Summarization to `gpt-4o-mini`**:
  - `src/services/openai.ts`: Switch structured analysis from `gpt-4o` to `gpt-4o-mini`.
  - `agent/tools/summarize-comments.ts`: Switch ad-hoc comment summarizer to `gpt-4o-mini`.
  - Retain `gpt-4o` or configurable model for top-level agent reasoning if complex multi-step reasoning is required.

### 3. Neo4j Knowledge & Vector Graph Enhancements
- **Schema Constraints & Indexes**: Add an initialization migration function that applies unique constraints and range indexes on:
  - `Issue(number)`, `Issue(issueId)`
  - `User(login)`
  - `Label(name)`
  - `Category(name)`
  - `Competitor(name)`
  - `Solution(solutionText)`, `Workaround(workaroundText)`
- **Atomic Batched Transactions**: Replace individual `session.run()` statements with parameterized `UNWIND` Cypher statements executed within `session.executeWrite(...)` transactions to ensure atomicity.
- **Vector Embeddings & Semantic Search**:
  - Generate embeddings using OpenAI `text-embedding-3-small` for `Solution`, `Workaround`, and `Issue` nodes.
  - Create Neo4j Vector Index (`CALL db.index.vector.createNodeIndex(...)`).
  - Add a dedicated `semanticSearchTool` for the agent allowing hybrid (semantic + graph) discovery of issues, solutions, and workarounds.

### 4. Agent Tooling & Robustness
- **Cypher Validation & Error Feedback**: Wrap `queryNeo4j` with error feedback and schema guardrails to prevent common syntax errors.
- **Persistent Memory Support**: Configure LibSQL storage options in Mastra agent for persistent session history.
- **Improved Extraction Prompting**: Update prompt to capture solutions and workarounds from both the issue body and comments.

---

## Subtasks & Roadmap

1. **Phase 1: Project Setup & Baseline Verification**
   - Verify dependencies, build scripts, tests, and environment configurations in `/home/azureuser/githubIssue/github_issue`.
   - Setup `p-limit` and necessary utility packages.

2. **Phase 2: Database Schema, Constraints & Vector Indexing**
   - Implement `setupDatabaseSchema(driver)` in `src/services/neo4j.ts` for uniqueness constraints and indexes.
   - Refactor Cypher queries to use parameterized batching (`UNWIND`) and managed write transactions.
   - Fix scoped orphan entity cleanup in `analysis.ts` to prevent global lock contention.

3. **Phase 3: Cost Reduction & Extraction Quality**
   - Update `src/services/openai.ts` to use `gpt-4o-mini`.
   - Update prompt instructions to extract solutions and workarounds from both issue descriptions and comments.
   - Implement vector embedding generation (`text-embedding-3-small`) for issues, solutions, and workarounds upon ingestion.

4. **Phase 4: Concurrency & Ingestion Pipeline Modernization**
   - Refactor `src/services/github.ts` to support concurrent fetching with rate-limit awareness.
   - Refactor `src/services/pipeline.ts` to use `p-limit` across fetching, OpenAI analysis, and graph persistence.
   - Bypass redundant database read-back by utilizing in-memory fetched payloads.

5. **Phase 5: Agent Enhancement & Semantic Search Tooling**
   - Create `semanticSearchTool` using Neo4j vector search.
   - Upgrade `queryNeo4j` tool with pre-flight Cypher validation, timeout safety, and self-correcting error responses.
   - Update agent instructions and tool registry in `agent/index.ts`.

6. **Phase 6: Testing, Benchmarking & Documentation**
   - Update unit and eval tests in `test/` to cover vector search, schema initialization, and concurrent pipeline.
   - Profile throughput, latency, and cost improvements.
   - Maintain `ledger.md` with structured changelog entries.

---

## Deliverables

| File Path | Description |
|-----------|-------------|
| `/home/azureuser/githubIssue/plan.md` | In-depth optimization and architectural enhancement plan. |
| `/home/azureuser/githubIssue/ledger.md` | Running change log and commit ledger tracking all modifications. |
| `/home/azureuser/githubIssue/github_issue/src/services/neo4j.ts` | Optimized Neo4j driver with constraints, vector index setup, and batched transactions. |
| `/home/azureuser/githubIssue/github_issue/src/services/openai.ts` | Cost-optimized analysis service (`gpt-4o-mini`), vector embeddings, and improved prompt engineering. |
| `/home/azureuser/githubIssue/github_issue/src/services/github.ts` | Concurrency-enabled GitHub GraphQL client with rate-limit safeguards. |
| `/home/azureuser/githubIssue/github_issue/src/services/pipeline.ts` | High-throughput concurrent ingestion pipeline with in-memory handoff. |
| `/home/azureuser/githubIssue/github_issue/src/services/analysis.ts` | Batched, non-locking analysis graph persistence. |
| `/home/azureuser/githubIssue/github_issue/agent/tools/semantic-search.ts` | Hybrid vector & semantic search tool for solutions, workarounds, and issues. |
| `/home/azureuser/githubIssue/github_issue/agent/tools/query-neo4j.ts` | Guarded Cypher query tool with enhanced error reporting. |
| `/home/azureuser/githubIssue/github_issue/agent/index.ts` | Updated agent configuration with vector tools and refined schema prompts. |

---

## Evaluation Criteria

- **Ingestion Latency**: ≥ 4x–8x reduction in total pipeline runtime for 100+ issues via concurrent I/O.
- **API Cost**: ≥ 90% reduction in OpenAI ingestion costs by utilizing `gpt-4o-mini`.
- **Database Efficiency**: > 75% reduction in individual Neo4j network roundtrips via `UNWIND` batching.
- **Data Integrity**: 100% enforcement of uniqueness constraints across issues, users, labels, categories, and competitors.
- **Search Capability**: Successful semantic vector similarity search across issue solutions and workarounds.
- **Test Pass Rate**: 100% passing rate on all unit and evaluation test suites.

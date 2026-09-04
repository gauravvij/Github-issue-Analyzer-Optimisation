/**
 * Deeper offline checks of the runner's other code paths, against a mock LLM.
 * Costs nothing, takes a few minutes.
 *
 *   bun bench/verify-paths.ts
 *
 * `verify-offline.ts` covers the default `--stage all` run. This covers the
 * paths a keep/revert decision leans on but which a normal run never exercises:
 * `--attempts N`, the holdout split, `--stage ingest`, summarize on a report
 * with no QA section, and — most importantly — that an agent which cannot run
 * produces an INVALID run instead of a convincing 0%.
 *
 * WARNING: resets the benchmark Neo4j graph.
 */
import { join } from 'node:path';
import { startMockOpenAI } from './mock-openai';
const CWD = join(import.meta.dirname, '..');
async function run(args:string[], env:Record<string,string>) {
  const p = Bun.spawn(['bun','bench/run.ts',...args], {cwd:CWD, env:{...process.env,...env}, stdout:'pipe', stderr:'pipe'});
  const out = await new Response(p.stdout).text(); const code = await p.exited; return {out, code};
}
const mock = startMockOpenAI();
const E = { OPENAI_API_KEY:'sk-mock', OPENAI_BASE_URL: mock.baseUrl };
let fails = 0;
const ok = (n:string,c:boolean,d='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${n}${d?'  '+d:''}`); if(!c)fails++;};

// 1. attempts=2 — the confirmation path every keep/revert decision uses
{
  const {out,code} = await run(['--split','dev','--job','_p-attempts','--attempts','2','--qa-concurrency','6','--no-typecheck'], E);
  const r = JSON.parse(await Bun.file(`${CWD}/bench/jobs/_p-attempts/report.json`).text());
  ok('attempts=2 exits 0', code===0, `exit=${code}`);
  ok('every task has 2 attempts', r.qa.tasks.every((t:any)=>t.attempts.length===2));
  ok('passRate is a fraction over attempts', r.qa.tasks.every((t:any)=>[0,0.5,1].includes(t.passRate)));
  ok('solvedAny >= solvedAll', r.score.solvedAnyAttempt >= r.score.solvedAllAttempts);
  ok('judge ran per attempt', r.cost.judgeUsd > 0);
  void out;
}
// 2. holdout split end-to-end
{
  const {code} = await run(['--split','holdout','--job','_p-holdout','--qa-concurrency','6','--no-typecheck'], E);
  const r = JSON.parse(await Bun.file(`${CWD}/bench/jobs/_p-holdout/report.json`).text());
  ok('holdout exits 0', code===0, `exit=${code}`);
  ok('holdout has 20 tasks', r.qa.tasks.length===20);
  ok('holdout ingested 40 issues', r.ingest.pipeline.issuesIngested===40);
  ok('holdout integrity clean', r.integrity.filter((c:any)=>!c.pass&&!c.info).length===0);
}
// 3. stage=ingest only -> summarize must not crash on a report with no qa section
{
  const {code} = await run(['--split','dev','--job','_p-ingest','--stage','ingest','--no-typecheck'], E);
  const r = JSON.parse(await Bun.file(`${CWD}/bench/jobs/_p-ingest/report.json`).text());
  ok('stage=ingest exits 0', code===0, `exit=${code}`);
  ok('stage=ingest has no qa section', !r.qa && !r.score);
  const s = Bun.spawnSync(['bun','bench/summarize.ts','jobs/_p-ingest'],{cwd:CWD});
  ok('summarize handles a qa-less report', s.exitCode===0 && new TextDecoder().decode(s.stdout).includes('## Ingestion'));
  const d = Bun.spawnSync(['bun','bench/summarize.ts','jobs/_p-ingest','jobs/_p-holdout'],{cwd:CWD});
  ok('summarize diffs mismatched reports', d.exitCode===0);
}
await mock.stop();

// 4. agent-wide failure must invalidate, not score 0
{
  const dead = Bun.serve({port:0, fetch:(req)=> new URL(req.url).pathname.endsWith('/chat/completions')
    ? Response.json({model:'gpt-4o-mini',choices:[{message:{content:'ok'}}],usage:{prompt_tokens:1,completion_tokens:1}})
    : Response.json({error:{message:'down'}},{status:500})});
  const {code} = await run(['--split','dev','--job','_p-dead','--stage','qa','--keep-graph','--qa-concurrency','6','--no-typecheck'],
    {OPENAI_API_KEY:'sk-mock', OPENAI_BASE_URL:`http://localhost:${dead.port}/v1`});
  const r = JSON.parse(await Bun.file(`${CWD}/bench/jobs/_p-dead/report.json`).text());
  ok('dead agent => exit 3', code===3, `exit=${code}`);
  ok('dead agent => run INVALID', r.valid===false, r.invalidReason??'');
  await dead.stop(true);
}
for (const j of ['_p-attempts','_p-holdout','_p-ingest','_p-dead']) await Bun.$`rm -rf ${CWD}/bench/jobs/${j}`.quiet();
console.log(fails===0 ? '\npath checks: PASS\n' : `\npath checks: ${fails} FAILURE(S)\n`);
process.exit(fails===0?0:1);

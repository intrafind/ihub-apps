// server/tests/agent-phased-workflow.test.js
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { workflowConfigSchema } from '../validators/workflowConfigSchema.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
function check(l, c, d) { if (!c) failures++; console.log(`${c ? '✅' : '❌'} ${l}`); if (!c && d) console.log('   ' + d); }
async function run() {
  const wf = JSON.parse(readFileSync(path.join(root, 'contents/workflows/claude-style-agent-phased.json'), 'utf8'));
  check('schema-valid', workflowConfigSchema.safeParse(wf).success, JSON.stringify(workflowConfigSchema.safeParse(wf).error?.issues?.slice(0,3)));
  const byId = Object.fromEntries(wf.nodes.map(n => [n.id, n]));
  check('has inbox-load', byId['inbox-load']?.type === 'inbox-load');
  check('has planner', byId['planner']?.type === 'planner');
  check('planner has a taskTemplate with search tools', Array.isArray(byId['planner']?.config?.taskTemplate?.tools) && byId['planner'].config.taskTemplate.tools.includes('braveSearch'));
  check('has synthesize (prompt, _isSynthesizer)', byId['synthesize']?.type === 'prompt' && byId['synthesize']?.config?._isSynthesizer === true);
  check('synthesize writes draft', byId['synthesize']?.config?.outputVariable === 'draft');
  check('has adversarial verifier over draft', byId['verify']?.type === 'verifier' && byId['verify']?.config?.mode === 'adversarial' && byId['verify']?.config?.inputVariable === 'draft');
  check('has inbox-finalize', byId['inbox-finalize']?.type === 'inbox-finalize');
  const e = (s, t) => wf.edges.find(x => x.source === s && x.target === t);
  check('start→inbox-load', !!e('start', 'inbox-load'));
  check('inbox-load→planner', !!e('inbox-load', 'planner'));
  check('planner→synthesize', !!e('planner', 'synthesize'));
  check('synthesize→verify', !!e('synthesize', 'verify'));
  check('verify pass→inbox-finalize', e('verify', 'inbox-finalize')?.condition?.value === 'pass');
  check('verify retry→planner (re-plan gaps)', e('verify', 'planner')?.condition?.value === 'retry');
  check('inbox-finalize→end', !!e('inbox-finalize', 'end'));
  check('cycles allowed', wf.config?.allowCycles === true);
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run().catch(err => { console.error(err); process.exit(1); });

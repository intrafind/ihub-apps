#!/usr/bin/env node

/**
 * Per-step model configuration for agent runs:
 *   - agentProfileSchema accepts a `nodeModels` map (nodeId → modelId)
 *   - applyNodeModels() stamps config.modelId onto the matching workflow nodes
 *     (the executors honor config.modelId above the run-wide default), leaves
 *     other nodes untouched, and is a no-op when nodeModels is absent.
 *
 * Run directly: `node server/tests/agent-node-models.test.js`.
 */

import { agentProfileSchema } from '../validators/agentProfileSchema.js';
import { applyNodeModels } from '../routes/agents/runs.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

function makeWorkflow() {
  return {
    id: 'wf',
    nodes: [
      { id: 'start', type: 'start', config: {} },
      { id: 'agent', type: 'prompt', config: { tools: ['braveSearch'] } },
      { id: 'verify', type: 'verifier', config: { mode: 'adversarial' } },
      { id: 'end', type: 'end', config: {} }
    ],
    edges: []
  };
}

async function run() {
  console.log('🧪 schema accepts nodeModels\n');
  {
    const res = agentProfileSchema.safeParse({
      id: 'p1',
      name: { en: 'P1' },
      preferredModel: 'gemini-flash-3',
      nodeModels: { agent: 'gemini-flash-3', verify: 'claude-opus-4-8' }
    });
    check('valid profile with nodeModels parses', res.success, JSON.stringify(res.error?.issues?.slice(0, 2)));

    const bad = agentProfileSchema.safeParse({ id: 'p2', name: { en: 'P2' }, nodeModels: { agent: 5 } });
    check('non-string model id is rejected', bad.success === false);
  }

  console.log('\n🧪 applyNodeModels stamps per-step models\n');
  {
    const wf = makeWorkflow();
    applyNodeModels(wf, { agent: 'fast-model', verify: 'strong-model' });
    const byId = Object.fromEntries(wf.nodes.map(n => [n.id, n.config?.modelId]));
    check('agent node gets its model', byId.agent === 'fast-model', JSON.stringify(byId));
    check('verify node gets its model', byId.verify === 'strong-model', JSON.stringify(byId));
    check('unlisted node (start) is untouched', byId.start === undefined);
    check('agent node keeps its other config', wf.nodes.find(n => n.id === 'agent').config.tools.length === 1);
  }

  console.log('\n🧪 applyNodeModels is a safe no-op without a map\n');
  {
    const wf = makeWorkflow();
    applyNodeModels(wf, undefined);
    check('no modelId added when nodeModels absent', wf.nodes.every(n => n.config?.modelId === undefined));
    // Also tolerant of malformed input.
    check('no throw on null workflow', applyNodeModels(null, { agent: 'x' }) === null);
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

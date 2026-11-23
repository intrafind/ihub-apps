#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Validates the shipped Claude-style workflow (a legacy default, kept disabled
 * since the Agent Factory and its default profiles were removed):
 *   - server/defaults/workflows/claude-style-agent.json passes workflowConfigSchema
 *     and wires the adversarial self-correction loop (agent → verify → {pass:
 *     end | retry: agent}) with a tool-enabled adversarial verifier.
 *   - it wires the inbox lifecycle and stays hidden from the Workflows UI.
 *
 * Run directly: `node server/tests/claude-style-agent-workflow.test.js`.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { workflowConfigSchema } from '../validators/workflowConfigSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

async function run() {
  const workflow = readJson('server/defaults/workflows/claude-style-agent.json');

  console.log('🧪 workflow passes the schema\n');
  {
    const result = workflowConfigSchema.safeParse(workflow);
    check(
      'claude-style-agent.json is schema-valid',
      result.success,
      JSON.stringify(result.error?.issues?.slice(0, 3))
    );
  }

  console.log('\n🧪 workflow wires the adversarial self-correction loop\n');
  {
    const verify = workflow.nodes.find(n => n.id === 'verify');
    check('has a verifier node', verify?.type === 'verifier');
    check('verifier is adversarial', verify?.config?.mode === 'adversarial');
    check(
      'verifier is tool-enabled',
      Boolean(verify?.config?.integrations) && verify.config.systemTools?.length > 0
    );

    const finalizeEdge = workflow.edges.find(
      e => e.source === 'verify' && e.target === 'inbox-finalize'
    );
    const retryEdge = workflow.edges.find(e => e.source === 'verify' && e.target === 'agent');
    check('pass branch routes verify → inbox-finalize', finalizeEdge?.condition?.value === 'pass');
    check('retry branch loops verify → agent', retryEdge?.condition?.value === 'retry');
    check('cycles are allowed (loop is intentional)', workflow.config?.allowCycles === true);
  }

  console.log('\n🧪 workflow wires the deterministic inbox lifecycle (load → … → finalize)\n');
  {
    const load = workflow.nodes.find(n => n.id === 'inbox-load');
    const finalize = workflow.nodes.find(n => n.id === 'inbox-finalize');
    check('has an inbox-load node', load?.type === 'inbox-load');
    check('has an inbox-finalize node', finalize?.type === 'inbox-finalize');

    const startToLoad = workflow.edges.find(e => e.source === 'start' && e.target === 'inbox-load');
    const loadToAgent = workflow.edges.find(e => e.source === 'inbox-load' && e.target === 'agent');
    const finalizeToEnd = workflow.edges.find(
      e => e.source === 'inbox-finalize' && e.target === 'end'
    );
    check('start routes into inbox-load (not straight to agent)', !!startToLoad);
    check('inbox-load feeds the agent', !!loadToAgent);
    check('inbox-finalize closes into end', !!finalizeToEnd);

    // The agent prompt must reference the loaded inbox item, not a bare {{task}}
    // that nothing populates for an inbox-bound run (the original hallucination bug).
    const agent = workflow.nodes.find(n => n.id === 'agent');
    const promptEn = agent?.config?.prompt?.en || '';
    check('agent prompt references the loaded inbox item', /currentInboxItem\.text/.test(promptEn));
    // On a revision the agent must see its OWN prior draft (not just the gaps),
    // otherwise it rewrites from scratch and never converges.
    check('revision prompt carries the prior draft', /\{\{draft\}\}/.test(promptEn));
  }

  console.log('\n🧪 the standalone workflow ships disabled\n');
  {
    // Hidden from the Workflows UI: it was run through an Agent Factory profile,
    // which supplied the agent principal so the living-plan tools register.
    check('standalone workflow hidden from Workflows UI', workflow.enabled === false);
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

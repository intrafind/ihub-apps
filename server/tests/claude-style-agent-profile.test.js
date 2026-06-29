#!/usr/bin/env node

/**
 * Validates the shipped Claude-style autonomous agent:
 *   - contents/workflows/claude-style-agent.json passes workflowConfigSchema
 *     and wires the adversarial self-correction loop (agent → verify → {pass:
 *     end | retry: agent}) with a tool-enabled adversarial verifier.
 *   - contents/agents/profiles/claude-style-agent.json passes
 *     agentProfileSchema, references the workflow externally, and turns on the
 *     capabilities the loop relies on (dynamic tasks, memory, token budget).
 *   - serializeProfile preserves the external reference.
 *   - the agent prompt node would get the living-plan tools auto-registered.
 *
 * Run directly: `node server/tests/claude-style-agent-profile.test.js`.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { workflowConfigSchema } from '../validators/workflowConfigSchema.js';
import { agentProfileSchema } from '../validators/agentProfileSchema.js';
import { serializeProfile } from '../agents/profile/profileWorkflowSerializer.js';
import { getAgentToolIds } from '../agents/runtime/agentToolRegistrar.js';

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
  const workflow = readJson('contents/workflows/claude-style-agent.json');
  const profile = readJson('contents/agents/profiles/claude-style-agent.json');

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
      Array.isArray(verify?.config?.tools) && verify.config.tools.length > 0
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

  console.log('\n🧪 profile passes the schema\n');
  {
    const result = agentProfileSchema.safeParse(profile);
    check(
      'claude-style-agent profile is schema-valid',
      result.success,
      JSON.stringify(result.error?.issues?.slice(0, 3))
    );
  }

  console.log('\n🧪 profile enables the Claude-like capabilities\n');
  {
    check(
      'references the external workflow',
      profile.workflow?.ref === 'external' && profile.workflow?.workflowId === 'claude-style-agent'
    );
    check('dynamic tasks enabled (living plan)', profile.dynamicTasks?.enabled === true);
    check('memory enabled', profile.memory?.enabled === true);
    check('per-run token budget set', profile.budgets?.maxTokensPerRun > 0);
    check('profile is runnable (enabled)', profile.enabled === true);
    // The standalone workflow is intentionally disabled so it is hidden from
    // the Workflows UI and can only run via the agent profile (which supplies
    // the agent principal + profile so the living-plan tools register). Running
    // it as a plain workflow would strip those tools.
    check('standalone workflow hidden from Workflows UI', workflow.enabled === false);
  }

  console.log('\n🧪 serializeProfile preserves the external reference\n');
  {
    const serialized = serializeProfile(profile);
    check('still external after serialize', serialized.workflow?.ref === 'external');
    check('workflowId preserved', serialized.workflow?.workflowId === 'claude-style-agent');
  }

  console.log('\n🧪 the agent node gets living-plan + memory tools auto-registered\n');
  {
    const agentNode = workflow.nodes.find(n => n.id === 'agent');
    const ids = getAgentToolIds(profile, agentNode.config);
    check('set_plan auto-registered', ids.includes('set_plan'));
    check('update_task auto-registered', ids.includes('update_task'));
    check(
      'memory tools auto-registered',
      ids.includes('read_memory') && ids.includes('write_memory')
    );
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

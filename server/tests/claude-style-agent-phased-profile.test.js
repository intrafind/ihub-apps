#!/usr/bin/env node

/**
 * Validates the phased Claude-style autonomous agent profile:
 *   - contents/agents/profiles/claude-style-agent-phased.json passes
 *     agentProfileSchema.
 *   - Profile wires to the external phased workflow
 *     (workflow.ref === 'external', workflow.workflowId === 'claude-style-agent-phased').
 *   - nodeModels keys are a subset of the phased workflow's LLM node ids
 *     (planner, synthesize, verify) — no typo'd node ids.
 *   - Profile is enabled (runnable for live validation).
 *
 * Run directly: `node server/tests/claude-style-agent-phased-profile.test.js`.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { agentProfileSchema } from '../validators/agentProfileSchema.js';

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
  const profile = readJson('contents/agents/profiles/claude-style-agent-phased.json');
  const phasedWorkflow = readJson('contents/workflows/claude-style-agent-phased.json');

  // The LLM node ids in the phased workflow that nodeModels may reference
  const PHASED_LLM_NODE_IDS = new Set(['planner', 'synthesize', 'verify']);

  console.log('🧪 profile passes the schema\n');
  {
    const result = agentProfileSchema.safeParse(profile);
    check(
      'claude-style-agent-phased profile is schema-valid',
      result.success,
      JSON.stringify(result.error?.issues?.slice(0, 3))
    );
  }

  console.log('\n🧪 profile wires to the phased external workflow\n');
  {
    check('workflow.ref is "external"', profile.workflow?.ref === 'external');
    check(
      'workflow.workflowId is "claude-style-agent-phased"',
      profile.workflow?.workflowId === 'claude-style-agent-phased'
    );
  }

  console.log('\n🧪 nodeModels keys are valid phased-workflow LLM node ids\n');
  {
    const nodeModels = profile.nodeModels ?? {};
    const invalidKeys = Object.keys(nodeModels).filter(k => !PHASED_LLM_NODE_IDS.has(k));
    check(
      "no typo'd node ids in nodeModels",
      invalidKeys.length === 0,
      invalidKeys.length > 0 ? `Unknown node ids: ${invalidKeys.join(', ')}` : undefined
    );
    // Sanity: phased workflow actually has these node ids
    const workflowNodeIds = new Set(phasedWorkflow.nodes.map(n => n.id));
    const missingFromWorkflow = Object.keys(nodeModels).filter(k => !workflowNodeIds.has(k));
    check(
      'all nodeModels keys exist in the phased workflow',
      missingFromWorkflow.length === 0,
      missingFromWorkflow.length > 0
        ? `Not in workflow: ${missingFromWorkflow.join(', ')}`
        : undefined
    );
  }

  console.log('\n🧪 profile is runnable for live validation\n');
  {
    check('profile is enabled', profile.enabled === true);
    check('profile has a valid id', profile.id === 'claude-style-agent-phased');
    check(
      'profile has a localized name',
      typeof profile.name?.en === 'string' && profile.name.en.length > 0
    );
    check('memory enabled', profile.memory?.enabled === true);
    check('per-run token budget set', profile.budgets?.maxTokensPerRun > 0);
    check(
      'inboxId is set (inbox-load resolves)',
      typeof profile.inboxId === 'string' && profile.inboxId.length > 0
    );
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

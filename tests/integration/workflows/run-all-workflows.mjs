/**
 * Run All Workflow JSON Files - Integration Test
 *
 * Loads and executes all 4 workflow JSON files with real LLM + search tools:
 * 1. research-assistant.json - planner → agent searcher → synthesizer
 * 2. approval-workflow.json - with auto-responded human checkpoint
 * 3. iterative-research-auto.json - iterative loop with autonomous decisions
 * 4. iterative-research-human.json - with auto-responded human feedback
 *
 * Run with: node tests/integration/workflows/run-all-workflows.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import configCache from '../../../server/configCache.js';
import { WorkflowEngine } from '../../../server/services/workflow/WorkflowEngine.js';
import { StateManager } from '../../../server/services/workflow/StateManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const workflowsDir = path.join(projectRoot, 'contents/workflows');

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadWorkflow(filename) {
  const filePath = path.join(workflowsDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function waitForCompletion(engine, executionId, maxWaitMs = 180000) {
  const startTime = Date.now();
  const terminalStatuses = ['completed', 'failed', 'cancelled', 'approved', 'rejected'];

  while (Date.now() - startTime < maxWaitMs) {
    const state = await engine.getState(executionId);
    if (!state) throw new Error(`Execution ${executionId} not found`);
    if (terminalStatuses.includes(state.status)) return state;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Workflow did not complete within ${maxWaitMs}ms`);
}

async function waitForPause(engine, executionId, maxWaitMs = 120000) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const state = await engine.getState(executionId);
    if (!state) throw new Error(`Execution ${executionId} not found`);
    if (state.status === 'paused') return state;
    if (['completed', 'failed', 'cancelled'].includes(state.status)) {
      throw new Error(`Workflow reached terminal status '${state.status}' before pausing`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Workflow did not pause within ${maxWaitMs}ms`);
}

function printSection(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(70)}`);
}

function printOutput(state, outputVars) {
  console.log('Status:', state.status);
  console.log('Completed Nodes:', state.completedNodes);

  if (state.errors?.length > 0) {
    console.log(
      'Errors:',
      state.errors.map(e => e.message || e)
    );
  }

  for (const v of outputVars) {
    const value = state.data?.[v];
    if (value !== undefined) {
      const display =
        typeof value === 'string' && value.length > 150
          ? value.substring(0, 150) + '...'
          : JSON.stringify(value)?.substring(0, 150);
      console.log(`  ${v}:`, display);
    }
  }
}

// ─── Test 1: research-assistant.json ────────────────────────────────────────

async function testResearchAssistant(engine) {
  printSection('1. research-assistant.json');

  const workflow = loadWorkflow('research-assistant.json');
  console.log('Nodes:', workflow.nodes.map(n => `${n.id}(${n.type})`).join(' -> '));

  try {
    const state = await engine.start(
      workflow,
      { query: 'What are the key features of Node.js 22?' },
      { language: 'en', user: { id: 'test', username: 'test' } }
    );
    console.log('Started:', state.executionId);

    const finalState = await waitForCompletion(engine, state.executionId, 120000);
    printOutput(finalState, ['researchPlan', 'searchResults', 'finalReport']);

    const passed = finalState.status === 'completed';
    console.log(passed ? '\nPASSED' : '\nFAILED');
    return passed;
  } catch (error) {
    console.error('\nERROR:', error.message);
    return false;
  }
}

// ─── Test 2: approval-workflow.json ─────────────────────────────────────────

async function testApprovalWorkflow(engine) {
  printSection('2. approval-workflow.json (auto-approve human checkpoint)');

  const workflow = loadWorkflow('approval-workflow.json');
  console.log('Nodes:', workflow.nodes.map(n => `${n.id}(${n.type})`).join(' -> '));

  try {
    const state = await engine.start(
      workflow,
      { topic: 'Artificial Intelligence trends 2026' },
      { language: 'en', user: { id: 'test', username: 'test' } }
    );
    console.log('Started:', state.executionId);

    // Wait for the human checkpoint
    console.log('Waiting for human checkpoint...');
    const pausedState = await waitForPause(engine, state.executionId, 120000);
    console.log('Paused at node:', pausedState.data?._pausedAt);

    // Auto-respond to approve
    console.log('Auto-responding: approve');
    await engine.resume(
      state.executionId,
      {
        _humanResponse: {
          checkpointId: pausedState.data?.pendingCheckpoint?.id,
          response: 'approve',
          data: { feedback: 'Looks good, proceed with summary.' }
        }
      },
      { workflow }
    );

    const finalState = await waitForCompletion(engine, state.executionId, 120000);
    printOutput(finalState, ['topic', 'research_results', 'summary']);

    const passed = finalState.status === 'completed';
    console.log(passed ? '\nPASSED' : '\nFAILED');
    return passed;
  } catch (error) {
    console.error('\nERROR:', error.message);
    return false;
  }
}

// ─── Test 3: iterative-research-auto.json ───────────────────────────────────

async function testIterativeResearchAuto(engine) {
  printSection('3. iterative-research-auto.json (autonomous loop)');

  const workflow = loadWorkflow('iterative-research-auto.json');
  console.log('Nodes:', workflow.nodes.map(n => `${n.id}(${n.type})`).join(' -> '));

  try {
    const state = await engine.start(
      workflow,
      { task: 'Research the history and key features of TypeScript' },
      { language: 'en', user: { id: 'test', username: 'test' } }
    );
    console.log('Started:', state.executionId);

    // This workflow can take a while due to multiple research iterations
    const finalState = await waitForCompletion(engine, state.executionId, 300000);
    printOutput(finalState, ['task', 'findings', 'finalReport', 'researchState']);

    const passed = finalState.status === 'completed';
    console.log(passed ? '\nPASSED' : '\nFAILED');
    return passed;
  } catch (error) {
    console.error('\nERROR:', error.message);
    return false;
  }
}

// ─── Test 4: iterative-research-human.json ──────────────────────────────────

async function testIterativeResearchHuman(engine) {
  printSection('4. iterative-research-human.json (auto-respond human checkpoints)');

  const workflow = loadWorkflow('iterative-research-human.json');
  console.log('Nodes:', workflow.nodes.map(n => `${n.id}(${n.type})`).join(' -> '));

  try {
    const state = await engine.start(
      workflow,
      { task: 'Summarize the latest developments in WebAssembly' },
      { language: 'en', user: { id: 'test', username: 'test' } }
    );
    console.log('Started:', state.executionId);

    // This workflow pauses multiple times for human review
    let currentState = state;
    let checkpointCount = 0;
    const maxCheckpoints = 10; // Safety limit

    while (checkpointCount < maxCheckpoints) {
      // Wait for pause or completion
      const startTime = Date.now();
      const maxWaitMs = 180000;

      while (Date.now() - startTime < maxWaitMs) {
        currentState = await engine.getState(state.executionId);
        if (!currentState) throw new Error('Execution lost');
        if (
          ['completed', 'failed', 'cancelled', 'approved', 'rejected'].includes(currentState.status)
        ) {
          break;
        }
        if (currentState.status === 'paused') break;
        await new Promise(r => setTimeout(r, 500));
      }

      if (currentState.status !== 'paused') break;

      checkpointCount++;
      const pausedAt = currentState.data?._pausedAt;
      console.log(`  Checkpoint ${checkpointCount}: paused at '${pausedAt}', auto-approving...`);

      await engine.resume(
        state.executionId,
        {
          _humanResponse: {
            checkpointId: currentState.data?.pendingCheckpoint?.id,
            response: 'approve',
            data: {}
          }
        },
        { workflow }
      );
    }

    // Get final state
    const finalState = await waitForCompletion(engine, state.executionId, 60000);
    console.log(`  Total human checkpoints auto-responded: ${checkpointCount}`);
    printOutput(finalState, ['task', 'allFindings', 'finalReport']);

    const passed = finalState.status === 'completed';
    console.log(passed ? '\nPASSED' : '\nFAILED');
    return passed;
  } catch (error) {
    console.error('\nERROR:', error.message);
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Run All Workflow JSON Files ===\n');

  // Check API keys
  const hasGoogleKey = !!process.env.GOOGLE_API_KEY;
  const hasBraveKey = !!process.env.BRAVE_SEARCH_API_KEY;
  const hasAnyLLMKey =
    hasGoogleKey || !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY;

  console.log('API Key Status:');
  console.log('  GOOGLE_API_KEY:', hasGoogleKey ? 'yes' : 'no');
  console.log('  BRAVE_SEARCH_API_KEY:', hasBraveKey ? 'yes' : 'no');

  if (!hasAnyLLMKey) {
    console.log('\nNo LLM API key configured. Cannot run workflow tests.');
    process.exit(1);
  }

  // Initialize config
  console.log('\nInitializing configuration...');
  await configCache.initialize();

  const stateManager = new StateManager();
  const engine = new WorkflowEngine({ stateManager });
  const results = [];

  // Test 1: research-assistant.json (needs LLM + brave search)
  if (hasBraveKey) {
    results.push({ name: 'research-assistant', passed: await testResearchAssistant(engine) });
  } else {
    console.log('\nSkipping research-assistant (needs BRAVE_SEARCH_API_KEY)');
  }

  // Test 2: approval-workflow.json (needs LLM, optionally google search)
  results.push({ name: 'approval-workflow', passed: await testApprovalWorkflow(engine) });

  // Test 3: iterative-research-auto.json (needs LLM + google search)
  results.push({
    name: 'iterative-research-auto',
    passed: await testIterativeResearchAuto(engine)
  });

  // Test 4: iterative-research-human.json (needs LLM + google search)
  results.push({
    name: 'iterative-research-human',
    passed: await testIterativeResearchHuman(engine)
  });

  // Summary
  printSection('SUMMARY');
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} passed`);

  if (passed === total) {
    console.log('\nAll tests passed!');
    process.exit(0);
  } else {
    console.log('\nSome tests failed');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

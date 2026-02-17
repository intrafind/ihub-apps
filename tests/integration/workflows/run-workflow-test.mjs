/**
 * Manual workflow execution test
 * Run with: node tests/integration/workflows/run-workflow-test.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { WorkflowEngine } from '../../../server/services/workflow/WorkflowEngine.js';
import { StateManager } from '../../../server/services/workflow/StateManager.js';

const simpleLinearWorkflow = {
  id: 'test-simple-linear',
  name: { en: 'Simple Linear Test' },
  config: { maxIterations: 5, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'input', type: 'string', required: true }]
      }
    },
    {
      id: 'transform1',
      type: 'transform',
      name: { en: 'Process Input' },
      config: {
        operations: [{ set: 'result', value: 'processed: {{input}}' }]
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['result']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'transform1' },
    { id: 'e2', source: 'transform1', target: 'end' }
  ]
};

async function waitForCompletion(engine, executionId, maxWaitMs = 30000) {
  const startTime = Date.now();
  const terminalStatuses = ['completed', 'failed', 'cancelled'];

  while (Date.now() - startTime < maxWaitMs) {
    const state = await engine.getState(executionId);
    if (!state) throw new Error(`Execution ${executionId} not found`);
    if (terminalStatuses.includes(state.status)) return state;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Workflow did not complete within ${maxWaitMs}ms`);
}

async function main() {
  console.log('Creating workflow engine...');
  const stateManager = new StateManager();
  const engine = new WorkflowEngine({ stateManager });

  console.log('Starting simple linear workflow...');
  try {
    const state = await engine.start(
      simpleLinearWorkflow,
      { input: 'test data' },
      { language: 'en', user: { id: 'test', username: 'test' } }
    );

    console.log('Workflow started:', state.executionId);
    console.log('Initial status:', state.status);

    const finalState = await waitForCompletion(engine, state.executionId, 10000);

    console.log('\n=== FINAL STATE ===');
    console.log('Status:', finalState.status);
    console.log('Completed nodes:', finalState.completedNodes);
    console.log('Result:', finalState.data?.result);
    console.log('Errors:', finalState.errors);

    if (finalState.status === 'completed') {
      console.log('\n✅ WORKFLOW EXECUTED SUCCESSFULLY');
    } else {
      console.log('\n❌ WORKFLOW FAILED');
    }
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

main();

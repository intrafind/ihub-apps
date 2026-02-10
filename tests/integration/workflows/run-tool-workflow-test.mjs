/**
 * Tool workflow execution test
 * Run with: node tests/integration/workflows/run-tool-workflow-test.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { WorkflowEngine } from '../../../server/services/workflow/WorkflowEngine.js';
import { StateManager } from '../../../server/services/workflow/StateManager.js';

const toolCallingWorkflow = {
  id: 'test-tool-calling',
  name: { en: 'Tool Calling Test' },
  config: { maxIterations: 10, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'query', type: 'string', required: true }]
      }
    },
    {
      id: 'searcher',
      type: 'agent',
      name: { en: 'Search Agent' },
      config: {
        system: {
          en: 'You are a research assistant. Use the provided tools to search for information and provide a summary.'
        },
        prompt: {
          en: 'Search for information about: {{query}}. Use the googleSearch tool, then summarize what you found in 2-3 sentences.'
        },
        model: 'auto',
        tools: ['googleSearch'],
        maxIterations: 3,
        outputVariable: 'searchResults'
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['searchResults']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'searcher' },
    { id: 'e2', source: 'searcher', target: 'end' }
  ]
};

async function waitForCompletion(engine, executionId, maxWaitMs = 120000) {
  const startTime = Date.now();
  const terminalStatuses = ['completed', 'failed', 'cancelled'];

  while (Date.now() - startTime < maxWaitMs) {
    const state = await engine.getState(executionId);
    if (!state) throw new Error(`Execution ${executionId} not found`);
    if (terminalStatuses.includes(state.status)) return state;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Workflow did not complete within ${maxWaitMs}ms`);
}

async function main() {
  console.log('=== Tool Workflow Execution Test ===\n');

  // Check for API keys
  const hasGoogleKey = !!process.env.GOOGLE_API_KEY;
  const hasSearchKey = !!process.env.GOOGLE_SEARCH_API_KEY;
  const hasSearchCx = !!process.env.GOOGLE_SEARCH_CX;

  console.log('API Key Status:');
  console.log('  GOOGLE_API_KEY:', hasGoogleKey ? 'SET' : 'MISSING');
  console.log('  GOOGLE_SEARCH_API_KEY:', hasSearchKey ? 'SET' : 'MISSING');
  console.log('  GOOGLE_SEARCH_CX:', hasSearchCx ? 'SET' : 'MISSING');
  console.log('');

  if (!hasGoogleKey) {
    console.log('⚠️  No GOOGLE_API_KEY - LLM calls will fail');
  }
  if (!hasSearchKey || !hasSearchCx) {
    console.log('⚠️  No Google Search API configured - tool calls will fail');
  }

  console.log('\nCreating workflow engine...');
  const stateManager = new StateManager();
  const engine = new WorkflowEngine({ stateManager });

  console.log('Starting tool workflow...');
  try {
    const state = await engine.start(
      toolCallingWorkflow,
      { query: 'Node.js latest version' },
      { language: 'en', user: { id: 'test', username: 'test' } }
    );

    console.log('Workflow started:', state.executionId);
    console.log('Initial status:', state.status);
    console.log('\nWaiting for completion (this may take a while with LLM calls)...\n');

    const finalState = await waitForCompletion(engine, state.executionId, 120000);

    console.log('\n=== FINAL STATE ===');
    console.log('Status:', finalState.status);
    console.log('Completed nodes:', finalState.completedNodes);
    console.log('Search Results:', JSON.stringify(finalState.data?.searchResults, null, 2));
    console.log('Errors:', JSON.stringify(finalState.errors, null, 2));

    if (finalState.status === 'completed') {
      console.log('\n✅ WORKFLOW EXECUTED SUCCESSFULLY');
    } else {
      console.log('\n❌ WORKFLOW FAILED');
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  }
}

main();

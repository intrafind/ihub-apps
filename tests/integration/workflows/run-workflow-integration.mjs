/**
 * Workflow Integration Test with proper configuration loading
 *
 * This test properly initializes the config cache before running workflows.
 * Run with: node tests/integration/workflows/run-workflow-integration.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

// Import config cache and initialize it FIRST
import configCache from '../../../server/configCache.js';
import { WorkflowEngine } from '../../../server/services/workflow/WorkflowEngine.js';
import { StateManager } from '../../../server/services/workflow/StateManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');

// Test workflows
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

const simpleAgentWorkflow = {
  id: 'test-simple-agent',
  name: { en: 'Simple Agent Test' },
  config: { maxIterations: 5, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'text', type: 'string', required: true }]
      }
    },
    {
      id: 'summarize',
      type: 'agent',
      name: { en: 'Summarize' },
      config: {
        system: { en: 'You are a helpful assistant. Be concise. Respond in one short sentence.' },
        prompt: { en: 'Respond with a greeting for: {{text}}' },
        modelId: 'gemini-3.0-flash',
        outputVariable: 'summary'
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['summary']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'summarize' },
    { id: 'e2', source: 'summarize', target: 'end' }
  ]
};

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
          en: 'You are a research assistant. Search for information using the braveSearch tool and provide a brief summary.'
        },
        prompt: {
          en: 'Search for: {{query}}. Use braveSearch to find information, then summarize in 2-3 sentences.'
        },
        modelId: 'gemini-3.0-flash',
        tools: ['braveSearch'],
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
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Workflow did not complete within ${maxWaitMs}ms`);
}

async function runTest(name, workflow, inputData, engine, timeout = 60000) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log(`${'='.repeat(60)}`);

  try {
    const state = await engine.start(workflow, inputData, {
      language: 'en',
      user: { id: 'test', username: 'test' }
    });

    console.log('Started:', state.executionId);
    console.log('Status:', state.status);

    const finalState = await waitForCompletion(engine, state.executionId, timeout);

    console.log('\nFinal Status:', finalState.status);
    console.log('Completed Nodes:', finalState.completedNodes);

    if (finalState.errors?.length > 0) {
      console.log(
        'Errors:',
        finalState.errors.map(e => e.message)
      );
    }

    // Show relevant output data
    const outputVars = workflow.nodes.find(n => n.type === 'end')?.config?.outputVariables || [];
    outputVars.forEach(v => {
      const value = finalState.data?.[v];
      if (value !== undefined) {
        const display =
          typeof value === 'string' && value.length > 100
            ? value.substring(0, 100) + '...'
            : JSON.stringify(value);
        console.log(`Output ${v}:`, display);
      }
    });

    if (finalState.status === 'completed') {
      console.log('\n✅ PASSED');
      return true;
    } else {
      console.log('\n❌ FAILED');
      return false;
    }
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    return false;
  }
}

async function main() {
  console.log('=== Workflow Integration Tests ===\n');

  // Check API keys
  const hasGoogleKey = !!process.env.GOOGLE_API_KEY;
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasBraveKey = !!process.env.BRAVE_SEARCH_API_KEY;

  console.log('API Key Status:');
  console.log('  GOOGLE_API_KEY:', hasGoogleKey ? '✓' : '✗');
  console.log('  OPENAI_API_KEY:', hasOpenAIKey ? '✓' : '✗');
  console.log('  ANTHROPIC_API_KEY:', hasAnthropicKey ? '✓' : '✗');
  console.log('  BRAVE_SEARCH_API_KEY:', hasBraveKey ? '✓' : '✗');

  const hasLLMKey = hasGoogleKey || hasOpenAIKey || hasAnthropicKey;
  if (!hasLLMKey) {
    console.log('\n⚠️  No LLM API key configured - agent tests will be skipped');
  }

  // Initialize config cache
  console.log('\nInitializing configuration...');
  try {
    // Initialize the config cache (loads all config files)
    await configCache.initialize();

    // Check if models are available
    const { data: models } = configCache.getModels();
    console.log('Models loaded:', models?.length || 0);

    if (models?.length > 0) {
      const enabledModels = models.filter(m => m.enabled !== false);
      console.log('Enabled models:', enabledModels.length);
      const defaultModel = models.find(m => m.default) || enabledModels[0];
      console.log('Default model:', defaultModel?.id || 'none');
    }
  } catch (error) {
    console.error('Failed to initialize config:', error.message);
    console.error(error.stack);
    return;
  }

  // Create engine
  const stateManager = new StateManager();
  const engine = new WorkflowEngine({ stateManager });

  const results = [];

  // Test 1: Simple linear workflow (no LLM)
  results.push(
    await runTest(
      'Simple Linear Workflow (Transform)',
      simpleLinearWorkflow,
      { input: 'Hello World' },
      engine,
      10000
    )
  );

  // Test 2: Agent workflow (needs LLM key)
  if (hasLLMKey) {
    results.push(
      await runTest(
        'Simple Agent Workflow (LLM)',
        simpleAgentWorkflow,
        { text: 'a test user' },
        engine,
        60000
      )
    );
  } else {
    console.log('\n⏭️  Skipping agent test (no LLM API key)');
  }

  // Test 3: Tool workflow (needs LLM key + Brave search API)
  if (hasLLMKey && hasBraveKey) {
    results.push(
      await runTest(
        'Tool Calling Workflow (LLM + Tools)',
        toolCallingWorkflow,
        { query: 'Node.js version 22' },
        engine,
        90000
      )
    );
  } else {
    console.log('\n⏭️  Skipping tool test (missing LLM or BRAVE_SEARCH_API_KEY)');
  }

  // Test 4: Load research-assistant.json from file (needs LLM key + Brave search API)
  if (hasLLMKey && hasBraveKey) {
    const workflowPath = path.join(projectRoot, 'contents/workflows/research-assistant.json');
    const researchWorkflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
    results.push(
      await runTest(
        'Research Assistant (from JSON file)',
        researchWorkflow,
        { query: 'What are the latest web development trends?' },
        engine,
        120000
      )
    );
  } else {
    console.log(
      '\n⏭️  Skipping research-assistant.json test (missing LLM or BRAVE_SEARCH_API_KEY)'
    );
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`Passed: ${passed}/${total}`);

  if (passed === total) {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

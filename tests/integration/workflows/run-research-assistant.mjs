/**
 * Research Assistant Workflow Integration Test
 *
 * Tests the research-assistant.json workflow which uses:
 * - start → planner (agent) → searcher (tool) → synthesizer (agent) → end
 *
 * The searcher is a `tool` node that calls braveSearch directly (no LLM).
 * This test validates:
 * 1. The planner agent produces structured JSON with a queries array
 * 2. The tool node resolves $.researchPlan.queries[0] from state
 * 3. braveSearch executes with the resolved query parameter
 * 4. The synthesizer agent produces a final report
 *
 * Known issues tested:
 * - Tool node only runs queries[0], not all planned queries
 * - `count` param is ignored by braveSearch (only accepts query, q, chatId)
 * - If planner returns a string instead of parsed JSON, path resolution fails
 *
 * Run with: node tests/integration/workflows/run-research-assistant.mjs
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

// ─── Test Helpers ────────────────────────────────────────────────────────────

async function waitForCompletion(engine, executionId, maxWaitMs = 180000) {
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

function printSection(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(70)}`);
}

function printSubSection(title) {
  console.log(`\n--- ${title} ---`);
}

// ─── Test 1: Run the actual research-assistant.json workflow ─────────────────

async function testResearchAssistantWorkflow(engine) {
  printSection('TEST 1: Research Assistant Workflow (from JSON)');

  // Load the actual workflow JSON
  const workflowPath = path.join(projectRoot, 'contents/workflows/research-assistant.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));

  console.log('Workflow:', workflow.id);
  console.log('Nodes:', workflow.nodes.map(n => `${n.id}(${n.type})`).join(' → '));

  try {
    const state = await engine.start(
      workflow,
      { query: 'What are the key features of Node.js 22?' },
      { language: 'en', user: { id: 'test', username: 'test' } }
    );

    console.log('Started:', state.executionId);
    const finalState = await waitForCompletion(engine, state.executionId, 120000);

    console.log('\nFinal Status:', finalState.status);
    console.log('Completed Nodes:', finalState.completedNodes);

    if (finalState.errors?.length > 0) {
      console.log('\nErrors:');
      finalState.errors.forEach(e => console.log(' -', e.message || e));
    }

    // Check planner output
    printSubSection('Planner Output (researchPlan)');
    const plan = finalState.data?.researchPlan;
    if (plan) {
      const planType = typeof plan;
      console.log('Type:', planType);
      if (planType === 'object') {
        console.log('Queries:', JSON.stringify(plan.queries, null, 2));
        console.log('Approach:', plan.approach);
        console.log('✓ Planner returned parsed JSON object');
      } else {
        console.log('Value:', String(plan).substring(0, 200));
        console.log('✗ Planner returned string - $.researchPlan.queries[0] will FAIL');
      }
    } else {
      console.log('✗ No researchPlan in state');
    }

    // Check search results
    printSubSection('Search Results (searchResults)');
    const searchResults = finalState.data?.searchResults;
    if (searchResults) {
      if (searchResults.results) {
        console.log('Result count:', searchResults.results.length);
        searchResults.results.slice(0, 3).forEach((r, i) => {
          console.log(`  ${i + 1}. ${r.title}`);
        });
        console.log('✓ Tool node executed braveSearch successfully');
      } else if (searchResults.error) {
        console.log('✗ Search error:', searchResults.message || searchResults.error);
      } else {
        console.log('Raw result:', JSON.stringify(searchResults).substring(0, 200));
      }
    } else {
      console.log('✗ No searchResults in state');
    }

    // Check final report
    printSubSection('Final Report (finalReport)');
    const report = finalState.data?.finalReport;
    if (report) {
      const preview =
        typeof report === 'string'
          ? report.substring(0, 300)
          : JSON.stringify(report).substring(0, 300);
      console.log('Preview:', preview + '...');
      console.log('✓ Synthesizer produced final report');
    } else {
      console.log('✗ No finalReport in state');
    }

    if (finalState.status === 'completed') {
      console.log('\n✅ TEST 1 PASSED');
      return true;
    } else {
      console.log('\n❌ TEST 1 FAILED');
      return false;
    }
  } catch (error) {
    console.error('\n❌ TEST 1 ERROR:', error.message);
    return false;
  }
}

// ─── Test 2: Agent-based searcher (uses LLM to call braveSearch for all queries)

async function testAgentSearcherWorkflow(engine) {
  printSection('TEST 2: Agent-based Searcher (LLM calls braveSearch for all queries)');

  // Modified workflow: searcher is agent type with braveSearch tool
  // This lets the LLM decide how many searches to run
  const workflow = {
    id: 'test-research-agent-searcher',
    name: { en: 'Research with Agent Searcher' },
    config: { maxIterations: 15, allowCycles: false },
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
        id: 'planner',
        type: 'agent',
        name: { en: 'Research Planner' },
        config: {
          system: {
            en: 'You are a research planning specialist. Break down the user\'s research question into 2-3 specific search queries. Return a JSON object with a "queries" array and an "approach" string.'
          },
          prompt: { en: 'Plan research queries for: {{query}}' },
          modelId: 'gemini-3.0-flash',
          outputVariable: 'researchPlan',
          outputSchema: {
            type: 'object',
            properties: {
              queries: { type: 'array', items: { type: 'string' } },
              approach: { type: 'string' }
            }
          },
          maxIterations: 3
        }
      },
      {
        id: 'searcher',
        type: 'agent',
        name: { en: 'Web Searcher' },
        config: {
          system: {
            en: 'You are a web research assistant. You have access to braveSearch for web searches. Execute search queries to gather information. Use the braveSearch tool for each query. After searching, compile all results into a summary.'
          },
          prompt: {
            en: 'Execute the following search queries and compile results:\n\nResearch Plan: {{researchPlan}}\n\nUse braveSearch for each planned query. After all searches, summarize the key findings.'
          },
          modelId: 'gemini-3.0-flash',
          tools: ['braveSearch'],
          maxIterations: 8,
          outputVariable: 'searchResults'
        }
      },
      {
        id: 'synthesizer',
        type: 'agent',
        name: { en: 'Research Synthesizer' },
        config: {
          system: {
            en: 'You are a research synthesis specialist. Given the original query and search results, create a comprehensive, well-structured answer. Cite sources where appropriate.'
          },
          prompt: {
            en: 'Original question: {{query}}\n\nSearch Results:\n{{searchResults}}\n\nCreate a comprehensive answer with citations.'
          },
          modelId: 'gemini-3.0-flash',
          outputVariable: 'finalReport',
          maxIterations: 3
        }
      },
      {
        id: 'end',
        type: 'end',
        name: { en: 'End' },
        config: {
          outputVariables: ['finalReport', 'searchResults', 'researchPlan']
        }
      }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'planner' },
      { id: 'e2', source: 'planner', target: 'searcher' },
      { id: 'e3', source: 'searcher', target: 'synthesizer' },
      { id: 'e4', source: 'synthesizer', target: 'end' }
    ]
  };

  console.log('Nodes:', workflow.nodes.map(n => `${n.id}(${n.type})`).join(' → '));
  console.log('Searcher type: agent with tools: [braveSearch]');
  console.log('This allows the LLM to run multiple searches adaptively.\n');

  try {
    const state = await engine.start(
      workflow,
      { query: 'What are the key features of Node.js 22?' },
      { language: 'en', user: { id: 'test', username: 'test' } }
    );

    console.log('Started:', state.executionId);
    const finalState = await waitForCompletion(engine, state.executionId, 180000);

    console.log('\nFinal Status:', finalState.status);
    console.log('Completed Nodes:', finalState.completedNodes);

    if (finalState.errors?.length > 0) {
      console.log('\nErrors:');
      finalState.errors.forEach(e => console.log(' -', e.message || e));
    }

    // Check planner output
    printSubSection('Planner Output');
    const plan = finalState.data?.researchPlan;
    if (plan && typeof plan === 'object') {
      console.log('Queries:', JSON.stringify(plan.queries));
    } else {
      console.log('Plan:', String(plan).substring(0, 200));
    }

    // Check search results (this will be the LLM's compiled summary)
    printSubSection('Search Results (agent-compiled)');
    const searchResults = finalState.data?.searchResults;
    if (searchResults) {
      const preview =
        typeof searchResults === 'string'
          ? searchResults.substring(0, 400)
          : JSON.stringify(searchResults).substring(0, 400);
      console.log('Preview:', preview + '...');
    }

    // Check final report
    printSubSection('Final Report');
    const report = finalState.data?.finalReport;
    if (report) {
      const preview =
        typeof report === 'string'
          ? report.substring(0, 400)
          : JSON.stringify(report).substring(0, 400);
      console.log('Preview:', preview + '...');
    }

    if (finalState.status === 'completed') {
      console.log('\n✅ TEST 2 PASSED');
      return true;
    } else {
      console.log('\n❌ TEST 2 FAILED');
      return false;
    }
  } catch (error) {
    console.error('\n❌ TEST 2 ERROR:', error.message);
    return false;
  }
}

// ─── Test 3: Variable resolution unit test ───────────────────────────────────

async function testVariableResolution() {
  printSection('TEST 3: Variable Resolution (unit test)');

  // Simulate what happens in the workflow
  const { BaseNodeExecutor } =
    await import('../../../server/services/workflow/executors/BaseNodeExecutor.js');
  const executor = new BaseNodeExecutor();

  // Simulate state after planner agent runs (parsed JSON object)
  const stateWithParsedPlan = {
    query: 'Node.js features',
    researchPlan: {
      queries: ['Node.js 22 new features', 'Node.js 22 vs 20 comparison', 'Node.js 22 LTS release'],
      approach: 'Compare features across versions'
    }
  };

  // Simulate state when planner returns a string (not parsed)
  const stateWithStringPlan = {
    query: 'Node.js features',
    researchPlan: '{"queries": ["Node.js 22 features"], "approach": "search"}'
  };

  let passed = true;

  // Test 1: Resolve queries[0] from parsed object
  const resolved1 = executor.resolveVariable('$.researchPlan.queries[0]', stateWithParsedPlan);
  console.log('$.researchPlan.queries[0] (parsed):', resolved1);
  if (resolved1 === 'Node.js 22 new features') {
    console.log('  ✓ Correctly resolved first query');
  } else {
    console.log('  ✗ Expected "Node.js 22 new features", got:', resolved1);
    passed = false;
  }

  // Test 2: Resolve queries[1]
  const resolved2 = executor.resolveVariable('$.researchPlan.queries[1]', stateWithParsedPlan);
  console.log('$.researchPlan.queries[1] (parsed):', resolved2);
  if (resolved2 === 'Node.js 22 vs 20 comparison') {
    console.log('  ✓ Correctly resolved second query');
  } else {
    console.log('  ✗ Expected "Node.js 22 vs 20 comparison", got:', resolved2);
    passed = false;
  }

  // Test 3: Resolve from string plan (fails!)
  const resolved3 = executor.resolveVariable('$.researchPlan.queries[0]', stateWithStringPlan);
  console.log('$.researchPlan.queries[0] (string):', resolved3);
  if (resolved3 === undefined) {
    console.log('  ✓ Correctly returns undefined (string has no .queries property)');
    console.log('  ⚠  This is a known issue: if outputSchema parsing fails, tool node breaks');
  } else {
    console.log('  ✗ Unexpected result:', resolved3);
    passed = false;
  }

  // Test 4: Resolve nested object
  const resolvedParams = executor.resolveVariables(
    { query: '$.researchPlan.queries[0]', count: 5 },
    stateWithParsedPlan
  );
  console.log('resolveVariables({query: "$.researchPlan.queries[0]", count: 5}):', resolvedParams);
  if (resolvedParams.query === 'Node.js 22 new features' && resolvedParams.count === 5) {
    console.log('  ✓ Parameter resolution works correctly for tool node');
  } else {
    console.log('  ✗ Parameter resolution failed');
    passed = false;
  }

  // Test 5: braveSearch ignores `count` param
  console.log('\nNote: braveSearch only accepts {query, q, chatId}');
  console.log('The `count: 5` parameter in research-assistant.json is silently ignored.');

  if (passed) {
    console.log('\n✅ TEST 3 PASSED');
  } else {
    console.log('\n❌ TEST 3 FAILED');
  }
  return passed;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║            Research Assistant Workflow Tests                         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // Check requirements
  const hasGoogleKey = !!process.env.GOOGLE_API_KEY;
  const hasBraveKey = !!process.env.BRAVE_SEARCH_API_KEY;

  console.log('\nAPI Key Status:');
  console.log('  GOOGLE_API_KEY:', hasGoogleKey ? '✓' : '✗');
  console.log('  BRAVE_SEARCH_API_KEY:', hasBraveKey ? '✓' : '✗');

  if (!hasGoogleKey) {
    console.log('\n⚠️  GOOGLE_API_KEY required for LLM calls. Skipping integration tests.');
  }
  if (!hasBraveKey) {
    console.log('\n⚠️  BRAVE_SEARCH_API_KEY required for search. Skipping integration tests.');
  }

  // Initialize config
  console.log('\nInitializing configuration...');
  await configCache.initialize();

  const stateManager = new StateManager();
  const engine = new WorkflowEngine({ stateManager });
  const results = [];

  // Test 3: Variable resolution (no API keys needed)
  results.push(await testVariableResolution());

  // Integration tests (need API keys)
  if (hasGoogleKey && hasBraveKey) {
    // Test 1: Original research-assistant.json workflow (tool node)
    results.push(await testResearchAssistantWorkflow(engine));

    // Test 2: Modified workflow with agent searcher (LLM calls tools)
    results.push(await testAgentSearcherWorkflow(engine));
  } else {
    console.log('\n⏭️  Skipping integration tests (missing API keys)');
  }

  // Summary
  printSection('SUMMARY');
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`Passed: ${passed}/${total}`);

  console.log('\n--- Key Findings ---');
  console.log('1. `tool` node calls braveSearch directly (no LLM) — fast but limited');
  console.log('   - Only runs ONE query: $.researchPlan.queries[0]');
  console.log('   - `count` parameter is ignored by braveSearch');
  console.log('   - Fails if planner returns string instead of parsed JSON');
  console.log('');
  console.log('2. `agent` node with tools: ["braveSearch"] — flexible');
  console.log('   - LLM decides how many searches to run');
  console.log('   - Can adapt queries based on initial results');
  console.log('   - Handles all planned queries automatically');

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

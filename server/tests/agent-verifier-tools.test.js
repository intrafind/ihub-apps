#!/usr/bin/env node

/**
 * Integration-ish tests for VerifierNodeExecutor.execute():
 *   - tool-enabled adversarial mode delegates to a tool loop (PromptNodeExecutor)
 *     so the verifier actually runs checks before its verdict
 *   - a FAIL/PARTIAL verdict routes to the `retry` branch and surfaces
 *     `_lastReviewGaps` for planner reconsideration
 *   - toolless adversarial mode uses a single LLM call (no tool loop)
 *
 * Seeds a fake model into configCache so execute() can resolve a model without
 * a running server. Run directly: `node server/tests/agent-verifier-tools.test.js`.
 */

import configCache from '../configCache.js';
import { VerifierNodeExecutor } from '../services/workflow/executors/VerifierNodeExecutor.js';

// Seed a fake enabled+default model so execute()'s model resolution succeeds.
configCache.cache.set('config/models.json', {
  data: [{ id: 'test-model', provider: 'openai', enabled: true, default: true, maxOutputTokens: 4096 }],
  etag: 'test'
});

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const stubLlmHelper = {
  verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
  // Used by the toolless path.
  executeStreamingRequest: async () => ({
    content: JSON.stringify({ verdict: 'PASS', failures: [], rationale: 'looks solid' })
  })
};

const stateWith = output => ({ data: { nodeResults: { synth: { output: { content: output } } } } });

async function run() {
  console.log('🧪 tool-enabled adversarial verifier delegates to a tool loop\n');
  {
    let toolLoopArgs = null;
    const promptExecutor = {
      getAgentTools: async ids => ids.map(id => ({ id, name: id, parameters: { type: 'object', properties: {} } })),
      executeLLMWithTools: async args => {
        toolLoopArgs = args;
        return {
          content: JSON.stringify({
            verdict: 'PARTIAL',
            failures: ['Claim in section 2 could not be verified against any source'],
            rationale: 'One unsupported claim remains after checking.'
          })
        };
      }
    };
    const exec = new VerifierNodeExecutor({ llmHelper: stubLlmHelper, promptExecutor });
    const node = {
      id: 'verify1',
      config: { mode: 'adversarial', tools: ['web_search'], criteria: 'All claims must be sourced' }
    };
    const result = await exec.execute(node, stateWith('a report with claims'), { language: 'en' });

    check('ran the tool loop', toolLoopArgs !== null);
    check('passed resolved tools into the loop', (toolLoopArgs?.tools?.length || 0) > 0);
    check('verdict PARTIAL → retry branch', result.branch === 'retry');
    check(
      'surfaces failures as _lastReviewGaps',
      Array.isArray(result.stateUpdates._lastReviewGaps) && result.stateUpdates._lastReviewGaps.length === 1
    );
    check('records adversarial verdict', result.stateUpdates.verificationResult.verdict === 'PARTIAL');
  }

  console.log('\n🧪 toolless adversarial verifier uses a single LLM call (no tool loop)\n');
  {
    let toolLoopCalled = false;
    const promptExecutor = {
      getAgentTools: async () => [],
      executeLLMWithTools: async () => {
        toolLoopCalled = true;
        return { content: '{}' };
      }
    };
    const exec = new VerifierNodeExecutor({ llmHelper: stubLlmHelper, promptExecutor });
    const node = { id: 'verify2', config: { mode: 'adversarial', criteria: 'Be complete' } }; // no tools
    const result = await exec.execute(node, stateWith('a report'), { language: 'en' });

    check('did NOT run the tool loop', toolLoopCalled === false);
    check('PASS verdict → pass branch', result.branch === 'pass');
  }

  console.log('\n🧪 quality mode is unaffected by tools wiring\n');
  {
    const qualityHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => ({
        content: JSON.stringify({ score: 0.9, passed: true, feedback: 'good' })
      })
    };
    const exec = new VerifierNodeExecutor({ llmHelper: qualityHelper });
    const node = { id: 'verify3', config: { mode: 'quality', threshold: 0.7 } };
    const result = await exec.execute(node, stateWith('output'), { language: 'en' });
    check('quality score passes', result.branch === 'pass' && result.output.score === 0.9);
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

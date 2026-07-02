#!/usr/bin/env node

/**
 * Regression test for PlannerNodeExecutor output-token budget.
 *
 * Bug: the planner hardcoded `maxTokens: 8192` in its LLM request, ignoring
 * the resolved model's own `maxOutputTokens`. On a Gemini thinking model with
 * an unlimited thinking budget, 8192 output tokens were consumed by reasoning
 * and the answer JSON was truncated mid-stream → "Failed to parse plan".
 *
 * The planner must derive its output cap from `config.maxTokens` →
 * `model.maxOutputTokens` → a sane floor, NOT a hardcoded 8192. This lets a
 * 32k-output model (gemini-flash-latest) actually use its full budget.
 *
 * Run directly: `node server/tests/planner-maxtokens.test.js`.
 */

import { PlannerNodeExecutor } from '../services/workflow/executors/PlannerNodeExecutor.js';
import configCache from '../configCache.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

// Stub the model catalog so _generatePlan resolves a known model with a
// 32k output budget — same singleton instance the executor imports.
const testModel = {
  id: 'gemini-flash-latest',
  provider: 'google',
  maxOutputTokens: 32768,
  default: true
};
configCache.getModels = () => ({ data: [testModel] });

// Fake LLM helper: capture the request options, return a valid minimal plan.
function makeHelper(capture) {
  return {
    verifyApiKey: async () => ({ success: true, apiKey: 'test-key' }),
    executeStreamingRequest: async ({ options }) => {
      capture.options = options;
      return {
        content: JSON.stringify({
          tasks: [{ id: 't1', title: 'T', description: 'D', dependsOn: [] }],
          reasoning: 'r'
        }),
        usage: null
      };
    }
  };
}

const baseState = () => ({
  executionId: 'test-exec',
  data: {
    _agentModelConfig: { defaultModelId: 'gemini-flash-latest', nodeModels: {} }
  }
});

console.log('🧪 planner output cap — derives from model.maxOutputTokens, not hardcoded 8192\n');
{
  const capture = {};
  const executor = new PlannerNodeExecutor({ llmHelper: makeHelper(capture) });
  await executor._generatePlan('Test goal', {}, baseState(), { language: 'en' }, {}, 'planner');
  check(
    'maxTokens passed to LLM equals model.maxOutputTokens (32768)',
    capture.options?.maxTokens === 32768,
    `got ${capture.options?.maxTokens}`
  );
}

console.log('\n🧪 planner output cap — explicit config.maxTokens wins over model default\n');
{
  const capture = {};
  const executor = new PlannerNodeExecutor({ llmHelper: makeHelper(capture) });
  await executor._generatePlan(
    'Test goal',
    { maxTokens: 16000 },
    baseState(),
    { language: 'en' },
    {},
    'planner'
  );
  check(
    'maxTokens passed to LLM equals config.maxTokens (16000)',
    capture.options?.maxTokens === 16000,
    `got ${capture.options?.maxTokens}`
  );
}

console.log('\n🧪 planner output cap — falls back to a floor when model has no maxOutputTokens\n');
{
  const capture = {};
  configCache.getModels = () => ({
    data: [{ id: 'gemini-flash-latest', provider: 'google', default: true }]
  });
  const executor = new PlannerNodeExecutor({ llmHelper: makeHelper(capture) });
  await executor._generatePlan('Test goal', {}, baseState(), { language: 'en' }, {}, 'planner');
  check(
    'maxTokens falls back to 8192 floor when model omits maxOutputTokens',
    capture.options?.maxTokens === 8192,
    `got ${capture.options?.maxTokens}`
  );
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);

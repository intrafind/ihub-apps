#!/usr/bin/env node

/**
 * Tests for WorkflowLLMHelper.runSingleShotLLM — the shared "verify API key →
 * execute a single request → return a uniform result" helper that replaced
 * hand-rolled copies in QueryPlanNodeExecutor and QuoteValidatorNodeExecutor.
 *
 * Run directly: `node server/tests/workflow-run-single-shot-llm.test.js`.
 */

import { WorkflowLLMHelper } from '../services/workflow/WorkflowLLMHelper.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function run() {
  const model = { id: 'test-model' };

  {
    // Verifies then calls, returning { success: true, content }.
    const helper = new WorkflowLLMHelper();
    helper.verifyApiKey = async () => ({ success: true, apiKey: 'k' });
    let capturedApiKey = null;
    helper.executeStreamingRequest = async ({ apiKey }) => {
      capturedApiKey = apiKey;
      return { content: 'hello', usage: { input_tokens: 1 } };
    };
    const result = await helper.runSingleShotLLM({ model, messages: [] });
    check('success result carries content', result.success === true && result.content === 'hello');
    check('uses the apiKey returned by verifyApiKey', capturedApiKey === 'k');
  }

  {
    // Pre-verified apiKey skips verifyApiKey entirely (loop-reuse case).
    const helper = new WorkflowLLMHelper();
    let verifyCalls = 0;
    helper.verifyApiKey = async () => {
      verifyCalls += 1;
      return { success: true, apiKey: 'unused' };
    };
    helper.executeStreamingRequest = async ({ apiKey }) => ({ content: `echo:${apiKey}` });
    const result = await helper.runSingleShotLLM({ model, messages: [], apiKey: 'preresolved' });
    check('skips verifyApiKey when apiKey is pre-supplied', verifyCalls === 0);
    check('uses the pre-supplied apiKey', result.content === 'echo:preresolved');
  }

  {
    // API key verification failure surfaces as a labeled error result, not a throw.
    const helper = new WorkflowLLMHelper();
    helper.verifyApiKey = async () => ({ success: false, error: null });
    const result = await helper.runSingleShotLLM({
      model,
      messages: [],
      errorLabel: 'query-plan LLM call'
    });
    check('failure result has success: false', result.success === false);
    check(
      'falls back to a labeled message when verifyApiKey has no error.message',
      result.error === 'API key verification failed for query-plan LLM call',
      result.error
    );
  }

  {
    // A thrown executeStreamingRequest error becomes a labeled error result.
    const helper = new WorkflowLLMHelper();
    helper.verifyApiKey = async () => ({ success: true, apiKey: 'k' });
    helper.executeStreamingRequest = async () => {
      throw new Error('network blip');
    };
    const result = await helper.runSingleShotLLM({
      model,
      messages: [],
      errorLabel: 'query-plan LLM call'
    });
    check('call failure result has success: false', result.success === false);
    check(
      'call failure message matches "<label> failed: <message>"',
      result.error === 'query-plan LLM call failed: network blip',
      result.error
    );
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await run();

#!/usr/bin/env node

/**
 * Regression test for the `nativeWebSearch is not defined` workflow crash.
 *
 * The websearch refactor (commit b397934) moved native-search resolution into
 * `execute()`, where it computes a local `nativeWebSearch` directive, then
 * referenced that same name inside `executeLLMWithTools()` — a separate method
 * whose scope never contained it. Because the reference sits in the tool loop's
 * first iteration (`nativeWebSearch: !forceFinish ? nativeWebSearch : null`,
 * with `forceFinish` starting false), EVERY prompt node threw
 * `ReferenceError: nativeWebSearch is not defined` the moment it reached the
 * LLM call — surfacing as "Node <id> failed: Agent execution failed:
 * nativeWebSearch is not defined" (the stellungnahmen workflow hit it on its
 * first prompt node, `refine-decision`).
 *
 * The fix threads `nativeWebSearch` into `executeLLMWithTools()` as an
 * explicit parameter. These tests verify the loop no longer throws and that the
 * directive is forwarded verbatim to the adapter request options.
 *
 * Run directly: `node server/tests/workflow-native-websearch-threading.test.js`.
 */

import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

// A minimal llmHelper stub: passes API-key verification and returns a
// tool-less response so the loop breaks after a single iteration. It records
// the options the executor forwarded so we can assert on nativeWebSearch.
function makeExecutor() {
  const captured = { calls: [] };
  const llmHelper = {
    verifyApiKey: async () => ({ success: true, apiKey: 'test-key' }),
    executeStreamingRequest: async ({ options }) => {
      captured.calls.push(options);
      return { content: 'done', finishReason: 'stop' };
    }
  };
  const executor = new PromptNodeExecutor({ llmHelper });
  return { executor, captured };
}

const baseArgs = {
  model: { id: 'test-model', provider: 'anthropic', maxOutputTokens: 4096 },
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  config: {},
  context: {},
  nodeId: 'refine-decision'
};

console.log('🧪 executeLLMWithTools threads nativeWebSearch instead of throwing\n');

// 1. The exact regression: an Anthropic native-search directive must reach the
//    adapter, and the call must not throw a ReferenceError.
{
  const { executor, captured } = makeExecutor();
  const directive = { provider: 'anthropic' };
  let threw = null;
  let result = null;
  try {
    result = await executor.executeLLMWithTools({ ...baseArgs, nativeWebSearch: directive });
  } catch (e) {
    threw = e;
  }
  check(
    'does not throw (previously ReferenceError: nativeWebSearch)',
    threw === null,
    threw?.message
  );
  check('returns the model content', result?.content === 'done');
  check(
    'forwards the nativeWebSearch directive to the adapter options',
    captured.calls.length === 1 &&
      JSON.stringify(captured.calls[0]?.nativeWebSearch) === JSON.stringify(directive),
    `got ${JSON.stringify(captured.calls[0]?.nativeWebSearch)}`
  );
}

// 2. Omitting nativeWebSearch (a node without web search, like refine-decision)
//    must default to null — never undefined-that-throws.
{
  const { executor, captured } = makeExecutor();
  let threw = null;
  try {
    await executor.executeLLMWithTools({ ...baseArgs });
  } catch (e) {
    threw = e;
  }
  check('does not throw when nativeWebSearch is omitted', threw === null, threw?.message);
  check(
    'defaults nativeWebSearch to null in adapter options',
    captured.calls[0]?.nativeWebSearch === null,
    `got ${JSON.stringify(captured.calls[0]?.nativeWebSearch)}`
  );
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
//
// Run wf-exec-f4f70e84: 151/151 braveSearch calls returned HTTP 429. The model
// re-tried the rate-limited tool every round, burning all 8 iterations per task
// and re-sending the accumulating history each time (~60K input/task, mostly
// futile). The circuit-breaker disables a tool after it is rate-limited a few
// times within a step, and force-finishes when no usable tools remain — so a
// dead tool can't drag the loop to the round cap.
//
// Run directly: node server/tests/agent-tool-circuit-breaker.test.js
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

const model = { id: 'test-model', provider: 'openai', maxOutputTokens: 4096 };

// ---- pure classifier ----
{
  const e = new PromptNodeExecutor();
  const ok = e._classifyToolResult({ content: JSON.stringify({ results: [{ url: 'x' }] }) });
  check('success result → not failed', ok.failed === false && ok.rateLimited === false);

  const rl = e._classifyToolResult({
    content: JSON.stringify({ error: true, message: 'Search failed with brave: status 429 (Too Many Requests)' })
  });
  check('429 error → failed + rateLimited', rl.failed === true && rl.rateLimited === true);

  const nf = e._classifyToolResult({
    content: JSON.stringify({ error: true, message: 'Page could not be found (HTTP 404)' })
  });
  check('404 error → failed but NOT rate-limited', nf.failed === true && nf.rateLimited === false);

  check('non-JSON content → not failed', e._classifyToolResult({ content: 'plain text' }).failed === false);
  check('missing content → not failed', e._classifyToolResult({}).failed === false);
}

// ---- integration: a rate-limited tool gets disabled and the loop force-finishes ----
function makeExecutor(toolError) {
  const calls = { count: 0, withToolsOffered: 0 };
  const llmHelper = {
    verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
    executeStreamingRequest: async ({ options }) => {
      calls.count += 1;
      const offered = Array.isArray(options.tools) && options.tools.length > 0;
      if (offered) {
        calls.withToolsOffered += 1;
        return {
          content: '',
          toolCalls: [{ id: `c${calls.count}`, index: 0, function: { name: 'braveSearch', arguments: '{}' } }],
          usage: { input_tokens: 50, output_tokens: 5 },
          finishReason: 'tool_calls'
        };
      }
      return { content: 'final answer', toolCalls: [], usage: { input_tokens: 5, output_tokens: 5 }, finishReason: 'stop' };
    }
  };
  const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
  executor.executeToolCall = async toolCall => ({
    role: 'tool',
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    content: JSON.stringify(toolError)
  });
  return { executor, calls };
}

async function run() {
  console.log('\n🧪 rate-limited tool is circuit-broken; loop ends early\n');
  {
    const { executor, calls } = makeExecutor({
      error: true,
      message: 'Search failed with brave: Brave search failed with status 429 (Too Many Requests)'
    });
    const context = { language: 'en', _agentProfile: { budgets: {} }, _workflowState: { executionId: 'e', data: {} } };
    const tools = [{ id: 'braveSearch', name: 'braveSearch', parameters: { type: 'object', properties: {} } }];

    const res = await executor.executeLLMWithTools({
      model,
      messages: [{ role: 'user', content: 'verify a fact' }],
      tools,
      config: { maxIterations: 8 },
      context,
      nodeId: 'verify-x'
    });

    check('stopped well before the 8-round cap', res.iterations <= 4, `iterations=${res.iterations}`);
    check('reported the rate-limited tool as disabled', Array.isArray(res.disabledTools) && res.disabledTools.includes('braveSearch'), JSON.stringify(res.disabledTools));
    check('still produced a final answer', res.content.includes('final answer'));
    check('stopped offering the dead tool', calls.withToolsOffered < calls.count, `withTools=${calls.withToolsOffered} total=${calls.count}`);
  }

  console.log('\n🧪 per-item 404s do NOT disable a working tool\n');
  {
    // A 404 from one URL is input-specific — the tool itself still works, so it
    // must NOT be circuit-broken. With tools always offered and the model always
    // calling, only the round cap stops it (proving the breaker did not fire).
    const { executor } = makeExecutor({ error: true, message: 'Page could not be found (HTTP 404)' });
    const context = { language: 'en', _agentProfile: { budgets: {} }, _workflowState: { executionId: 'e2', data: {} } };
    const tools = [{ id: 'webContentExtractor', name: 'braveSearch', parameters: { type: 'object', properties: {} } }];
    const res = await executor.executeLLMWithTools({
      model,
      messages: [{ role: 'user', content: 'extract' }],
      tools,
      config: { maxIterations: 5 },
      context,
      nodeId: 'extract-x'
    });
    check('404 did not trip the breaker (ran to cap)', res.iterations === 5, `iterations=${res.iterations}`);
    check('no tools disabled for per-item 404', (res.disabledTools || []).length === 0, JSON.stringify(res.disabledTools));
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

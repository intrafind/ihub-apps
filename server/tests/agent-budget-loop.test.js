#!/usr/bin/env node

/**
 * Unit tests for budget-driven tool-loop continuation in PromptNodeExecutor
 * (`executeLLMWithTools`). Verifies that a per-run token budget nudges the
 * agent to wrap up — answering the current round's tool calls, then doing a
 * final tool-less turn — instead of looping until the round cap.
 *
 * Run directly: `node server/tests/agent-budget-loop.test.js`.
 */

import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const model = { id: 'test-model', provider: 'openai', maxOutputTokens: 4096 };

/**
 * Build an executor whose LLM helper returns a tool call (with `tokensPerCall`
 * usage) on every turn that is offered tools, and a final tool-less answer
 * once tools are withheld (forceFinish). Counts how many times it was called.
 */
function makeExecutor(tokensPerCall) {
  const calls = { count: 0, withToolsOffered: 0 };
  const llmHelper = {
    verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
    executeStreamingRequest: async ({ options }) => {
      calls.count += 1;
      const toolsOffered = Array.isArray(options.tools) && options.tools.length > 0;
      if (toolsOffered) {
        calls.withToolsOffered += 1;
        return {
          content: '',
          toolCalls: [
            { id: `c${calls.count}`, index: 0, function: { name: 'noop', arguments: '{}' } }
          ],
          usage: { input_tokens: tokensPerCall, output_tokens: 0 },
          finishReason: 'tool_calls'
        };
      }
      // No tools offered → produce a final answer.
      return {
        content: 'final answer',
        toolCalls: [],
        usage: { input_tokens: 5, output_tokens: 5 },
        finishReason: 'stop'
      };
    }
  };
  const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
  // Stub tool execution so we don't touch the real tool registry.
  executor.executeToolCall = async toolCall => ({
    role: 'tool',
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    content: 'ok'
  });
  return { executor, calls };
}

function makeContext(maxTokensPerRun) {
  return {
    language: 'en',
    _agentProfile: { budgets: { maxTokensPerRun } },
    _workflowState: { executionId: 'exec1', data: {} }
  };
}

async function run() {
  console.log('🧪 budget gate wraps the loop up early\n');
  {
    const { executor, calls } = makeExecutor(600); // 600 tokens per tool round
    const context = makeContext(1000); // budget exhausted after ~2 rounds
    const node = { id: 'n1', config: { maxIterations: 20 } };
    const tools = [{ id: 'noop', name: 'noop', parameters: { type: 'object', properties: {} } }];

    const res = await executor.executeLLMWithTools({
      model,
      messages: [{ role: 'user', content: 'do work' }],
      tools,
      config: node.config,
      context,
      nodeId: node.id
    });

    check(
      'stopped well before the 20-round cap',
      res.iterations <= 4,
      `iterations=${res.iterations}`
    );
    check('flagged budget exhausted', res.budgetExhausted === true);
    check('produced the final answer', res.content.includes('final answer'));
    check(
      'run budget recorded on workflow state',
      context._workflowState.data._budget?.total >= 1000,
      `total=${context._workflowState.data._budget?.total}`
    );
    check(
      'last turn was offered no tools (forced finish)',
      calls.withToolsOffered < calls.count,
      `withTools=${calls.withToolsOffered} total=${calls.count}`
    );
  }

  console.log('\n🧪 no budget → stops naturally when model stops calling tools\n');
  {
    // tokensPerCall huge but budget unlimited (0); model calls a tool once then
    // (because tools are still offered) would loop — so cap the rounds low to
    // confirm unlimited budget never force-finishes.
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => ({
        content: 'done',
        toolCalls: [],
        usage: { input_tokens: 10, output_tokens: 10 },
        finishReason: 'stop'
      })
    };
    const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
    const context = makeContext(0); // unlimited
    const res = await executor.executeLLMWithTools({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      config: {},
      context,
      nodeId: 'n2'
    });
    check('single turn, no tools', res.iterations === 1);
    check('not budget exhausted', res.budgetExhausted === false);
    check('content returned', res.content === 'done');
  }

  console.log('\n🧪 round cap forces a final answer (no "thinking-only" output)\n');
  {
    // The bug from runs wf-exec-4a533dcf / 717a7e69: with unlimited budget, a
    // model that keeps calling tools hit the round cap and the loop exited with
    // only interim narration — never the deliverable (agent) or verdict
    // (verifier). The last round must withhold tools and force a real answer.
    const { executor, calls } = makeExecutor(10); // tiny token cost, never budget-bound
    const context = makeContext(0); // unlimited budget — only the round cap can stop it
    const node = { id: 'n3', config: { maxIterations: 4 } };
    const tools = [{ id: 'noop', name: 'noop', parameters: { type: 'object', properties: {} } }];

    const res = await executor.executeLLMWithTools({
      model,
      messages: [{ role: 'user', content: 'write a detailed report' }],
      tools,
      config: node.config,
      context,
      nodeId: node.id
    });

    check('ran up to the round cap', res.iterations === 4, `iterations=${res.iterations}`);
    check('forced a final answer (not just narration)', res.content.includes('final answer'));
    check(
      'final round withheld tools (forced compose)',
      calls.withToolsOffered < calls.count,
      `withTools=${calls.withToolsOffered} total=${calls.count}`
    );
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

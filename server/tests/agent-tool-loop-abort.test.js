#!/usr/bin/env node

/**
 * Regression tests for #1683: cancellation and node timeout could not
 * interrupt an in-flight agent tool loop. `executeLLMWithTools` never
 * checked `context.abortSignal`, so `engine.cancel()` and the per-node
 * timeout could only take effect BETWEEN nodes — a single agent node kept
 * issuing LLM calls, running tools, and mutating shared state until it
 * finished naturally, even after the run was already CANCELLED/timed out.
 *
 * These drive `executeLLMWithTools` directly with a fake llmHelper /
 * executeToolCall and assert the loop actually stops once the signal is
 * aborted — before the next LLM call, and before running the rest of a
 * batch of queued tool calls, rather than only between nodes.
 *
 * Run directly: `node server/tests/agent-tool-loop-abort.test.js`.
 */

import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const model = { id: 'test-model', provider: 'openai', maxOutputTokens: 4096 };

async function run() {
  console.log('\n🧪 an already-aborted signal stops the loop before the first LLM call\n');
  {
    let llmCalls = 0;
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => {
        llmCalls += 1;
        return { content: 'should not happen', toolCalls: [], finishReason: 'stop' };
      }
    };
    const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
    const controller = new AbortController();
    controller.abort();
    const context = {
      language: 'en',
      _agentProfile: { budgets: {} },
      _workflowState: { executionId: 'e1', data: {} },
      abortSignal: controller.signal
    };

    let caught = null;
    try {
      await executor.executeLLMWithTools({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        config: { maxIterations: 8 },
        context,
        nodeId: 'n1'
      });
    } catch (err) {
      caught = err;
    }

    check('throws an error', caught !== null);
    check('error is tagged ABORTED', caught?.code === 'ABORTED', caught?.message);
    check('never called the LLM', llmCalls === 0, `llmCalls=${llmCalls}`);
  }

  console.log(
    '\n🧪 cancellation mid-batch stops before running the rest of the queued tool calls\n'
  );
  {
    const toolCallExecutions = [];
    const controller = new AbortController();
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => ({
        content: '',
        toolCalls: [
          { id: 'c0', index: 0, function: { name: 'toolA', arguments: '{}' } },
          { id: 'c1', index: 1, function: { name: 'toolA', arguments: '{}' } },
          { id: 'c2', index: 2, function: { name: 'toolA', arguments: '{}' } }
        ],
        usage: { input_tokens: 5, output_tokens: 5 },
        finishReason: 'tool_calls'
      })
    };
    const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
    executor.executeToolCall = async toolCall => {
      toolCallExecutions.push(toolCall.id);
      // Simulate the run being cancelled while this batch is mid-flight —
      // e.g. engine.cancel() firing right after the first queued call starts.
      if (toolCallExecutions.length === 1) controller.abort();
      return { role: 'tool', tool_call_id: toolCall.id, name: 'toolA', content: '{}' };
    };
    const context = {
      language: 'en',
      _agentProfile: { budgets: {} },
      _workflowState: { executionId: 'e2', data: {} },
      abortSignal: controller.signal
    };
    const tools = [{ id: 'toolA', name: 'toolA', parameters: { type: 'object', properties: {} } }];

    let caught = null;
    try {
      await executor.executeLLMWithTools({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        tools,
        config: { maxIterations: 8 },
        context,
        nodeId: 'n2'
      });
    } catch (err) {
      caught = err;
    }

    check('throws an error', caught !== null);
    check('error is tagged ABORTED', caught?.code === 'ABORTED', caught?.message);
    check(
      'stopped after the in-flight call, never ran the rest of the batch',
      toolCallExecutions.length === 1,
      JSON.stringify(toolCallExecutions)
    );
  }

  console.log('\n🧪 cancellation between iterations stops before the next LLM call\n');
  {
    let llmCalls = 0;
    const controller = new AbortController();
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => {
        llmCalls += 1;
        return {
          content: '',
          toolCalls: [
            { id: `c${llmCalls}`, index: 0, function: { name: 'toolA', arguments: '{}' } }
          ],
          usage: { input_tokens: 5, output_tokens: 5 },
          finishReason: 'tool_calls'
        };
      }
    };
    const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
    executor.executeToolCall = async toolCall => {
      // Cancel after the first round's tool call completes, simulating
      // engine.cancel() landing between iterations rather than mid-batch.
      controller.abort();
      return { role: 'tool', tool_call_id: toolCall.id, name: 'toolA', content: '{}' };
    };
    const context = {
      language: 'en',
      _agentProfile: { budgets: {} },
      _workflowState: { executionId: 'e3', data: {} },
      abortSignal: controller.signal
    };
    const tools = [{ id: 'toolA', name: 'toolA', parameters: { type: 'object', properties: {} } }];

    let caught = null;
    try {
      await executor.executeLLMWithTools({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        tools,
        config: { maxIterations: 8 },
        context,
        nodeId: 'n3'
      });
    } catch (err) {
      caught = err;
    }

    check('throws an error', caught !== null);
    check('error is tagged ABORTED', caught?.code === 'ABORTED', caught?.message);
    check('stopped after exactly one LLM round', llmCalls === 1, `llmCalls=${llmCalls}`);
  }

  console.log('\n🧪 no abort signal at all → loop runs normally to completion\n');
  {
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => ({
        content: 'final answer',
        toolCalls: [],
        usage: { input_tokens: 5, output_tokens: 5 },
        finishReason: 'stop'
      })
    };
    const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
    const context = {
      language: 'en',
      _agentProfile: { budgets: {} },
      _workflowState: { executionId: 'e4', data: {} }
      // no abortSignal — matches nodes executed outside WorkflowEngine's
      // _executeWithTimeout wiring (context.abortSignal is optional).
    };

    const res = await executor.executeLLMWithTools({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      config: { maxIterations: 8 },
      context,
      nodeId: 'n4'
    });

    check('completes normally without an abort signal', res.content === 'final answer');
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

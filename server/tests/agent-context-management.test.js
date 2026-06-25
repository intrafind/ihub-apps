#!/usr/bin/env node

/**
 * Unit tests for context management:
 *   - ContextSummarizer.isContextOverflowError / thresholdForModel /
 *     microcompactMessages (pure helpers — Claude Code microcompact analog)
 *   - reactive recovery in PromptNodeExecutor.executeLLMWithTools: on a
 *     context-overflow error the loop microcompacts the in-flight messages and
 *     retries instead of failing.
 *
 * Run directly: `node server/tests/agent-context-management.test.js`.
 */

import { ContextSummarizer } from '../services/workflow/ContextSummarizer.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function run() {
  const cs = new ContextSummarizer();

  console.log('🧪 isContextOverflowError\n');
  check('detects HTTP 413', ContextSummarizer.isContextOverflowError({ status: 413 }));
  check(
    'detects context_length_exceeded message',
    ContextSummarizer.isContextOverflowError({
      status: 400,
      message: 'This model maximum context length is 8192 tokens'
    })
  );
  check(
    'detects "prompt is too long"',
    ContextSummarizer.isContextOverflowError({ message: 'prompt is too long' })
  );
  check(
    'ignores unrelated 500 errors',
    !ContextSummarizer.isContextOverflowError({ status: 500, message: 'internal error' })
  );
  check('ignores empty error', !ContextSummarizer.isContextOverflowError(null));

  console.log('\n🧪 thresholdForModel\n');
  check('uses ~65% of a known window', cs.thresholdForModel({ tokens: 100000 }) === 65000);
  check('falls back to default when unknown', cs.thresholdForModel({}) === cs.thresholdTokens);

  console.log('\n🧪 microcompactMessages\n');
  {
    const big = 'x'.repeat(3000);
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
      { role: 'tool', tool_call_id: 't1', content: big }, // old + bulky → collapse
      { role: 'assistant', content: 'a' },
      { role: 'tool', tool_call_id: 't2', content: 'recent' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' }
    ];
    const res = cs.microcompactMessages(messages, { keepRecent: 4 });
    check('frees chars from the bulky old tool result', res.freedChars >= 3000);
    check('collapses exactly one message', res.collapsed === 1);
    check('never touches system/user prompts', res.messages[0].content === 'sys' && res.messages[1].content === 'do it');
    check('preserves the last keepRecent messages verbatim', res.messages[6].content === 'c');
    check(
      'collapsed message carries an elision marker',
      res.messages[2].content.includes('elided to save context')
    );
  }
  {
    const short = [{ role: 'tool', content: 'tiny' }];
    const res = cs.microcompactMessages(short, { keepRecent: 4 });
    check('no-op when below keepRecent', res.freedChars === 0 && res.collapsed === 0);
  }

  console.log('\n🧪 reactive recovery in executeLLMWithTools\n');
  {
    const big = 'y'.repeat(4000);
    let calls = 0;
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('maximum context length exceeded');
          err.status = 400;
          throw err;
        }
        return { content: 'recovered answer', toolCalls: [], usage: {}, finishReason: 'stop' };
      }
    };
    const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
    const context = { language: 'en', _agentProfile: { budgets: {} }, _workflowState: { data: {} } };
    const res = await executor.executeLLMWithTools({
      model: { id: 'm', provider: 'openai', maxOutputTokens: 4096 },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'tool', content: big },
        { role: 'assistant', content: 'a' },
        { role: 'tool', content: 'r' },
        { role: 'assistant', content: 'b' },
        { role: 'assistant', content: 'c' }
      ],
      tools: [],
      config: {},
      context,
      nodeId: 'n1'
    });
    check('retried after overflow (2 calls)', calls === 2, `calls=${calls}`);
    check('returned the recovered answer', res.content === 'recovered answer');
  }

  console.log('\n🧪 reactive recovery gives up when nothing can be freed\n');
  {
    let calls = 0;
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => {
        calls += 1;
        const err = new Error('context length exceeded');
        err.status = 400;
        throw err;
      }
    };
    const executor = new PromptNodeExecutor({ llmHelper, chatService: {} });
    const context = { language: 'en', _agentProfile: { budgets: {} }, _workflowState: { data: {} } };
    let threw = false;
    try {
      await executor.executeLLMWithTools({
        model: { id: 'm', provider: 'openai', maxOutputTokens: 4096 },
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'short' }
        ], // nothing bulky to compact
        tools: [],
        config: {},
        context,
        nodeId: 'n2'
      });
    } catch (e) {
      threw = e.message.includes('context length');
    }
    check('throws when no chars can be freed (no infinite loop)', threw && calls === 1, `calls=${calls}`);
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

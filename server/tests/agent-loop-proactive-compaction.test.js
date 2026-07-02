#!/usr/bin/env node

/**
 * Integration test: the agent tool-calling loop proactively compacts the
 * in-flight messages between tool rounds, so old large tool results are not
 * re-billed on every subsequent iteration (the O(N²) fix).
 *
 * Run directly: `node server/tests/agent-loop-proactive-compaction.test.js`.
 */

import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

// Spy summarizer: records each compactIfOversized call and actually compacts.
let compactCalls = 0;
const executor = new PromptNodeExecutor();
const realCompact = executor.contextSummarizer.compactIfOversized.bind(executor.contextSummarizer);
executor.contextSummarizer.compactIfOversized = (messages, opts) => {
  compactCalls += 1;
  // keepRecent: 2 ensures that by round 2 (6 messages) the first HUGE tool
  // result (index 3, cutoff = 6-2 = 4) falls outside the "recent" window and
  // gets collapsed, so the turn-3 prompt never re-sends both 20k bodies.
  return realCompact(messages, { ...opts, thresholdTokens: 1000, keepRecent: 2 });
};

// Stub tool execution → returns a huge result body each call.
const HUGE = 'y'.repeat(20000);
executor.executeToolCall = async () => ({ role: 'tool', content: HUGE });

// Fake LLM helper: two rounds of tool calls, then a tool-less final answer.
let turn = 0;
let maxPromptChars = 0;
executor.llmHelper = {
  verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
  executeStreamingRequest: async ({ messages }) => {
    turn += 1;
    // Record the largest single prompt the model was asked to ingest.
    const promptChars = messages
      .map(m => (typeof m.content === 'string' ? m.content.length : 0))
      .reduce((a, b) => a + b, 0);
    maxPromptChars = Math.max(maxPromptChars, promptChars);
    if (turn <= 2) {
      return {
        content: '',
        toolCalls: [{ id: `c${turn}`, function: { name: 'webContentExtractor', arguments: '{}' } }],
        usage: { prompt_tokens: Math.round(promptChars / 4), completion_tokens: 10 }
      };
    }
    return {
      content: 'final answer',
      toolCalls: [],
      usage: { prompt_tokens: 100, completion_tokens: 10 }
    };
  }
};

const model = { id: 'gemini-flash-latest', provider: 'google', maxOutputTokens: 32768 };
const messages = [
  { role: 'system', content: 'You are an agent.' },
  { role: 'user', content: 'Do the task.' }
];

// Verified signature: executeLLMWithTools({ model, messages, tools, config, context, nodeId }).
// apiKey is resolved INTERNALLY via this.llmHelper.verifyApiKey (stubbed above);
// language defaults from context.language || 'en'. No apiKey/language params.
const response = await executor.executeLLMWithTools({
  model,
  messages,
  tools: [{ function: { name: 'webContentExtractor' } }],
  config: {},
  context: {},
  nodeId: 'test'
});

console.log('🧪 proactive compaction in the agent loop\n');
check('loop ran to a final answer', response.content === 'final answer');
check('compactIfOversized called each tool round', compactCalls >= 2, `calls=${compactCalls}`);
check(
  'largest prompt stayed bounded (no full re-send of both 20k results)',
  maxPromptChars < 40000,
  `maxPromptChars=${maxPromptChars}`
);

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);

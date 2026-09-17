#!/usr/bin/env node

/**
 * Regression: proactive context compaction in the agent tool loop.
 *
 * A tool-heavy step on a large-window model re-sent every accumulated tool
 * result body on each iteration (O(N²) prompt growth: 481K input tokens for
 * one verification in wf-exec-f33f80fc). The loop now compacts old tool
 * bodies once the transcript crosses a threshold. This test pins the
 * PromptNodeExecutor → AgentLoop wiring: node config thresholds
 * (`compactThresholdTokens`, `compactKeepRecent`) reach the loop, compaction
 * fires, and the largest prompt the model sees stays bounded.
 *
 * Run directly: `node server/tests/agent-loop-proactive-compaction.test.js`.
 */

import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';
import { AgentLoop } from '../services/loop/AgentLoop.js';
import { fakeLlmClient } from './helpers/fakeLlmClient.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// Fake LLM client: two rounds of tool calls, then a tool-less final answer.
let turn = 0;
let maxPromptChars = 0;
const llmClient = fakeLlmClient(async ({ messages }) => {
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
      usage: { promptTokens: Math.round(promptChars / 4), completionTokens: 10 }
    };
  }
  return {
    content: 'final answer',
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 10 }
  };
});

// Observe compaction through a seam on an injected loop.
const compactions = [];
const agentLoop = new AgentLoop({ llmClient, logger: silentLogger }).use({
  name: 'compaction-spy',
  onCompaction: (ctx, info) => compactions.push(info.trigger)
});

const executor = new PromptNodeExecutor({
  llmClient,
  agentLoop,
  chatService: {},
  logger: silentLogger
});

// Stub tool execution → returns a huge result body each call.
const HUGE = 'y'.repeat(20000);
executor.executeToolCall = async toolCall => ({
  role: 'tool',
  tool_call_id: toolCall.id,
  name: toolCall.function.name,
  content: HUGE
});

const model = { id: 'gemini-flash-latest', provider: 'google', maxOutputTokens: 32768 };
const messages = [
  { role: 'system', content: 'You are an agent.' },
  { role: 'user', content: 'Do the task.' }
];

const response = await executor.executeLLMWithTools({
  model,
  messages,
  tools: [
    {
      id: 'webContentExtractor',
      name: 'webContentExtractor',
      parameters: { type: 'object', properties: {} }
    }
  ],
  // keepRecent: 2 ensures that by round 2 (6 messages) the first HUGE tool
  // result (index 3, cutoff = 6-2 = 4) falls outside the "recent" window and
  // gets collapsed, so the turn-3 prompt never re-sends both 20k bodies.
  config: { compactThresholdTokens: 1000, compactKeepRecent: 2 },
  context: {},
  nodeId: 'test'
});

console.log('🧪 proactive compaction in the agent loop\n');
check('loop ran to a final answer', response.content === 'final answer');
check(
  'node config thresholds reached the loop (proactive compaction fired)',
  compactions.includes('proactive'),
  `compactions=${JSON.stringify(compactions)}`
);
check(
  'largest prompt stayed bounded (no full re-send of both 20k results)',
  maxPromptChars < 40000,
  `maxPromptChars=${maxPromptChars}`
);
check('three model turns', turn === 3, `turn=${turn}`);

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);

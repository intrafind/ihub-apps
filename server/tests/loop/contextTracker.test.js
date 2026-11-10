// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The server counts how full the model's context window is. A turn that reads
 * pages fills it with tool results the client never holds, so the figure has
 * to come from the server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContextTracker,
  estimateTranscriptTokens
} from '../../services/loop/contextTracker.js';
import { parseSseV2EventData } from '../../services/loop/contracts/sseV2.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { chatTurnSeam } from '../../services/chat/chatSeams.js';

const model = { id: 'm', contextWindow: 100_000, maxOutputTokens: 4_000 };
const page = 'A long page that a research read pulled in. '.repeat(400);

test('a model without a context window reports nothing', () => {
  const tracker = createContextTracker({ id: 'x' });
  assert.equal(tracker.estimate([{ role: 'user', content: 'hi' }]), null);
  assert.equal(tracker.recordStep({ promptTokens: 10, completionTokens: 2 }, 1), null);
});

test('before the first call the whole transcript is estimated', () => {
  const tracker = createContextTracker(model);
  const state = tracker.estimate([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' }
  ]);
  assert.equal(state.source, 'estimate');
  assert.equal(state.contextWindow, 100_000);
  assert.equal(state.maxOutputTokens, 4_000);
  assert.ok(state.inputTokens > 0);
});

test('the provider count anchors the figure and includes the reply', () => {
  const tracker = createContextTracker(model);
  const state = tracker.recordStep(
    { promptTokens: 1_200, completionTokens: 80, source: 'provider' },
    2
  );
  assert.deepEqual(
    { source: state.source, inputTokens: state.inputTokens },
    { source: 'provider', inputTokens: 1_280 }
  );
});

test('pages the model read raise the figure before the next model call', () => {
  const tracker = createContextTracker(model);
  const prompt = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'research this' }
  ];
  tracker.recordStep(
    { promptTokens: 1_000, completionTokens: 50, source: 'provider' },
    prompt.length
  );
  const afterReading = [
    ...prompt,
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'fetch_page', arguments: '{"url":"x"}' } }]
    },
    { role: 'tool', tool_call_id: 'c1', name: 'fetch_page', content: page }
  ];
  const state = tracker.estimate(afterReading);
  assert.equal(state.source, 'provider');
  assert.ok(state.inputTokens >= 1_000 + estimateTranscriptTokens([afterReading[3]]));
  assert.ok(state.inputTokens > 1_000 + 1_000, 'the page is counted');
});

test('an estimated usage does not replace the anchor', () => {
  const tracker = createContextTracker(model);
  tracker.recordStep({ promptTokens: 500, completionTokens: 5, source: 'provider' }, 1);
  const kept = tracker.recordStep(
    { promptTokens: 9_999, completionTokens: 1, source: 'estimate' },
    3
  );
  assert.equal(kept.inputTokens, 505);
});

test('context/usage is a valid event and run/ended carries the state', () => {
  const data = {
    contextWindow: 100_000,
    inputTokens: 5_000,
    maxOutputTokens: 4_000,
    source: 'provider'
  };
  assert.equal(parseSseV2EventData(SSE_V2_EVENTS.CONTEXT_USAGE, data).inputTokens, 5_000);
  const ended = parseSseV2EventData(SSE_V2_EVENTS.RUN_ENDED, {
    status: 'completed',
    context: data
  });
  assert.equal(ended.context.inputTokens, 5_000);
});

test('the chat turn seam streams the state with every call and reply', async () => {
  const frames = [];
  const stream = { emit: (type, data) => frames.push({ type, data }) };
  const tracker = createContextTracker(model);
  const seam = chatTurnSeam({
    chatId: 'c',
    buildLogData: () => ({}),
    streaming: true,
    telemetry: { recordChatCallStart: async () => {}, recordChatCallEnd: async () => {} },
    contextTracker: tracker
  });
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' }
  ];
  const ctx = {
    iteration: 1,
    model,
    messages,
    meta: { stream },
    knowledgeSources: new Set(),
    addKnowledgeSource() {}
  };
  await seam.preStep(ctx);
  await seam.stepEnd(ctx, {
    result: {
      content: 'done',
      usage: { promptTokens: 900, completionTokens: 20, source: 'provider' }
    },
    toolCalls: []
  });
  const usage = frames.filter(f => f.type === SSE_V2_EVENTS.CONTEXT_USAGE);
  assert.equal(usage.length, 2);
  assert.equal(usage[0].data.source, 'estimate');
  assert.deepEqual(
    { inputTokens: usage[1].data.inputTokens, source: usage[1].data.source },
    { inputTokens: 920, source: 'provider' }
  );
});

test('reasoning tokens are not counted in the reply that joins the context', () => {
  const tracker = createContextTracker(model);
  const state = tracker.recordStep(
    { promptTokens: 1_000, completionTokens: 9_000, reasoningTokens: 8_000, source: 'provider' },
    2
  );
  assert.equal(state.inputTokens, 2_000);
});

test('replay is what the next turn sends: the first prompt and the answer, no tool results', () => {
  const tracker = createContextTracker(model);
  const prompt = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'research this' }
  ];
  tracker.recordStep({ promptTokens: 1_000, completionTokens: 50, source: 'provider' }, 2);
  // a second call, after three long pages were read
  const second = tracker.recordStep(
    { promptTokens: 61_000, completionTokens: 300, source: 'provider' },
    7
  );
  assert.equal(second.inputTokens, 61_300, 'the live figure holds the pages');
  const answer = 'The short answer. '.repeat(20);
  const replay = tracker.replay(answer);
  assert.equal(replay.source, 'provider');
  assert.equal(replay.contextWindow, 100_000);
  assert.equal(replay.inputTokens, 1_000 + estimateTranscriptTokens([{ content: answer }]));
  assert.ok(replay.inputTokens < 2_000, 'the pages are not replayed');
  assert.ok(prompt.length === 2);
});

test('without provider usage replay estimates the starting prompt', () => {
  const tracker = createContextTracker(model);
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' }
  ];
  tracker.estimate(messages);
  tracker.estimate([...messages, { role: 'tool', content: page }]);
  const replay = tracker.replay('ok');
  assert.equal(replay.source, 'estimate');
  assert.ok(replay.inputTokens < estimateTranscriptTokens([{ content: page }]));
  assert.equal(createContextTracker(model).replay('x'), null);
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A chat turn's compaction (#3819) as the chat surface sends and stores it:
 * the live `context/compacted` frames and the context figure that drops with
 * them (chat seam), and the row kept with the stored answer and with a share.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatTurnSeam } from '../services/chat/chatSeams.js';
import { createContextTracker } from '../services/loop/contextTracker.js';
import { boundStoredActivity, shareableActivity } from '../services/chat/runActivity.js';
import { pausedTurnTranscript } from '../services/chat/chatToolApproval.js';
import { parseSseV2EventData } from '../services/loop/contracts/sseV2.js';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';
import { createStreamState, reduceRunEvents, getRun } from '../../shared/run/runReducer.js';
import { buildRunActivity } from '../../shared/run/runActivity.js';

const telemetry = { recordChatCallStart: async () => {}, recordChatCallEnd: async () => {} };

function seamWith(tracker) {
  const frames = [];
  const stream = { emit: (type, data) => frames.push({ type, data }) };
  const seam = chatTurnSeam({
    chatId: 'chat-1',
    buildLogData: () => ({}),
    streaming: true,
    telemetry,
    contextTracker: tracker
  });
  const ctx = { iteration: 3, meta: { stream }, messages: [{ role: 'user', content: 'q' }] };
  return { seam, ctx, frames };
}

test('the chat says a digest is being written, then what it did, and the context figure drops with it', () => {
  const tracker = createContextTracker({ id: 'm', contextWindow: 173_184 });
  tracker.recordStep({ promptTokens: 102_934, completionTokens: 100, source: 'provider' }, 1);
  const { seam, ctx, frames } = seamWith(tracker);
  const info = {
    compactionId: 'cmp-1',
    step: 6,
    trigger: 'proactive',
    strategy: 'digest',
    tokensBefore: 102_934,
    itemsSummarised: 9,
    kinds: { search: 9, fetch: 0, tool: 0 }
  };
  seam.onCompactionStart(ctx, info);
  seam.onCompaction(ctx, {
    ...info,
    lossy: false,
    tokensAfter: 37_905,
    freedTokens: 65_029,
    digest: 'x'.repeat(9000),
    facts: 40
  });
  assert.deepEqual(
    frames.map(f => [f.type, f.data.status]),
    [
      [SSE_V2_EVENTS.CONTEXT_COMPACTED, 'running'],
      [SSE_V2_EVENTS.CONTEXT_COMPACTED, 'completed'],
      [SSE_V2_EVENTS.CONTEXT_USAGE, undefined]
    ]
  );
  for (const frame of frames) parseSseV2EventData(frame.type, frame.data);
  const completed = frames[1].data;
  assert.equal(completed.digestTruncated, true, 'the frame bounds the notes');
  assert.ok(completed.digest.length <= 8001);
  assert.equal(completed.tokensAfter, 37_905);
  assert.equal(frames[2].data.inputTokens, 102_934 - 65_029, 'rebased on the provider count');
});

test('the stored answer keeps the row and its notes; a share keeps that it happened, not what it found', () => {
  const ts = seq => `2026-11-18T10:00:${String(seq).padStart(2, '0')}.000Z`;
  const env = (seq, type, data) => ({ v: 2, seq, runId: 'run-1', ts: ts(seq), type, data });
  const run = getRun(
    reduceRunEvents(createStreamState('chat-1'), [
      env(1, 'run/started', { kind: 'chat', refs: {} }),
      env(2, 'tool/started', {
        step: 1,
        callId: 'c1',
        toolId: 'braveSearch',
        name: 'braveSearch',
        activityKind: 'search',
        activityOrigin: 'web',
        args: { query: 'nvidia' },
        execution: 'server'
      }),
      env(3, 'tool/completed', {
        step: 1,
        callId: 'c1',
        toolId: 'braveSearch',
        name: 'braveSearch'
      }),
      env(4, 'context/compacted', {
        compactionId: 'cmp-1',
        step: 2,
        status: 'completed',
        trigger: 'proactive',
        strategy: 'digest',
        lossy: false,
        itemsSummarised: 9,
        kinds: { search: 9, fetch: 0, tool: 0 },
        tokensBefore: 102_934,
        tokensAfter: 37_905,
        digest: '<condensed_results>NVIDIA 5.1T</condensed_results>',
        facts: 12
      }),
      env(5, 'run/ended', { status: 'completed', finishReason: 'stop' })
    ]),
    'run-1'
  );
  const stored = boundStoredActivity(buildRunActivity(run));
  const row = stored.toolActivity.items.find(item => item.kind === 'compaction');
  assert.deepEqual(
    {
      id: row.id,
      status: row.status,
      strategy: row.strategy,
      itemsSummarised: row.itemsSummarised,
      kinds: row.kinds,
      tokensBefore: row.tokensBefore,
      tokensAfter: row.tokensAfter,
      facts: row.facts,
      digest: row.digest
    },
    {
      id: 'compaction-cmp-1',
      status: 'completed',
      strategy: 'digest',
      itemsSummarised: 9,
      kinds: { search: 9, fetch: 0, tool: 0 },
      tokensBefore: 102_934,
      tokensAfter: 37_905,
      facts: 12,
      digest: '<condensed_results>NVIDIA 5.1T</condensed_results>'
    }
  );
  const shared = shareableActivity(stored).toolActivity.items.find(i => i.kind === 'compaction');
  assert.equal(shared.digest, undefined, 'the notes hold what the calls found');
  assert.equal(shared.itemsSummarised, 9);
  assert.equal(shared.strategy, 'digest');
});

test('a paused turn keeps its digest whole; other long results are still cut', () => {
  const digest = `[condensed result r1 of webSearch: …]\n<condensed_results digest="1" refs="r1">\n${'- [r1] fact\n'.repeat(1800)}</condensed_results>`;
  const call = { id: 'c2', type: 'function', function: { name: 'send', arguments: '{}' } };
  const messages = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'webSearch', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'c1', name: 'webSearch', content: digest },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: 'c2', name: 'send', content: 'x'.repeat(30_000) }
  ];
  const stored = pausedTurnTranscript(messages, { startMessage: messages[0], toolCallId: 'c2' });
  assert.ok(digest.length > 16_000);
  assert.equal(stored.find(m => m.tool_call_id === 'c1').content, digest);
  assert.match(stored.find(m => m.tool_call_id === 'c2').content, /\[truncated/);
});

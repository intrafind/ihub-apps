// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChatChannel } from '../services/chat/chatChannel.js';

describe('chat channel — tool calls still being written', () => {
  it('announces a call once, as soon as its name streams in', () => {
    const frames = [];
    const channel = createChatChannel({
      chatId: 'chat-1',
      stream: { emit: (type, data) => frames.push({ type, data }) }
    });
    const ctx = {
      iteration: 2,
      tools: [{ id: 'create_web_artifact', name: 'Create interactive web artifact' }]
    };
    const chunk = tool_calls => ({ content: [], thinking: [], tool_calls });
    // vLLM: id and name first, then argument fragments under the same index.
    channel.onChunk(
      chunk([{ index: 0, id: 'call-1', function: { name: 'create_web_artifact', arguments: '' } }]),
      ctx
    );
    channel.onChunk(chunk([{ index: 0, function: { arguments: '{"content":"<html' } }]), ctx);
    channel.onChunk(chunk([{ index: 1, id: 'call-2', function: { name: 'unknown' } }]), ctx);

    const preparing = frames.filter(f => f.data.phase === 'tool.preparing');
    assert.equal(preparing.length, 1);
    assert.deepEqual(preparing[0], {
      type: 'tool/progress',
      data: {
        step: 2,
        callId: 'call-1',
        phase: 'tool.preparing',
        data: {
          toolId: 'create_web_artifact',
          name: 'create_web_artifact',
          title: 'Create interactive web artifact',
          activityKind: 'tool',
          chars: 0
        }
      }
    });

    // The same index in the next step is a new call.
    channel.onChunk(
      chunk([{ index: 0, id: 'call-3', function: { name: 'create_web_artifact' } }]),
      { ...ctx, iteration: 3 }
    );
    assert.equal(frames.filter(f => f.data.phase === 'tool.preparing').length, 2);
  });
});

describe('chat channel — progress of a call being written', () => {
  it('repeats the frame at most once a second with the characters written', t => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const frames = [];
    const channel = createChatChannel({
      chatId: 'chat-1',
      stream: { emit: (type, data) => frames.push(data) }
    });
    const ctx = { iteration: 1, tools: [{ id: 'create_web_artifact' }] };
    const send = args =>
      channel.onChunk(
        {
          content: [],
          thinking: [],
          tool_calls: [
            { index: 0, id: 'c', function: { name: 'create_web_artifact', arguments: args } }
          ]
        },
        ctx
      );
    send('');
    send('x'.repeat(100));
    t.mock.timers.tick(1000);
    send('y'.repeat(50));
    assert.deepEqual(
      frames.map(f => f.data.chars),
      [0, 150]
    );
  });
});

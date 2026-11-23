// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The order in which a finished turn becomes visible.
 *
 * A client reopening a durable chat asks the chat document whether a turn is
 * running and, if it is, replays that run's ledger to catch up. The two are
 * written by different calls, so whatever a reader sees between them is a real
 * state it can be served — and one of the two orders is unusable.
 *
 * Releasing the document first is safe: a chat that is not `running` is never
 * reattached to, so a ledger that has not yet ended is never asked for.
 * Materializing first is not: `materializeAssistantTurn` takes the chat lock
 * once to append the answer and again to release the run, and in between the
 * document still says `running` while the ledger holds no terminal frame. A
 * client reopening inside that window attaches to a run that is already over,
 * nothing further ever arrives, and the placeholder spins with the composer
 * behind a Stop button until the user presses it.
 *
 * The client's own stream is told the turn is over (`run/ended`) only once the
 * answer is stored: a client that has seen the end re-reads the stored chat,
 * and one told earlier can read it before the append and lose the answer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import ChatService from '../services/chat/ChatService.js';
import { activeRequests } from '../sse.js';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';

/** The minimum `prep` `runTurn` reads before it calls the loop. */
const PREP = {
  app: { id: 'test-app' },
  model: { id: 'test-model' },
  llmMessages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxTokens: 100,
  llmOptions: {}
};

/**
 * Drive one persisted turn and record the order of the two writes that settle
 * it.
 *
 * @param {Object} [options]
 * @param {boolean} [options.crash] - Make the loop throw, to drive the bug path.
 * @param {boolean} [options.modelError] - Make the loop end with a model error.
 * @returns {Promise<string[]>} The writes, in the order they happened.
 */
async function settleOrder({ crash = false, modelError = false } = {}) {
  const order = [];
  const service = new ChatService({
    agentLoop: {
      run: async () => {
        if (crash) throw new Error('the loop blew up');
        if (modelError) {
          return {
            status: 'error',
            content: '',
            finishReason: 'error',
            error: { code: 'MODEL_ERROR', message: 'Invalid request sent to local API' },
            messages: [],
            usage: null
          };
        }
        return { status: 'ok', content: 'done', finishReason: 'stop', messages: [], usage: null };
      }
    },
    runLog: {
      startRun: async () => {},
      append: () => {},
      endRun: async () => {
        order.push('ledger-ended');
      }
    },
    logInteraction: () => {},
    telemetry: { recordTurn: () => {}, recordError: () => {}, recordChatCallEnd: () => {} }
  });

  // `materializeAssistantTurn` reaches the repository; recording `releaseRun`
  // is enough to place the document write against the ledger write.
  const repository = {
    isAvailable: () => true,
    ensureChat: async () => ({ id: 'chat-settle-order' }),
    appendMessage: async () => {
      order.push('answer-appended');
      return { message: { id: 'm1' } };
    },
    releaseRun: async () => {
      order.push('run-released');
      return { chat: { id: 'chat-settle-order' } };
    }
  };

  // The client's stream: where `run/ended` falls against the writes.
  const emitter = {
    runId: null,
    emit: type => {
      if (type === SSE_V2_EVENTS.RUN_ENDED) order.push('run-ended-sent');
      if (type === SSE_V2_EVENTS.STREAM_ERROR) order.push('stream-error-sent');
      return null;
    }
  };

  let variant = 'normal';
  if (crash) variant = 'crash';
  else if (modelError) variant = 'error';
  const chatId = `chat-settle-order-${variant}`;
  try {
    await service.runTurn({
      prep: PREP,
      chatId,
      emitter,
      streaming: false,
      user: { id: 'user-1', permissions: {} },
      persistence: { repository, ownerId: 'user-1', content: 'hi' }
    });
  } catch {
    // The crash path rethrows; the order is what this is about.
  } finally {
    activeRequests.delete(chatId);
  }
  return order;
}

describe('a finished durable turn ends its ledger before it releases its chat', () => {
  it('writes the terminal frame first on the ordinary path', async () => {
    const order = await settleOrder();

    assert.ok(order.includes('ledger-ended'), 'the ledger run was ended');
    assert.ok(order.includes('run-released'), 'the chat was released');
    assert.ok(
      order.indexOf('ledger-ended') < order.indexOf('run-released'),
      'a reopen inside the materialize window must find a terminal frame to replay'
    );
  });

  it('and on the crash path, which is the one that strands a chat', async () => {
    const order = await settleOrder({ crash: true });

    assert.ok(order.includes('ledger-ended'));
    assert.ok(order.includes('run-released'));
    assert.ok(order.indexOf('ledger-ended') < order.indexOf('run-released'));
  });
});

describe('a finished durable turn stores its answer before it tells the client it ended', () => {
  it('sends run/ended after the answer is appended and the chat released', async () => {
    const order = await settleOrder();

    assert.equal(order.filter(entry => entry === 'run-ended-sent').length, 1, order.join(', '));
    assert.ok(
      order.indexOf('answer-appended') < order.indexOf('run-ended-sent'),
      `a client re-reading the chat on run/ended must find the answer: ${order.join(', ')}`
    );
    assert.ok(order.indexOf('run-released') < order.indexOf('run-ended-sent'), order.join(', '));
  });

  it('and on the crash path, after the chat is released', async () => {
    const order = await settleOrder({ crash: true });

    assert.equal(order.filter(entry => entry === 'run-ended-sent').length, 1, order.join(', '));
    assert.ok(order.indexOf('run-released') < order.indexOf('run-ended-sent'), order.join(', '));
  });

  it('holds stream/error back with run/ended: the client stops reading at either', async () => {
    const order = await settleOrder({ modelError: true });

    assert.equal(order.filter(entry => entry === 'stream-error-sent').length, 1, order.join(', '));
    assert.equal(order.filter(entry => entry === 'run-ended-sent').length, 1, order.join(', '));
    assert.ok(order.indexOf('run-released') < order.indexOf('stream-error-sent'), order.join(', '));
    assert.ok(
      order.indexOf('stream-error-sent') < order.indexOf('run-ended-sent'),
      `run/ended must follow stream/error, or a client that stopped at the error misses it: ${order.join(', ')}`
    );
  });

  it('and on the crash path, stream/error first, both after the chat is released', async () => {
    const order = await settleOrder({ crash: true });

    assert.ok(order.indexOf('run-released') < order.indexOf('stream-error-sent'), order.join(', '));
    assert.ok(
      order.indexOf('stream-error-sent') < order.indexOf('run-ended-sent'),
      order.join(', ')
    );
  });
});

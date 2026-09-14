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
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import ChatService from '../services/chat/ChatService.js';
import { activeRequests } from '../sse.js';

/** The minimum `prep` `runTurn` reads before it calls the loop. */
const PREP = {
  app: { id: 'test-app' },
  model: { id: 'test-model' },
  llmMessages: [{ role: 'user', content: 'hi' }],
  tools: [],
  temperature: 0.5,
  maxTokens: 100,
  llmOptions: {}
};

/**
 * Drive one persisted turn and record the order of the two writes that settle
 * it.
 *
 * @param {Object} [options]
 * @param {boolean} [options.crash] - Make the loop throw, to drive the bug path.
 * @returns {Promise<string[]>} The writes, in the order they happened.
 */
async function settleOrder({ crash = false } = {}) {
  const order = [];
  const service = new ChatService({
    agentLoop: {
      run: async () => {
        if (crash) throw new Error('the loop blew up');
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
    telemetry: { recordTurn: () => {}, recordError: () => {} }
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

  const chatId = `chat-settle-order-${crash ? 'crash' : 'normal'}`;
  try {
    await service.runTurn({
      prep: PREP,
      chatId,
      streaming: false,
      user: { id: 'user-1' },
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

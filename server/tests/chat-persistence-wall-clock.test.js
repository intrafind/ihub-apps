/**
 * A durable turn has to end by itself, because nothing else will end it.
 *
 * An interactive chat turn carries an implicit deadline: the browser goes away
 * and the disconnect aborts it. Durability removes exactly that — the whole
 * point is that closing the tab no longer kills the answer — and with it the
 * only thing that ever ended a turn whose tool never returns. What is left
 * running holds the chat's request entry, its cluster-wide durable mark and
 * the provider connection for the life of the process, and the chat document
 * stays `running` forever, so every reopen replays a dead run and spins on an
 * empty placeholder. There is no client left to press Stop.
 *
 * `invokeAppInternal`, the other path that runs with no client, has carried a
 * `maxWallClockMs` for this reason all along. These tests pin that the chat
 * path now does too — and only for turns that can outlive their client, since
 * a user watching a long tool chain must not have it cut short by a ceiling
 * that exists for absent clients.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import ChatService, {
  CHAT_MAX_TOOL_ROUNDS,
  DURABLE_TURN_WALL_CLOCK_MS
} from '../services/chat/ChatService.js';
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
 * A service whose loop records what it was asked to run and answers at once.
 *
 * @returns {{service: ChatService, budgets: () => Object|null}}
 */
function recordingService() {
  let seen = null;
  const service = new ChatService({
    agentLoop: {
      run: async request => {
        seen = request.policies?.budgets ?? null;
        return {
          status: 'ok',
          content: 'done',
          finishReason: 'stop',
          messages: [],
          usage: null
        };
      }
    },
    runLog: { startRun: async () => {}, append: () => {}, endRun: async () => {} },
    logInteraction: () => {},
    telemetry: { recordTurn: () => {}, recordError: () => {} }
  });
  return { service, budgets: () => seen };
}

/**
 * Drive one turn and hand back the budgets the loop was given.
 *
 * @param {Object|null} persistence - durable context, or null for an ordinary turn
 * @returns {Promise<Object|null>}
 */
async function budgetsFor(persistence) {
  const { service, budgets } = recordingService();
  const chatId = `wall-clock-${persistence ? 'durable' : 'ephemeral'}`;
  try {
    await service.runTurn({
      prep: PREP,
      chatId,
      streaming: false,
      user: { id: 'user-1' },
      persistence
    });
  } finally {
    activeRequests.delete(chatId);
  }
  return budgets();
}

describe('durable chat turns are bounded by wall clock', () => {
  it('gives a persisted turn a deadline', async () => {
    // `repository` is what marks a turn durable; a bare object is enough,
    // because materialization treats a repository it cannot use as a storage
    // failure and logs rather than throwing.
    const budgets = await budgetsFor({
      repository: { ensureChat: async () => null },
      ownerId: 'user-1',
      content: 'hi'
    });

    assert.equal(
      budgets?.maxWallClockMs,
      DURABLE_TURN_WALL_CLOCK_MS,
      'a turn that outlives its client must carry its own deadline — nothing else ends it'
    );
    assert.equal(budgets?.maxToolRounds, CHAT_MAX_TOOL_ROUNDS, 'and keeps the round budget');
  });

  it('leaves an interactive turn to its client', async () => {
    const budgets = await budgetsFor(null);

    assert.equal(
      budgets?.maxWallClockMs,
      undefined,
      'an interactive turn is bounded by the browser holding it; a ceiling here would ' +
        'cut short a long tool chain the user is watching'
    );
    assert.equal(budgets?.maxToolRounds, CHAT_MAX_TOOL_ROUNDS);
  });
});

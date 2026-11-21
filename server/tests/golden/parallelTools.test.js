// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Two tool calls of one step that run side by side give the same record
 * whichever of them finishes first.
 *
 * The run is real: a chat turn through `ChatService` and the product's
 * `AgentLoop`, with a model that asks for two tools in one answer. A chat turn
 * runs its tools one at a time (`ChatService` sets `tools.parallel: false`),
 * so the test lifts that one policy on the way into the loop. The surfaces that
 * run tools side by side (a workflow prompt node with `parallelToolCalls`, a
 * loop on the default policy) go through the same loop and the same emitter.
 *
 * No timer decides the order: the tool that has to finish last waits until the
 * `tool/completed` envelope of the other call was emitted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparable } from './assertGolden.js';
import { defineCase, recordCase } from './harness.js';
import { harnessConfig, runChatTurn } from './harnessCases.js';
import { canonicalJson } from './normalise.js';
import { observeEmittedEnvelopes } from '../../services/loop/RunStream.js';
import { turn } from '../helpers/scriptedModel.js';

const CALLS = [
  { id: 'call_1', key: 'A-1' },
  { id: 'call_2', key: 'B-2' }
];

/**
 * The chat turn with two `lookup` calls in one step, the call for `lastKey` finishing last.
 *
 * @param {string} lastKey
 * @param {{ledger: Object[], envelopes: Object[]}} raw - Filled with what the run produced, as it arrived.
 */
function parallelCase(lastKey, raw) {
  const first = CALLS.find(call => call.key !== lastKey);
  let firstCompleted;
  const afterFirst = new Promise(resolve => {
    firstCompleted = resolve;
  });
  return defineCase({
    surface: 'harness',
    name: 'chat-turn-parallel-tools',
    title: 'Two tool calls of one step run side by side.',
    config: () => {
      const config = harnessConfig();
      config.tools = config.tools.map(tool => ({
        ...tool,
        run: async args => {
          if (args.key === lastKey) await afterFirst;
          return { key: args.key, value: `record ${args.key}` };
        }
      }));
      return config;
    },
    script: () => [
      turn.toolCalls(
        CALLS.map(call => ({ name: 'lookup', args: { key: call.key } })),
        { usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }
      ),
      turn.text(['Both records ', 'are open.'], {
        usage: { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 }
      })
    ],
    run: async env => {
      const loop = env.chatService.agentLoop;
      env.chatService.agentLoop = {
        run: request =>
          loop.run({
            ...request,
            policies: { ...request.policies, tools: { ...request.policies.tools, parallel: true } }
          })
      };
      const unobserve = observeEmittedEnvelopes(envelope => {
        if (envelope.type === 'tool/completed' && envelope.data?.callId === first.id) {
          firstCompleted();
        }
      });
      try {
        const parts = await runChatTurn(env, {
          chatId: 'golden-chat-parallel',
          message: 'Look up records A-1 and B-2.'
        });
        await env.settle();
        raw.ledger = [...env.ledger];
        raw.envelopes = env.envelopes.map(delivery => delivery.envelope);
        return parts;
      } finally {
        unobserve();
      }
    }
  });
}

const callIds = (events, type) =>
  events.filter(event => event.type === type).map(event => event.data.callId);

test('two tool calls of one step give the same record whichever finishes first', async () => {
  const rawFirst = {};
  const rawSecond = {};
  const callOneFirst = await recordCase(parallelCase('B-2', rawFirst));
  const callTwoFirst = await recordCase(parallelCase('A-1', rawSecond));

  // The two calls really ran side by side, in one group: both started before either finished.
  for (const raw of [rawFirst, rawSecond]) {
    const calls = raw.ledger.filter(event => event.type === 'tool/call');
    assert.deepEqual(
      calls.map(event => [event.data.callId, event.data.parallelGroup]),
      [
        ['call_1', 0],
        ['call_2', 0]
      ]
    );
    assert.deepEqual(
      raw.envelopes.map(envelope => envelope.type).filter(type => type.startsWith('tool/')),
      ['tool/started', 'tool/started', 'tool/completed', 'tool/completed']
    );
  }
  // And they finished in opposite orders, in the ledger and on the stream.
  assert.deepEqual(callIds(rawFirst.ledger, 'tool/result'), ['call_1', 'call_2']);
  assert.deepEqual(callIds(rawSecond.ledger, 'tool/result'), ['call_2', 'call_1']);
  assert.deepEqual(callIds(rawFirst.envelopes, 'tool/completed'), ['call_1', 'call_2']);
  assert.deepEqual(callIds(rawSecond.envelopes, 'tool/completed'), ['call_2', 'call_1']);

  assert.equal(
    canonicalJson(comparable(callTwoFirst)),
    canonicalJson(comparable(callOneFirst)),
    'the record depends on which tool finished first'
  );

  // The fixed order is the order the model asked for the calls, each call with its own events.
  const toolEvents = events =>
    events
      .filter(event => event.type.startsWith('tool/'))
      .map(event => `${event.type} ${event.data.callId}`);
  assert.deepEqual(toolEvents(callTwoFirst.ledger), [
    'tool/call call_1',
    'tool/result call_1',
    'tool/call call_2',
    'tool/result call_2'
  ]);
  assert.deepEqual(toolEvents(callTwoFirst.envelopes), [
    'tool/started call_1',
    'tool/completed call_1',
    'tool/started call_2',
    'tool/completed call_2'
  ]);
  assert.deepEqual(
    callTwoFirst.toolCalls.map(call => [call.args.key, call.outcome.result]),
    [
      ['A-1', '{"key":"A-1","value":"record A-1"}'],
      ['B-2', '{"key":"B-2","value":"record B-2"}']
    ]
  );
});

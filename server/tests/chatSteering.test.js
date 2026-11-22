// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Messages the person sends into a running chat answer, end to end on the
 * server (#3191): the stored form of a message read at a step, its evidence
 * entry, the leftover of an answer that becomes the next turn exactly once,
 * the leftover dropped in a temporary chat, and the chat read model.
 *
 * Real chat turns in the environment of the golden harness (real storage in a
 * temporary directory, the real `ChatService`, agent loop and run ledger);
 * only the model answers from a script. A message is sent while a model call
 * is under way (`onRequest` of the script), which is when a person types it.
 */
import test, { before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// The harness first: it isolates the contents directory before the server loads.
import { startGoldenEnv } from './golden/harness.js';
import { scriptedModel, turn } from './helpers/scriptedModel.js';
import { fixtureInstallation, fixtureTool } from './helpers/integrationToolFixture.js';
import { prepareTurn, principalRefOf, runPreparedTurn } from '../services/chat/chatTurnStart.js';
import { chatPendingView, splitLeftover } from '../services/chat/chatSteering.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getStreamRun } from '../services/loop/RunStream.js';
import {
  steerRun,
  pendingSteers,
  resetSteersForTests,
  STEER_MARKER
} from '../services/loop/steering.js';
import { buildEvidence } from '../services/chat/evidenceRecord.js';
import { parseSseV2EventData } from '../services/loop/contracts/sseV2.js';

const MODEL = {
  id: 'golden-model',
  provider: 'openai',
  modelId: 'gpt-golden',
  url: 'https://model.invalid/v1/chat/completions',
  autoDiscovery: false,
  supportsTools: 'auto',
  default: true
};

const DESK = {
  id: 'desk',
  name: { en: 'Desk' },
  description: { en: 'Answers questions about records' },
  system: { en: 'You answer questions about records.' },
  integrations: { lookup: {} },
  preferredModel: MODEL.id,
  enabled: true
};

const getLocalizedError = async key => `localized:${key}`;

let env;
let user;

before(async () => {
  env = await startGoldenEnv({
    features: { chatPersistence: true },
    platform: { chats: { enabled: true }, auth: {}, globalPromptVariables: { context: '' } },
    models: [MODEL],
    apps: [DESK],
    groups: {
      groups: {
        users: {
          id: 'users',
          permissions: { apps: ['desk'], models: ['*'], prompts: [], integrations: ['lookup'] }
        }
      }
    },
    tools: [
      fixtureTool('lookup', {
        description: 'Look up a record',
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
        run: args => ({ found: args.key })
      })
    ],
    integrations: () => ({
      installed: [fixtureInstallation('lookup')],
      security: { blockPrivateIps: true, allowedHosts: [] }
    })
  });
  user = env.principal({ id: 'u1', name: 'User One', groups: ['users'] });
});

after(async () => {
  await env?.stop();
});

beforeEach(() => {
  env.envelopes.length = 0;
  resetSteersForTests();
});

afterEach(async () => {
  await env.settle();
});

/** Script the model for one test; the script must be used exactly. */
function script(t, turns, options) {
  const model = scriptedModel(turns, options);
  env.model = model;
  t.after(() => model.assertDone());
  return model;
}

function turnRequest(chatId, overrides = {}) {
  return {
    chatId,
    appId: 'desk',
    principalRef: principalRefOf(user),
    messageId: 'msg-1',
    message: { role: 'user', content: 'What is the retention period?', messageId: 'msg-1' },
    clientHistory: 0,
    language: 'en',
    origin: 'person',
    ...overrides
  };
}

const settleClarifications = async () => null;

/** Prepare and run one turn as the chat route does, starting next turns from leftovers. */
async function chatTurn(chatId, { overrides = {}, leftover = true } = {}) {
  const prepared = await prepareTurn(turnRequest(chatId, overrides), {
    user,
    getLocalizedError,
    settleClarifications
  });
  assert.ok(prepared.turn, JSON.stringify(prepared.refusal));
  return runPreparedTurn(prepared.turn, {
    chatService: env.chatService,
    getLocalizedError,
    timeoutMs: 5000,
    ...(leftover ? { leftover: { settleClarifications } } : {})
  });
}

/** Send a message into the answer producing on the chat right now. */
async function sendNow(chatId, steer) {
  const runId = getStreamRun(chatId)?.runId;
  assert.ok(runId, 'an answer is producing on the chat');
  const routed = await steerRun(runId, { by: 'u1', chatId, ...steer });
  assert.equal(routed, 'queued');
  return runId;
}

/** The steer frames of a chat's stream, each checked against its schema. */
function steerFrames(chatId) {
  return env.envelopes
    .filter(entry => entry.streamId === chatId && entry.envelope.type.startsWith('steer/'))
    .map(({ envelope }) => {
      parseSseV2EventData(envelope.type, envelope.data);
      return { type: envelope.type, runId: envelope.runId, ...envelope.data };
    });
}

const userText = request =>
  request.body.messages
    .filter(m => m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

test('a message read at a step is told, stored with its turn and listed in the evidence record', async t => {
  const chatId = crypto.randomUUID();
  let runId = null;
  const model = script(
    t,
    [
      turn.toolCalls([{ name: 'lookup', args: { key: 'R-1' } }]),
      turn.text('Records are kept for ten years, in EUR.'),
      turn.text('Yes, in EUR.')
    ],
    {
      onRequest: async (_request, _ctx) => {
        if (model.calls === 1) runId = await sendNow(chatId, { id: 'steer-a', message: 'Use EUR' });
      }
    }
  );

  const outcome = await chatTurn(chatId);
  assert.equal(outcome.status, 'ran');
  assert.equal(outcome.nextTurn, undefined, 'nothing was left over');

  // The model read it at step 2, behind the marker, after the tool result.
  const second = model.requests[1].body.messages;
  const read = second.at(-1);
  assert.equal(read.role, 'user');
  assert.ok(read.content.startsWith(STEER_MARKER));
  assert.match(read.content, /Use EUR$/);

  // The stream said it was queued and read at step 2, with its activity row.
  assert.deepEqual(
    steerFrames(chatId).map(f => [f.type, f.id, f.step, f.activityKind]),
    [
      ['steer/queued', 'steer-a', undefined, undefined],
      ['steer/applied', 'steer-a', 2, 'user_message']
    ]
  );

  // Stored as a user message of the turn's run, between the question and the answer.
  const { messages } = await getChatRepository().getMessages(chatId);
  assert.deepEqual(
    messages.map(m => [m.role, m.content, m.steer ?? null, m.appliedAtStep ?? null]),
    [
      ['user', 'What is the retention period?', null, null],
      ['user', 'Use EUR', true, 2],
      ['assistant', 'Records are kept for ten years, in EUR.', null, null]
    ]
  );
  assert.equal(messages[1].runId, runId);
  assert.equal(messages[1].steerId, 'steer-a');

  // The evidence record names the message, its sender and its step.
  await env.settle();
  const { record, items } = await buildEvidence({ runLog: env.runLog, runId });
  assert.equal(record.steers.length, 1);
  const [entry] = record.steers;
  assert.equal(entry.id, 'steer-a');
  assert.equal(entry.step, 2);
  assert.equal(entry.by, 'u1');
  assert.equal(JSON.parse(items.get(entry.content.replace('sha256:', ''))), 'Use EUR');

  // A later turn reads it where it was sent, behind the marker.
  const next = await chatTurn(chatId, {
    overrides: {
      messageId: 'msg-2',
      message: { role: 'user', content: 'In EUR?', messageId: 'msg-2' }
    }
  });
  assert.equal(next.status, 'ran');
  const history = userText(model.requests[2]);
  assert.deepEqual(history.slice(0, 2), [
    'What is the retention period?',
    `${STEER_MARKER} Mid-run instruction from the person running this task: Use EUR`
  ]);
});

test('a message sent during the last model call becomes the next turn, exactly once, and the stream says so', async t => {
  const chatId = crypto.randomUUID();
  let firstRun = null;
  const model = script(
    t,
    [turn.text('Records are kept for ten years.'), turn.text('In EUR: ten years as well.')],
    {
      onRequest: async () => {
        if (model.calls === 1) firstRun = await sendNow(chatId, { id: 'late', message: 'In EUR?' });
      }
    }
  );

  const outcome = await chatTurn(chatId);
  assert.equal(outcome.status, 'ran');
  assert.ok(outcome.nextTurn, 'a next turn was started');
  const next = await outcome.nextTurn;
  assert.equal(next.status, 'ran');

  // Not read in the first answer: it came after its last model call.
  assert.equal(
    userText(model.requests[0]).some(text => text.includes('In EUR?')),
    false
  );
  // It is the question of the second, once.
  const asked = userText(model.requests[1]);
  assert.equal(asked.at(-1), 'In EUR?');
  assert.equal(asked.filter(text => text.includes('In EUR?')).length, 1);

  const nextRun = outcome.result.leftover.runId;
  assert.notEqual(nextRun, firstRun);
  assert.deepEqual(
    steerFrames(chatId).map(f => [f.type, f.runId, f.id, f.nextRunId ?? null]),
    [
      ['steer/queued', firstRun, 'late', null],
      ['steer/applied', firstRun, 'late', nextRun]
    ]
  );

  const repository = getChatRepository();
  const { messages } = await repository.getMessages(chatId);
  assert.deepEqual(
    messages.map(m => [m.role, m.content, m.runId === nextRun]),
    [
      ['user', 'What is the retention period?', false],
      ['assistant', 'Records are kept for ten years.', false],
      ['user', 'In EUR?', true],
      ['assistant', 'In EUR: ten years as well.', true]
    ]
  );
  assert.equal(messages[2].clientMessageId, 'late', 'the message keeps its id');
  const chat = await repository.getChat(chatId);
  assert.equal(chat.status, 'active');
  assert.equal(chat.activeRunId, null);
  assert.deepEqual(pendingSteers(firstRun), []);
});

test('a send-afterwards message is not read at a step; the steers around it are, and it is the next turn', async t => {
  const chatId = crypto.randomUUID();
  const model = script(
    t,
    [
      turn.toolCalls([{ name: 'lookup', args: { key: 'R-2' } }]),
      turn.text('Ten years.'),
      turn.toolCalls([{ name: 'lookup', args: { key: 'R-3' } }]),
      turn.text('A summary in two lines.')
    ],
    {
      onRequest: async () => {
        if (model.calls !== 1) return;
        await sendNow(chatId, { id: 'read-now', message: 'Be brief' });
        await sendNow(chatId, { id: 'after', mode: 'afterwards', message: 'Then summarise it' });
        await sendNow(chatId, { id: 'behind', message: 'Two lines at most' });
      }
    }
  );
  // The first steer and the one behind the send-afterwards message are both
  // queued before step 2: steers are read in their order, and a send-afterwards
  // message waits for the end, so both steers are read at step 2.
  const outcome = await chatTurn(chatId);
  const next = await outcome.nextTurn;
  assert.equal(next.status, 'ran');
  const step2 = userText(model.requests[1]).filter(text => text.startsWith(STEER_MARKER));
  assert.equal(step2.length, 2);
  assert.equal(userText(model.requests[2]).at(-1), 'Then summarise it');
  const frames = steerFrames(chatId).filter(f => f.type === 'steer/applied');
  assert.deepEqual(
    frames.map(f => [f.id, f.step ?? 'next']),
    [
      ['read-now', 2],
      ['behind', 2],
      ['after', 'next']
    ]
  );
});

test('a steer left behind a send-afterwards message waits in the next turn and is read at its first step', async t => {
  const chatId = crypto.randomUUID();
  let firstRun = null;
  const model = script(t, [turn.text('Ten years.'), turn.text('Summary: ten years.')], {
    onRequest: async () => {
      if (model.calls !== 1) return;
      firstRun = await sendNow(chatId, { id: 'after', mode: 'afterwards', message: 'Summarise' });
      await sendNow(chatId, { id: 'behind', message: 'One line' });
    }
  });
  const outcome = await chatTurn(chatId);
  const next = await outcome.nextTurn;
  assert.equal(next.status, 'ran');
  const nextRun = outcome.result.leftover.runId;
  assert.deepEqual(userText(model.requests[1]).slice(-2), [
    'Summarise',
    `${STEER_MARKER} Mid-run instruction from the person running this task: One line`
  ]);
  assert.deepEqual(
    steerFrames(chatId).map(f => [f.type, f.runId === firstRun ? 'first' : 'next', f.id]),
    [
      ['steer/queued', 'first', 'after'],
      ['steer/queued', 'first', 'behind'],
      ['steer/applied', 'first', 'after'],
      ['steer/queued', 'next', 'behind'],
      ['steer/applied', 'next', 'behind']
    ]
  );
  const applied = steerFrames(chatId).filter(f => f.type === 'steer/applied');
  assert.equal(applied[0].nextRunId, nextRun);
  assert.equal(applied[1].step, 1);
});

test('a newer message that replaces the answer drops what the answer did not read', async t => {
  const chatId = crypto.randomUUID();
  const model = script(t, [turn.hang(), turn.text('Seven years.')], {
    onRequest: async () => {
      if (model.calls === 1) await sendNow(chatId, { id: 'old', message: 'In EUR?' });
    }
  });
  const first = chatTurn(chatId);
  await model.waitForCall(1);
  await new Promise(resolve => setImmediate(resolve));
  const second = await chatTurn(chatId, {
    overrides: {
      messageId: 'msg-2',
      message: { role: 'user', content: 'Actually: how long for invoices?', messageId: 'msg-2' }
    }
  });
  const replaced = await first;
  assert.equal(second.status, 'ran');
  assert.equal(replaced.nextTurn, undefined);
  assert.equal(second.nextTurn, undefined);
  assert.deepEqual(
    steerFrames(chatId)
      .filter(f => f.type !== 'steer/queued')
      .map(f => [f.type, f.id, f.reason]),
    [['steer/dropped', 'old', 'superseded']]
  );
  assert.equal(model.calls, 2, 'no turn was made of the dropped message');
});

test('in a temporary chat the leftover is dropped, the client is told and no turn starts', async t => {
  const chatId = crypto.randomUUID();
  const model = script(t, [turn.text('Ten years.')], {
    onRequest: async () => {
      await sendNow(chatId, { id: 'tmp', message: 'In EUR?' });
    }
  });
  const outcome = await chatTurn(chatId, { overrides: { ephemeral: true } });
  assert.equal(outcome.status, 'ran');
  assert.equal(outcome.nextTurn, undefined);
  assert.equal(model.calls, 1);
  assert.deepEqual(
    steerFrames(chatId).map(f => [f.type, f.id, f.reason ?? null, f.text]),
    [
      ['steer/queued', 'tmp', null, 'In EUR?'],
      ['steer/dropped', 'tmp', 'temporary_chat', 'In EUR?']
    ]
  );
  const chat = await getChatRepository().getChat(chatId);
  assert.equal(chat.temporary, true);
  assert.equal(chat.activeRunId, null);
});

test('a caller that starts no next turn drops the leftover with run_ended', async t => {
  const chatId = crypto.randomUUID();
  script(t, [turn.text('Ten years.')], {
    onRequest: async () => {
      await sendNow(chatId, { id: 'api', message: 'In EUR?' });
    }
  });
  const outcome = await chatTurn(chatId, { leftover: false });
  assert.equal(outcome.nextTurn, undefined);
  assert.deepEqual(
    steerFrames(chatId)
      .filter(f => f.type === 'steer/dropped')
      .map(f => [f.id, f.reason]),
    [['api', 'run_ended']]
  );
  assert.equal((await getChatRepository().getChat(chatId)).activeRunId, null);
});

test('a next turn that cannot start lets go of the chat and gives the text back', async t => {
  const chatId = crypto.randomUUID();
  script(t, [turn.text('Ten years.')], {
    onRequest: async () => {
      await sendNow(chatId, { id: 'nope', message: 'In EUR?' });
    }
  });
  const prepared = await prepareTurn(turnRequest(chatId), {
    user,
    getLocalizedError,
    settleClarifications
  });
  const outcome = await runPreparedTurn(prepared.turn, {
    chatService: env.chatService,
    getLocalizedError,
    timeoutMs: 5000,
    leftover: {
      settleClarifications: async () => {
        throw new Error('the interaction store is down');
      }
    }
  });
  assert.equal(await outcome.nextTurn, null);
  const chat = await getChatRepository().getChat(chatId);
  assert.equal(chat.activeRunId, null, 'the claim of the next turn is let go of');
  assert.equal(chat.status, 'active');
  assert.deepEqual(
    steerFrames(chatId)
      .filter(f => f.type === 'steer/dropped')
      .map(f => [f.id, f.reason]),
    [['nope', 'not_started']]
  );
});

test('two writers letting go of the chat at once: the leftover is taken once, and the next turn claims the chat', async () => {
  const { enqueueSteer } = await import('../services/loop/steering.js');
  const { createLeftover } = await import('../services/chat/chatSteering.js');
  const repository = getChatRepository();
  const chatId = crypto.randomUUID();
  const runId = `chat-${crypto.randomUUID()}`;
  await repository.ensureChat({
    chatId,
    ownerId: 'u1',
    identityMode: 'default',
    appId: 'desk',
    title: 'Two writers',
    origin: { createdVia: 'ui' }
  });
  await repository.updateChat(chatId, { activeRunId: runId, status: 'running' });
  enqueueSteer(runId, { id: 'w1', message: 'Use EUR', chatId });
  const writers = [
    createLeftover({ runId, startsNextTurn: true }),
    createLeftover({ runId, startsNextTurn: true })
  ];
  const idle = { activeRunId: null, status: 'active' };
  const released = await Promise.all(
    writers.map(writer =>
      repository.releaseRun(chatId, runId, chat => ({
        ...idle,
        ...(writer.takerFor('completed')(chat) || {})
      }))
    )
  );
  assert.equal(released.filter(r => r.released).length, 1, 'one writer let go of the chat');
  const next = writers.map(writer => writer.finish('superseded')).filter(Boolean);
  assert.equal(next.length, 1, 'one next turn');
  assert.deepEqual(
    next[0].first.map(e => e.id),
    ['w1']
  );
  assert.equal(next[0].text, 'Use EUR');
  const chat = await repository.getChat(chatId);
  assert.equal(chat.activeRunId, next[0].runId, 'claimed for the next turn in the same write');
  assert.equal(chat.status, 'running');
});

test('the leftover splits into the next question and what waits behind it', () => {
  const steer = (id, message) => ({ id, mode: 'steer', message });
  const after = (id, message) => ({ id, mode: 'afterwards', message });
  const a = splitLeftover([steer('1', 'Use EUR'), steer('2', 'Be brief'), after('3', 'Then this')]);
  assert.equal(a.text, 'Use EUR\n\nBe brief');
  assert.deepEqual(
    a.rest.map(e => e.id),
    ['3']
  );
  const b = splitLeftover([after('1', 'First'), after('2', 'Second'), steer('3', 'x')]);
  assert.equal(b.text, 'First');
  assert.deepEqual(
    b.rest.map(e => e.id),
    ['2', '3']
  );
  assert.deepEqual(splitLeftover([]), { first: [], rest: [], text: '' });
});

test('the chat read model lists what waits for its reader, with actions for the owner only', async () => {
  const chatId = crypto.randomUUID();
  const runId = 'chat-00000000-0000-4000-8000-000000000001';
  const { enqueueSteer } = await import('../services/loop/steering.js');
  enqueueSteer(runId, { id: 'p1', message: 'Use EUR', chatId });
  enqueueSteer(runId, { id: 'p2', mode: 'afterwards', message: 'Then this', chatId });
  enqueueSteer(runId, { id: 'p3', message: 'Of another chat', chatId: 'chat-other' });
  const chat = { id: chatId, status: 'running', activeRunId: runId };

  assert.equal(await chatPendingView(chat, { owner: true, features: {} }), null, 'feature off');

  const on = { steering: true };
  const owner = await chatPendingView(chat, { owner: true, features: on });
  assert.equal(owner.maySteer, true);
  assert.deepEqual(owner.pending, [
    {
      id: 'p1',
      kind: 'steer',
      text: 'Use EUR',
      labelKey: 'chat.pending.steer',
      actions: ['remove']
    },
    {
      id: 'p2',
      kind: 'send_after',
      text: 'Then this',
      labelKey: 'chat.pending.sendAfter',
      actions: ['remove']
    }
  ]);

  const reader = await chatPendingView(chat, { owner: false, features: on });
  assert.equal(reader.maySteer, false);
  assert.deepEqual(
    reader.pending.map(p => p.actions),
    [[], []]
  );

  const idle = await chatPendingView(
    { ...chat, status: 'active', activeRunId: null },
    { owner: true, features: on }
  );
  assert.deepEqual(idle, { pending: [], maySteer: true });
});

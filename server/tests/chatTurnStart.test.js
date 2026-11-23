// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The start of a chat turn without an Express request (#3191, #3777, #3197).
 *
 * `prepareTurn` and `runPreparedTurn` of `services/chat/chatTurnStart.js` are
 * called with a plain `TurnRequest`, as a caller without a request will call
 * them: no `req`, no `res`, no route. Nothing of the server is replaced but
 * the model, which answers from a script (the environment of the golden
 * harness: real storage in a temporary directory, the real `ChatService`, the
 * real file store, the agent loop and the run ledger).
 *
 * What the chat route does with the two functions is pinned by the chat
 * goldens, which are recorded through the route. This file pins what the
 * goldens cannot see: that a turn needs no request, that every input of a
 * `TurnRequest` reaches the turn, that a refusal is a value, and the order of
 * the answer and the release.
 */
import test, { before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// The harness first: it isolates the contents directory before the server loads.
import { startGoldenEnv } from './golden/harness.js';
import { scriptedModel, turn } from './helpers/scriptedModel.js';
import { fixtureInstallation, fixtureTool } from './helpers/integrationToolFixture.js';
import { prepareTurn, principalRefOf, runPreparedTurn } from '../services/chat/chatTurnStart.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { guestOwnerId, setGuestId } from '../services/chat/chatOwner.js';
import { quotaUserKey } from '../services/quota/quotaService.js';
import {
  registerScopeProvider,
  unregisterScopeProvider
} from '../services/integrations/scopes/index.js';
import { turnRequestOf } from '../routes/chat/sessionRoutes.js';
import { isChatDurable } from '../sse.js';
import { ServiceError } from '../utils/ServiceError.js';
import { chatPostSchema } from '../validators/index.js';

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

const UPLOAD = {
  fileName: 'agreement.txt',
  fileType: 'text/plain',
  fileSize: 41,
  content: 'Section 1: Payment terms are net 30 days.'
};

const getLocalizedError = async key => `localized:${key}`;

let env;
let user;
/** What the fixture tool saw of each call: the scope it was bound to and the time zone. */
let lookupCalls;
/** The calls of `settleClarifications`, which the caller hands in. */
let settled;

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
        run: (args, ctx) => {
          lookupCalls.push({
            key: args.key,
            scope: ctx?.scope?.id ?? null,
            clientTimezone: ctx?.params?.clientTimezone ?? null
          });
          return { found: args.key };
        }
      })
    ],
    integrations: () => ({
      installed: [fixtureInstallation('lookup')],
      security: { blockPrivateIps: true, allowedHosts: [] }
    })
  });
  // The integration `lookup` offers one scope, `contracts`, to everybody.
  registerScopeProvider({
    id: 'lookup',
    appliesTo: ({ app }) => Boolean(app?.integrations?.lookup),
    listScopes: async () => ({
      scopes: [{ id: 'contracts', name: 'Contracts', isDefault: false }],
      defaultScope: null,
      fixed: false,
      source: 'test'
    }),
    validateScope: async ({ scopeId }) =>
      !scopeId || scopeId === 'contracts'
        ? { ok: true, scopeId: scopeId || null, fixed: false }
        : { ok: false, code: 'INTEGRATION_SCOPE_FORBIDDEN', message: 'Not a scope of yours' }
  });
  user = env.principal({ id: 'u1', name: 'User One', groups: ['users'] });
});

after(async () => {
  unregisterScopeProvider('lookup');
  await env?.stop();
});

beforeEach(() => {
  env.envelopes.length = 0;
  lookupCalls = [];
  settled = [];
});

// A turn writes its run log, its evidence and its chat in the background: every test waits
// for them, so none is left running into the next test or into the shutdown.
afterEach(async () => {
  await env.settle();
});

/** Script the model for one test; the script must be used exactly. */
function script(t, turns) {
  const model = scriptedModel(turns);
  env.model = model;
  t.after(() => model.assertDone());
  return model;
}

/** A turn request as a caller without an HTTP request builds it: plain data. */
function turnRequest(overrides = {}) {
  return {
    chatId: crypto.randomUUID(),
    appId: 'desk',
    principalRef: principalRefOf(user),
    messageId: 'msg-1',
    message: { role: 'user', content: 'What does the agreement say?', messageId: 'msg-1' },
    clientHistory: 0,
    language: 'en',
    origin: 'person',
    ...overrides
  };
}

/** What the caller hands to `prepareTurn`. */
function host(overrides = {}) {
  return {
    user,
    getLocalizedError,
    settleClarifications: async params => {
      settled.push(params);
      return null;
    },
    ...overrides
  };
}

/** What the caller hands to `runPreparedTurn`. */
const runHost = (overrides = {}) => ({
  chatService: env.chatService,
  getLocalizedError,
  timeoutMs: 5000,
  ...overrides
});

/** A stream of the caller's own, as `openChatPostStream` answers one. */
function fakeStream() {
  const stream = {
    opened: null,
    open: true,
    written: [],
    ended: 0,
    isOpen: () => stream.open,
    write: envelope => stream.written.push(envelope) > 0,
    hasEnded: () => false,
    end: () => {
      stream.ended += 1;
    }
  };
  return stream;
}

const framesOf = chatId =>
  env.envelopes.filter(entry => entry.streamId === chatId).map(entry => entry.envelope.type);

test('a turn starts from a TurnRequest with an upload and an integration scope, without an Express request', async t => {
  const model = script(t, [
    turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }]),
    turn.text('Payment is due after 30 days.')
  ]);
  const request = turnRequest({
    message: {
      role: 'user',
      content: 'What does the agreement say?',
      messageId: 'msg-1',
      fileData: UPLOAD
    },
    integrationScopes: { lookup: 'contracts' },
    clientTimezone: 'Europe/Berlin',
    toolApprovalCapable: true
  });
  // The request is plain data: it survives a round trip through JSON unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(request)), request);

  const prepared = await prepareTurn(request, host());
  assert.equal(prepared.refusal, undefined);
  assert.equal(prepared.answer, undefined);
  const prepTurn = prepared.turn;
  assert.deepEqual(prepTurn.requestOptions.integrationScopes, { lookup: 'contracts' });
  assert.equal(prepTurn.canApproveTools, true);
  // The upload was read into the file store of the chat: the prompt message carries its
  // text, and the stored message will carry its descriptor.
  assert.equal(prepTurn.persistence.attachments.length, 1);
  assert.match(prepTurn.persistence.attachments[0].id, /^file_/);
  assert.equal(prepTurn.persistence.attachments[0].name, 'agreement.txt');
  assert.equal([prepTurn.promptMessage.fileData].flat()[0].content, UPLOAD.content);
  // The pending questions of the chat were settled for this message, by the caller's function.
  assert.deepEqual(settled, [{ chatId: request.chatId, user, lastMessage: request.message }]);

  const outcome = await runPreparedTurn(prepTurn, runHost());
  assert.equal(outcome.status, 'ran');
  assert.equal(outcome.told, false);
  assert.equal(outcome.result.content, 'Payment is due after 30 days.');

  // The text of the upload reached the model with the question.
  const sent = JSON.stringify(model.requests[0].body.messages);
  assert.match(sent, /Payment terms are net 30 days/);
  assert.match(sent, /What does the agreement say\?/);
  // The scope binds the tool call, and the sender's time zone reaches the tool.
  assert.deepEqual(lookupCalls, [
    { key: 'A-1', scope: 'contracts', clientTimezone: 'Europe/Berlin' }
  ]);

  // The frames of the turn went to the stream of the chat, as one run.
  const frames = framesOf(request.chatId);
  assert.equal(frames[0], 'run/started');
  assert.ok(frames.includes('tool/completed'));
  assert.equal(frames.at(-1), 'run/ended');

  // The chat is stored under the user, with the question, its upload, the answer and the scope.
  await env.settle();
  const repository = getChatRepository();
  const chat = await repository.getChat(request.chatId);
  assert.equal(chat.ownerId, 'u1');
  assert.deepEqual(chat.settings.integrationScopes, { lookup: 'contracts' });
  const { messages } = await repository.getMessages(request.chatId);
  assert.deepEqual(
    messages.map(message => message.role),
    ['user', 'assistant']
  );
  assert.equal(messages[0].clientMessageId, 'msg-1');
  assert.equal(messages[0].attachments[0].name, 'agreement.txt');
  assert.equal(messages[1].content, 'Payment is due after 30 days.');
  // The turn let go of the chat.
  assert.equal(isChatDurable(request.chatId), false);
});

test('a refusal is a value with the status and the registry code, and nothing is thrown', async t => {
  // A chat of the user, to be asked for by somebody else.
  script(t, [turn.text('Hello.')]);
  const own = turnRequest();
  const first = await prepareTurn(own, host());
  await runPreparedTurn(first.turn, runHost());

  const other = env.principal({ id: 'u2', name: 'User Two', groups: ['users'] });
  const foreign = await prepareTurn(
    { ...own, principalRef: principalRefOf(other), messageId: 'msg-2' },
    host({ user: other })
  );
  assert.deepEqual(foreign, {
    refusal: { status: 404, code: 'NOT_FOUND', message: 'Chat session not found' }
  });

  const scope = await prepareTurn(
    turnRequest({ integrationScopes: { lookup: 'payroll' } }),
    host()
  );
  assert.deepEqual(scope, {
    refusal: {
      status: 403,
      code: 'INTEGRATION_SCOPE_FORBIDDEN',
      message: 'Not a scope of yours',
      details: { integrationId: 'lookup' }
    }
  });

  const noMessage = await prepareTurn(turnRequest({ message: undefined }), host());
  assert.deepEqual(noMessage, {
    refusal: { status: 400, code: 'BAD_REQUEST', message: 'localized:messagesRequired' }
  });
});

test('who is asking is checked before what was sent, and the pending questions are settled before the message is refused', async () => {
  // A chat of the user that somebody else asks for, with a history sent along: refused as
  // an unknown chat. The refusal for the history would tell that the chat exists.
  const chatId = crypto.randomUUID();
  await getChatRepository().ensureChat({ chatId, ownerId: 'u1', identityMode: 'default' });
  const other = env.principal({ id: 'u2', name: 'User Two', groups: ['users'] });
  const foreign = await prepareTurn(
    turnRequest({ chatId, principalRef: principalRefOf(other), clientHistory: 2 }),
    host({ user: other })
  );
  assert.equal(foreign.refusal.code, 'NOT_FOUND');
  // Refused before anything of the chat was touched.
  assert.equal(settled.length, 0);

  const refused = await prepareTurn(turnRequest({ chatId, clientHistory: 2 }), host());
  assert.equal(refused.refusal.status, 400);
  assert.equal(refused.refusal.code, 'CLIENT_HISTORY_NOT_ALLOWED');
  assert.match(refused.refusal.details.hint, /post only the new message/);
  // This is the order the route has always had: the questions of the chat are settled for
  // the message before the message is refused.
  assert.equal(settled.length, 1);

  // An id the store cannot key is refused before the history that was sent along.
  const invalidId = await prepareTurn(
    turnRequest({ chatId: 'not a chat id', clientHistory: 2 }),
    host()
  );
  assert.deepEqual(invalidId.refusal, {
    status: 400,
    code: 'BAD_REQUEST',
    message: 'Invalid chat id'
  });
});

test('the resolved user is the principal the request names', async () => {
  const other = env.principal({ id: 'u2', name: 'User Two', groups: ['users'] });
  await assert.rejects(
    () => prepareTurn(turnRequest(), host({ user: other })),
    /not the user it is prepared for/
  );
  await assert.rejects(
    () => prepareTurn(turnRequest(), { user, getLocalizedError }),
    /needs getLocalizedError and settleClarifications/
  );
  assert.deepEqual(principalRefOf(user), { type: 'user', id: 'u1' });
  assert.deepEqual(principalRefOf(undefined), { type: 'guest', id: null });
});

test('without a stream of its own, a caller answers before the turn lets go of the chat', async t => {
  script(t, [turn.text('Hello.')]);
  const request = turnRequest();
  const prepared = await prepareTurn(request, host());
  const answered = [];
  const outcome = await runPreparedTurn(
    prepared.turn,
    runHost({
      sink: {
        answer: result =>
          answered.push({ status: result.status, held: isChatDurable(request.chatId) })
      }
    })
  );
  assert.equal(outcome.status, 'ran');
  assert.deepEqual(answered, [{ status: 'ran', held: true }]);
  assert.equal(isChatDurable(request.chatId), false);
});

test("a guest's turn is charged to the guest, for both positions of the run-service switch", async t => {
  // Usage limits count a guest under its own key (`guest-<hash>`): the model
  // calls of the turn must carry the request's own principal object, which
  // the guest's identity is bound to, not a copy of it.
  const secret = 'd'.repeat(64);
  const guest = env.principal({ id: 'anonymous', name: 'Anonymous', groups: ['users'] });
  setGuestId(guest, secret);
  const charged = [];
  const quota = env.llmClient.quota;
  env.llmClient.quota = {
    assert: async principal => {
      charged.push(quotaUserKey(principal));
    }
  };
  const platform = env.configCache.getPlatform();
  t.after(() => {
    env.llmClient.quota = quota;
    env.configCache.setCacheEntry('config/platform.json', platform);
  });
  for (const onRunService of [true, false]) {
    env.configCache.setCacheEntry('config/platform.json', {
      ...platform,
      runs: { chatOnRunService: onRunService }
    });
    const model = scriptedModel([turn.text('Hello, guest.')]);
    env.model = model;
    const request = turnRequest({ principalRef: principalRefOf(guest) });
    const prepared = await prepareTurn(request, host({ user: guest }));
    assert.equal(prepared.refusal, undefined, JSON.stringify(prepared.refusal));
    const outcome = await runPreparedTurn(prepared.turn, runHost());
    assert.equal(outcome.status, 'ran');
    model.assertDone();
  }
  assert.deepEqual(charged, [guestOwnerId(secret), guestOwnerId(secret)]);
});

test('a model request that cannot be built fails the turn as a run, and the outcome carries the message', async () => {
  // An app nobody configured: the request builder refuses it.
  const request = turnRequest({ appId: 'gone' });
  const prepared = await prepareTurn(request, host());
  const answered = [];
  const outcome = await runPreparedTurn(
    prepared.turn,
    runHost({ sink: { answer: result => answered.push(result) } })
  );
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.told, false);
  assert.equal(typeof outcome.error.code, 'string');
  assert.equal(outcome.error.message, `localized:${outcome.error.code}`);
  assert.deepEqual(answered, [outcome]);
  // The chat's stream was told as a failed run.
  assert.deepEqual(framesOf(request.chatId).slice(-2), ['stream/error', 'run/ended']);
  assert.equal(isChatDurable(request.chatId), false);
});

test('on a stream of the caller, the turn is told there: the stream is opened at the commit point and ended at the release', async t => {
  script(t, [turn.text('Hello.')]);
  const request = turnRequest();
  const prepared = await prepareTurn(request, host());
  const stream = fakeStream();
  const answered = [];
  const outcome = await runPreparedTurn(
    prepared.turn,
    runHost({
      sink: {
        open: opened => {
          stream.opened = { ...opened, held: isChatDurable(request.chatId) };
          return stream;
        },
        answer: result => answered.push(result)
      }
    })
  );
  assert.equal(outcome.status, 'ran');
  assert.equal(outcome.told, true);
  // Opened once the turn owns the chat and its run has a name.
  assert.equal(stream.opened.chatId, request.chatId);
  assert.equal(stream.opened.durable, true);
  assert.equal(stream.opened.held, true);
  assert.equal(stream.opened.runId, outcome.result.runId);
  assert.equal(stream.ended, 1);
  // Nothing is left to answer.
  assert.deepEqual(answered, []);
  // Whether the reader is still there is asked of that stream.
  assert.equal(prepared.turn.persistence.clientConnected(), true);
});

test('a failure after the commit point is a frame on the stream of the caller, and thrown without one', async () => {
  const failing = Object.create(env.chatService);
  failing.runTurn = async () => {
    throw new ServiceError('CONFLICT', 'The chat changed under the turn');
  };

  const onStream = await prepareTurn(turnRequest(), host());
  const stream = fakeStream();
  const outcome = await runPreparedTurn(
    onStream.turn,
    runHost({ chatService: failing, sink: { open: () => stream } })
  );
  assert.deepEqual(outcome, { status: 'failed', told: true });
  assert.deepEqual(
    stream.written.map(frame => frame.type),
    ['stream/error', 'run/ended']
  );
  assert.equal(stream.written[0].data.code, 'CONFLICT');
  assert.equal(stream.written[0].data.details.status, 409);
  assert.equal(stream.written[1].data.status, 'error');
  assert.equal(stream.ended, 1);

  const plain = await prepareTurn(turnRequest(), host());
  await assert.rejects(
    () => runPreparedTurn(plain.turn, runHost({ chatService: failing })),
    error => error instanceof ServiceError && error.code === 'CONFLICT'
  );
  assert.equal(isChatDurable(plain.turn.chatId), false);
});

/** A refusal as the approval, the connect or the chat's store answers one. */
const lateRefusal = code => ({ status: 409, code, message: `refused: ${code}` });

/**
 * A chat service whose model request is built for real and whose turn is played by `play`:
 * nothing of these turns reaches the model.
 */
function playedService(play) {
  const service = Object.create(env.chatService);
  service.runTurn = play;
  return service;
}

/**
 * A prepared turn that takes a resumed call after a connect and answers an approval, each
 * through the given function, and notes each put-back in `order`.
 */
async function resumingTurn(order, { connect, approval, request = turnRequest() }) {
  const prepared = await prepareTurn(request, host());
  return {
    ...prepared.turn,
    commitConnectResume: async () => {
      order.push('connect taken');
      return {
        resume: { calls: [] },
        refusal: null,
        restore: async () => order.push('connect put back'),
        ...connect
      };
    },
    commitApproval: async () => {
      order.push('approval answered');
      return {
        grants: ['lookup'],
        resume: null,
        refusal: null,
        restore: async () => order.push('approval put back'),
        ...approval
      };
    }
  };
}

test('an approval refused when the turn is about to run is the outcome without a stream, and the connect taken before it is put back after the answer', async () => {
  const order = [];
  const service = playedService(async () => {
    order.push('run');
    return { status: 'completed' };
  });
  const refusal = lateRefusal('APPROVAL_ALREADY_ANSWERED');
  const prepared = await resumingTurn(order, { approval: { refusal, restore: undefined } });
  const outcome = await runPreparedTurn(
    prepared,
    runHost({ chatService: service, sink: { answer: () => order.push('answered') } })
  );
  // Nothing was told: the caller answers the refusal with its status and code.
  assert.deepEqual(outcome, { status: 'refused', told: false, refusal });
  // The turn never ran. The refused approval was not used up, so there is nothing of it to put
  // back; the call the connect gave was taken, and is put back once the caller was answered.
  assert.deepEqual(order, ['connect taken', 'approval answered', 'answered', 'connect put back']);
  // The chat's own stream was told as a failed run with the code.
  const frames = env.envelopes.filter(entry => entry.streamId === prepared.chatId);
  assert.deepEqual(
    frames.map(entry => entry.envelope.type),
    ['run/started', 'stream/error', 'run/ended']
  );
  assert.equal(frames[1].envelope.data.code, 'APPROVAL_ALREADY_ANSWERED');
  assert.equal(isChatDurable(prepared.chatId), false);
});

test('a connect refused when the turn is about to run is told on the stream of the caller, which is ended, and nothing is answered', async () => {
  const order = [];
  const service = playedService(async () => {
    order.push('run');
    return { status: 'completed' };
  });
  const refusal = lateRefusal('NOT_PENDING');
  const prepared = await resumingTurn(order, { connect: { refusal, restore: undefined } });
  const stream = fakeStream();
  stream.end = () => order.push('ended');
  const outcome = await runPreparedTurn(
    prepared,
    runHost({
      chatService: service,
      sink: { open: () => stream, answer: () => order.push('answered') }
    })
  );
  assert.deepEqual(outcome, { status: 'refused', told: true, refusal });
  // Refused before the approval was answered; the reader heard of it as the failed run.
  assert.deepEqual(order, ['connect taken', 'ended']);
  const failed = env.envelopes.filter(entry => entry.streamId === prepared.chatId);
  assert.deepEqual(
    failed.map(entry => entry.envelope.type),
    ['run/started', 'stream/error', 'run/ended']
  );
  assert.equal(failed[1].envelope.data.code, 'NOT_PENDING');
});

test('a turn the chat store refuses before its loop starts is a 409, and the approval and the connect it used up are put back', async () => {
  const order = [];
  const refusal = { message: 'The chat moved', code: 'CHAT_CONTAINER_CHANGED' };
  const service = playedService(async () => {
    order.push('run');
    return { status: 'error', refusal };
  });
  const expected = { status: 409, code: 'CHAT_CONTAINER_CHANGED', message: 'The chat moved' };

  const plain = await resumingTurn(order, {});
  const outcome = await runPreparedTurn(
    plain,
    runHost({ chatService: service, sink: { answer: () => order.push('answered') } })
  );
  assert.deepEqual(outcome, { status: 'refused', told: false, refusal: expected });
  // The loop never started: both are put back, after the caller was answered.
  assert.deepEqual(order, [
    'connect taken',
    'approval answered',
    'run',
    'answered',
    'approval put back',
    'connect put back'
  ]);

  // On a stream of the caller the refusal is a frame there; nothing is answered.
  order.length = 0;
  const onStream = await resumingTurn(order, {});
  const stream = fakeStream();
  const told = await runPreparedTurn(
    onStream,
    runHost({
      chatService: service,
      sink: { open: () => stream, answer: () => order.push('answered') }
    })
  );
  assert.deepEqual(told, { status: 'refused', told: true, refusal: expected });
  assert.deepEqual(
    stream.written.map(frame => frame.type),
    ['stream/error', 'run/ended']
  );
  assert.equal(stream.written[0].data.code, 'CHAT_CONTAINER_CHANGED');
  assert.equal(stream.written[0].data.details.status, 409);
  assert.equal(stream.ended, 1);
  assert.deepEqual(order, [
    'connect taken',
    'approval answered',
    'run',
    'approval put back',
    'connect put back'
  ]);
});

test('an approval and a connect the loop started on are not put back', async () => {
  const order = [];
  const service = playedService(async ({ toolApproval, connectResume }) => {
    order.push('run');
    toolApproval.started = true;
    connectResume.started = true;
    return { status: 'completed' };
  });
  const prepared = await resumingTurn(order, {});
  const outcome = await runPreparedTurn(prepared, runHost({ chatService: service }));
  assert.equal(outcome.status, 'ran');
  // The calls may have run.
  assert.deepEqual(order, ['connect taken', 'approval answered', 'run']);
  assert.deepEqual(prepared.toolApproval.grants, ['lookup']);
});

test('a temporary chat whose reader left while the turn was prepared does not run; a kept chat does', async () => {
  let runs = 0;
  const service = playedService(async () => {
    runs += 1;
    return { status: 'completed' };
  });
  const closedStream = () => {
    const stream = fakeStream();
    stream.open = false;
    return stream;
  };

  const temporary = await prepareTurn(turnRequest({ ephemeral: true }), host());
  assert.equal(temporary.turn.persistence.temporary, true);
  const left = closedStream();
  const answered = [];
  const abandoned = await runPreparedTurn(
    temporary.turn,
    runHost({
      chatService: service,
      sink: { open: () => left, answer: outcome => answered.push(outcome) }
    })
  );
  assert.deepEqual(abandoned, { status: 'abandoned', told: true });
  assert.equal(runs, 0);
  assert.deepEqual(answered, []);
  assert.equal(left.ended, 1);

  // A kept chat's turn outlives its reader.
  const kept = await prepareTurn(turnRequest(), host());
  assert.equal(kept.turn.persistence.temporary, false);
  const ran = await runPreparedTurn(
    kept.turn,
    runHost({ chatService: service, sink: { open: closedStream } })
  );
  assert.equal(ran.status, 'ran');
  assert.equal(runs, 1);

  // Without a stream of the caller there is no reader to leave.
  const unwatched = await prepareTurn(turnRequest({ ephemeral: true }), host());
  const alone = await runPreparedTurn(unwatched.turn, runHost({ chatService: service }));
  assert.equal(alone.status, 'ran');
  assert.equal(runs, 2);
});

test('a turn request carries its uploads on its message: a `files` field is refused, not dropped', async () => {
  await assert.rejects(
    () => prepareTurn(turnRequest({ files: [UPLOAD] }), host()),
    error => error instanceof TypeError && /uploads on its message/.test(error.message)
  );
  // Nothing of the chat was touched.
  assert.equal(settled.length, 0);
});

/** What `turnRequestOf` reads of a request: no Express, a plain object. */
function chatPost(body, headers = {}) {
  return {
    params: { appId: 'desk', chatId: 'chat-1' },
    body,
    headers,
    user,
    ip: '203.0.113.7',
    originalUrl: '/api/apps/desk/chat/chat-1'
  };
}

test('the chat route carries every field of its body into the turn request', () => {
  // A field that is added to the schema of the POST and not to `turnRequestOf` would be
  // accepted and then silently dropped: this is where that fails.
  const fields = Object.keys(chatPostSchema.body.shape).filter(field => field !== 'messages');
  assert.ok(fields.length >= 20, 'the schema of the chat POST lists its fields');
  const body = Object.fromEntries(fields.map(field => [field, `value of ${field}`]));
  const message = { role: 'user', content: 'hi', messageId: 'msg-9' };
  const request = turnRequestOf(chatPost({ ...body, messages: [message] }));
  for (const field of fields) {
    assert.equal(request[field], `value of ${field}`, `${field} is not in the turn request`);
  }
  assert.equal(request.chatId, 'chat-1');
  assert.equal(request.appId, 'desk');
  assert.deepEqual(request.principalRef, { type: 'user', id: 'u1' });
  assert.equal(request.origin, 'person');
  assert.equal(request.clientTimezone, null);
  // Plain data: no request, no response, no user object, nothing that cannot be copied.
  assert.doesNotThrow(() => structuredClone(request));
  assert.ok(!Object.values(request).includes(user));
});

test('the chat route names the new message, counts what was sent before it, and reads three headers', () => {
  const first = { role: 'user', content: 'earlier' };
  const last = { role: 'user', content: 'new', messageId: 'msg-2' };

  const one = turnRequestOf(chatPost({ messages: [last] }));
  assert.equal(one.message, last);
  assert.equal(one.messageId, 'msg-2');
  assert.equal(one.clientHistory, 0);
  // What the body left out stays undefined: the stored setup of the chat fills it in.
  assert.equal(one.modelId, undefined);
  assert.equal(one.integrationScopes, undefined);

  const two = turnRequestOf(chatPost({ messages: [first, last] }));
  assert.equal(two.message, last);
  assert.equal(two.clientHistory, 1);

  const none = turnRequestOf(chatPost({ messages: [] }));
  assert.equal(none.message, undefined);
  assert.equal(none.messageId, null);
  assert.equal(none.clientHistory, 0);

  const headers = {
    'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
    'x-session-id': 'session-7',
    'user-agent': 'test-agent'
  };
  const withHeaders = turnRequestOf(chatPost({ messages: [last] }, headers));
  assert.equal(withHeaders.language, 'de-DE');
  assert.deepEqual(withHeaders.client, {
    sessionId: 'session-7',
    userAgent: 'test-agent',
    ip: '203.0.113.7',
    url: '/api/apps/desk/chat/chat-1'
  });
  // The language of the body wins over the header.
  const named = turnRequestOf(chatPost({ messages: [last], language: 'en' }, headers));
  assert.equal(named.language, 'en');
});

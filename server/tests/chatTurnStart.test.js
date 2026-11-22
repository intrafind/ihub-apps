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
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// The harness first: it isolates the contents directory before the server loads.
import { startGoldenEnv } from './golden/harness.js';
import { scriptedModel, turn } from './helpers/scriptedModel.js';
import { fixtureInstallation, fixtureTool } from './helpers/integrationToolFixture.js';
import { prepareTurn, principalRefOf, runPreparedTurn } from '../services/chat/chatTurnStart.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import {
  registerScopeProvider,
  unregisterScopeProvider
} from '../services/integrations/scopes/index.js';
import { isChatDurable } from '../sse.js';
import { ServiceError } from '../utils/ServiceError.js';

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

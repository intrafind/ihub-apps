// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A chat turn streamed on its own POST (`Accept: text/event-stream`).
 *
 * Drives the real routes over a real HTTP server, with a filesystem chat store
 * and two seams: `prepareChatRequest` (no prompt is built) and `runTurn`, which
 * plays a turn by emitting frames through the same producers a real turn uses
 * (a bound run emitter, tool progress, a chat-launched workflow child run). The
 * cluster bus is replaced by a spy that pretends another worker holds a GET for
 * the chat, so a frame that would have crossed the bus shows up as a publish.
 */
import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const realBus = await import('../clusterBus.js');
/** `${kind}:${key}` entries "held by another worker". */
const remote = new Set();
const published = [];
jest.unstable_mockModule('../clusterBus.js', () => ({
  __esModule: true,
  ...realBus,
  hasRemote: (kind, key) => remote.has(`${kind}:${key}`),
  lookupRemote: async (kind, key) => remote.has(`${kind}:${key}`),
  publish: (type, payload) => {
    published.push({ type, payload });
    return true;
  }
}));

const { default: express } = await import('express');
const { default: configCache } = await import('../configCache.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
const { default: ChatService } = await import('../services/chat/ChatService.js');
const { activeRequests, clients, hasChatClient, openChatPostStream, postStreams } =
  await import('../sse.js');
const { ServiceError } = await import('../utils/ServiceError.js');
const { RunStreamEmitter, bindStreamRun, unbindStreamRun, emitToolProgress } =
  await import('../services/loop/RunStream.js');
const { normalizeAbortCause } = await import('../services/chat/abortCause.js');
const { default: registerSessionRoutes } = await import('../routes/chat/sessionRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const USER = {
  id: 'user-1',
  name: 'Ada',
  groups: ['users'],
  permissions: { apps: new Set(['*']), models: new Set(['*']) }
};

let baseDir;
let server;
let port;

/** How the stubbed turn behaves; reset per test. */
let turn;

function defaultTurn() {
  return {
    hold: null, // a promise the turn waits on before it ends
    aborted: null, // the abort reason, once aborted
    result: { status: 'success', content: '', finishReason: 'stop' },
    calls: []
  };
}

async function playTurn(params) {
  turn.calls.push(params);
  const { chatId, runId } = params;
  const controller = new AbortController();
  controller.startedAt = Date.now();
  activeRequests.set(chatId, controller);
  const stream = new RunStreamEmitter({ streamId: chatId, runId });
  bindStreamRun(chatId, runId, stream);
  try {
    stream.emit('run/started', { kind: 'chat', refs: { chatId, messageId: params.messageId } });
    stream.emit('step/delta', { step: 0, kind: 'thinking', content: 'pondering' });
    stream.emit('step/delta', { step: 0, kind: 'text', content: 'Hel' });
    stream.emit('step/delta', { step: 0, kind: 'text', content: 'lo' });
    // Tool progress only knows the chat id (the global delivery path).
    emitToolProgress(chatId, { phase: 'search.status', message: 'searching' });
    // A workflow a tool launched: its own run on the chat stream.
    const child = new RunStreamEmitter({ streamId: chatId, runId: 'wf-exec-1' });
    child.emit('run/started', { kind: 'workflow', parentRunId: runId, refs: {} });
    child.emit('run/ended', { status: 'completed', finishReason: 'stop' });
    if (turn.hold) {
      await Promise.race([
        turn.hold,
        new Promise(resolve =>
          controller.signal.addEventListener('abort', () => {
            turn.aborted = controller.signal.reason;
            resolve();
          })
        )
      ]);
    }
    const aborted = controller.signal.aborted;
    stream.emit('run/ended', {
      status: aborted ? 'aborted' : 'completed',
      finishReason: aborted ? 'cancelled' : 'stop'
    });
    return turn.result;
  } finally {
    unbindStreamRun(chatId, runId);
    if (activeRequests.get(chatId) === controller) activeRequests.delete(chatId);
  }
}

/** POST a message; resolves with status, headers and the raw body. */
function post(chatId, body, { accept, onFirstChunk } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        port,
        method: 'POST',
        path: `/api/apps/chat/chat/${chatId}`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(accept ? { accept } : {})
        }
      },
      res => {
        let text = '';
        let first = true;
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
          if (first && onFirstChunk) {
            first = false;
            onFirstChunk(req);
          }
        });
        const done = () => resolve({ status: res.statusCode, headers: res.headers, text });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      }
    );
    req.on('error', error => (onFirstChunk ? resolve({ aborted: true }) : reject(error)));
    req.end(payload);
  });
}

/** GET a JSON route; resolves with status and the parsed body. */
function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path: urlPath }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      })
      .on('error', reject);
  });
}

/** Parse an SSE body into `{ event, id, data }` frames. */
function framesOf(text) {
  return text
    .split('\n\n')
    .filter(block => block.trim() && !block.startsWith(':'))
    .map(block => {
      const frame = {};
      for (const line of block.split('\n')) {
        const at = line.indexOf(': ');
        const field = line.slice(0, at);
        const value = line.slice(at + 2);
        if (field === 'data') frame.data = JSON.parse(value);
        else frame[field] = value;
      }
      return frame;
    });
}

const message = (content = 'hi', extra = {}) => ({
  messages: [{ role: 'user', content, messageId: 'msg-1' }],
  ...extra
});
const SSE = 'text/event-stream';
const waitFor = async (probe, what) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

let originalPrepare;
let originalRun;

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-post-stream-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  configCache.setCacheEntry('config/workflows.json', []);
  originalPrepare = ChatService.prototype.prepareChatRequest;
  originalRun = ChatService.prototype.runTurn;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = USER;
    next();
  });
  registerSessionRoutes(app, {
    getLocalizedError: async code => `localized:${code}`,
    DEFAULT_TIMEOUT: 5000
  });
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  port = server.address().port;
});

afterAll(async () => {
  ChatService.prototype.prepareChatRequest = originalPrepare;
  ChatService.prototype.runTurn = originalRun;
  await new Promise(resolve => server.close(resolve));
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

beforeEach(() => {
  turn = defaultTurn();
  published.length = 0;
  remote.clear();
  configCache.setCacheEntry('config/platform.json', {
    chats: { enabled: true },
    anonymousAuth: { enabled: true },
    aiAcknowledgement: { enabled: false }
  });
  ChatService.prototype.prepareChatRequest = async () => ({
    success: true,
    data: {
      app: { id: 'chat' },
      model: { id: 'gpt-4o' },
      llmMessages: [{ role: 'user', content: 'x' }],
      tools: []
    }
  });
  ChatService.prototype.runTurn = function (params) {
    return playTurn(params);
  };
});

describe('without Accept: text/event-stream the POST is unchanged', () => {
  test('answers the same JSON body, and the frames go to the GET stream', async () => {
    // A GET held by another worker: the turn's frames are relayed over the bus.
    remote.add('sse:chat-json');
    const res = await post('chat-json', message());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.text).toBe('{"status":"streaming","chatId":"chat-json"}');
    const relayed = published.filter(p => p.type === 'sse:event');
    expect(relayed.map(p => p.payload.envelope.type)).toEqual(
      expect.arrayContaining(['run/started', 'step/delta', 'tool/progress', 'run/ended'])
    );
  });

  test.each([
    ['prefers JSON', 'application/json, text/plain, */*'],
    ['names only text/*', 'text/*'],
    ['ranks the stream below JSON', 'text/event-stream;q=0.1, application/json'],
    ['refuses the stream', 'text/event-stream;q=0, */*']
  ])('an Accept header that %s keeps the JSON answer', async (_what, accept) => {
    const res = await post(`chat-json-${_what.replace(/\W/g, '')}`, message(), { accept });
    expect(res.headers['content-type']).toMatch(/^application\/json/);
  });
});

describe('with Accept: text/event-stream', () => {
  test('streams the turn on the POST and nothing crosses the bus', async () => {
    const res = await post('chat-stream', message(), { accept: SSE });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['x-accel-buffering']).toBe('no');
    const frames = framesOf(res.text);
    expect(frames[0].event).toBe('stream/connected');
    expect(frames.map(f => f.data.seq)).toEqual(frames.map((_, i) => i + 1));
    const runId = turn.calls[0].runId;
    const types = frames.map(f => `${f.data.runId === runId ? 'turn' : f.data.runId}:${f.event}`);
    expect(types).toEqual(
      expect.arrayContaining([
        'turn:run/started',
        'turn:step/delta',
        'turn:tool/progress',
        'wf-exec-1:run/started',
        'wf-exec-1:run/ended',
        'turn:run/ended'
      ])
    );
    expect(types.at(-1)).toBe('turn:run/ended');
    const text = frames
      .filter(f => f.event === 'step/delta' && f.data.data.kind === 'text')
      .map(f => f.data.data.content)
      .join('');
    expect(text).toBe('Hello');
    // E3: frames of a run carry an SSE id with the run frame counter.
    const delta = frames.find(f => f.event === 'step/delta');
    expect(delta.id).toBe(`${runId}:${delta.data.rseq}`);
    expect(published.filter(p => p.type === 'sse:event')).toHaveLength(0);
    // No presence lookup either.
    expect(postStreams.has('chat-stream')).toBe(false);
  });

  test('a GET on the same chat in another worker gets every frame too', async () => {
    // A second tab, or a re-attach while the POST socket is half-open.
    remote.add('sse:chat-fanout-remote');
    const res = await post('chat-fanout-remote', message(), { accept: SSE });
    const runId = turn.calls[0].runId;
    expect(framesOf(res.text).at(-1).event).toBe('run/ended');
    const relayed = published
      .filter(p => p.type === 'sse:event')
      .map(
        p => `${p.payload.envelope.runId === runId ? 'turn' : 'other'}:${p.payload.envelope.type}`
      );
    expect(relayed).toEqual(expect.arrayContaining(['turn:run/started', 'turn:step/delta']));
    expect(relayed.at(-1)).toBe('turn:run/ended');
  });

  test('a GET on the same chat in this worker gets every frame too', async () => {
    const written = [];
    const entry = {
      lastActivity: new Date(),
      response: { write: chunk => written.push(chunk), end: () => {} }
    };
    clients.set('chat-fanout-local', entry);
    try {
      const res = await post('chat-fanout-local', message(), { accept: SSE });
      expect(framesOf(res.text).at(-1).event).toBe('run/ended');
      const events = written.filter(w => w.startsWith('event: ')).map(w => w.slice(7, -1));
      expect(events).toEqual(expect.arrayContaining(['run/started', 'step/delta']));
      expect(events.at(-1)).toBe('run/ended');
      expect(published.filter(p => p.type === 'sse:event')).toHaveLength(0);
    } finally {
      clients.delete('chat-fanout-local');
    }
  });

  test('during the turn the chat has a client and /status says it is processing', async () => {
    let during = null;
    ChatService.prototype.runTurn = async function (params) {
      // Workflows a tool launches decide on this whether to stash their finish.
      const connected = hasChatClient(params.chatId);
      activeRequests.set(params.chatId, new AbortController());
      const status = await getJson(`/api/apps/chat/chat/${params.chatId}/status`);
      activeRequests.delete(params.chatId);
      during = { connected, status };
      return playTurn(params);
    };
    await post('chat-status', message(), { accept: SSE });
    expect(during.connected).toBe(true);
    expect(during.status.body).toMatchObject({ active: true, processing: true });
    expect(during.status.body.lastActivity).toBeTruthy();
    expect(hasChatClient('chat-status')).toBe(false);
  });

  test('the turn is told whether its reader is still there', async () => {
    let connectedDuringTurn = null;
    ChatService.prototype.runTurn = async function (params) {
      connectedDuringTurn = params.persistence.clientConnected();
      return playTurn(params);
    };
    await post('chat-reader', message(), { accept: SSE });
    expect(connectedDuringTurn).toBe(true);
  });

  test('a preparation failure is the failed run, then the end', async () => {
    ChatService.prototype.prepareChatRequest = async () => ({
      success: false,
      error: { code: 'MODEL_NOT_FOUND' }
    });
    const res = await post('chat-prep-fail', message(), { accept: SSE });
    expect(res.headers['content-type']).toBe('text/event-stream');
    const events = framesOf(res.text).map(f => f.event);
    expect(events).toEqual(['stream/connected', 'run/started', 'stream/error', 'run/ended']);
    expect(framesOf(res.text)[2].data.data.code).toBe('MODEL_NOT_FOUND');
  });

  test('a refusal after the commit point is stream/error with its code, then run/ended', async () => {
    // Refused before the run started (`admitTurnProjects`): no frames of its own.
    const refusal = { message: 'The chat moved', code: 'CHAT_CONTAINER_CHANGED' };
    ChatService.prototype.runTurn = async params => {
      turn.calls.push(params);
      return { status: 'error', refusal };
    };
    const res = await post('chat-late-refusal', message(), { accept: SSE });
    expect(res.status).toBe(200);
    const frames = framesOf(res.text);
    expect(frames.map(f => f.event)).toEqual(['stream/connected', 'stream/error', 'run/ended']);
    const runId = turn.calls[0].runId;
    expect(frames[1].data).toMatchObject({ runId });
    expect(frames[1].data.data).toMatchObject({
      code: 'CHAT_CONTAINER_CHANGED',
      message: 'The chat moved',
      details: { status: 409 }
    });
    expect(frames[2].data).toMatchObject({ runId, data: { status: 'error' } });
  });

  test('a refusal the turn already streamed is not told twice', async () => {
    // Refused at persistence (`settleUserTurn`): ChatService emitted the failed run.
    const refusal = { message: 'The chat moved', code: 'CHAT_CONTAINER_CHANGED' };
    ChatService.prototype.runTurn = async params => {
      const stream = new RunStreamEmitter({ streamId: params.chatId, runId: params.runId });
      stream.emit('stream/error', refusal);
      stream.emit('run/ended', { status: 'error', finishReason: 'error', error: refusal });
      return { status: 'error', refusal };
    };
    const res = await post('chat-late-refusal-2', message(), { accept: SSE });
    const events = framesOf(res.text).map(f => f.event);
    expect(events).toEqual(['stream/connected', 'stream/error', 'run/ended']);
  });

  test('an unexpected failure after the commit point says nothing about itself', async () => {
    ChatService.prototype.runTurn = async () => {
      throw new Error('db password is hunter2');
    };
    const res = await post('chat-late-crash', message(), { accept: SSE });
    const frames = framesOf(res.text);
    expect(frames.at(-2).data.data.code).toBe('INTERNAL_ERROR');
    expect(frames.at(-1).data.data.status).toBe('error');
    expect(res.text).not.toContain('hunter2');
  });

  test('a late 5xx is told like its problem+json: code kept, unsafe message hidden', async () => {
    ChatService.prototype.runTurn = async () => {
      throw new ServiceError('PROVIDER_ERROR', 'connect ECONNREFUSED 10.0.0.7:443', {
        status: 502
      });
    };
    const res = await post('chat-late-5xx', message(), { accept: SSE });
    const error = framesOf(res.text).find(f => f.event === 'stream/error').data.data;
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { status: 502 } });
    expect(error.message).toBeTruthy();
    expect(res.text).not.toContain('ECONNREFUSED');
  });

  test('a late failure of an older turn never lands on the newer turn’s stream', async () => {
    let failA;
    const aFailed = new Promise(resolve => {
      failA = resolve;
    });
    ChatService.prototype.runTurn = async function (params) {
      turn.calls.push(params);
      if (turn.calls.length === 1) {
        await aFailed;
        throw new Error('turn A broke');
      }
      // B is the chat's POST stream now: let A fail, then play B.
      failA();
      await new Promise(resolve => setTimeout(resolve, 30));
      return playTurn(params);
    };
    const a = post('chat-overlap', message(), { accept: SSE });
    await waitFor(() => turn.calls.length === 1, 'turn A');
    const b = await post('chat-overlap', message('again'), { accept: SSE });
    const bEvents = framesOf(b.text).map(f => f.event);
    expect(bEvents).not.toContain('stream/error');
    expect(bEvents.at(-1)).toBe('run/ended');
    const aEvents = framesOf((await a).text).map(f => f.event);
    expect(aEvents).toEqual(['stream/connected']);
  });

  test('closing a temporary chat’s POST aborts its turn', async () => {
    let release;
    turn.hold = new Promise(resolve => {
      release = resolve;
    });
    const res = await post('chat-temp-close', message('hi', { ephemeral: true }), {
      accept: SSE,
      onFirstChunk: req => setTimeout(() => req.destroy(), 20)
    });
    expect(res.aborted || res.status === 200).toBe(true);
    await waitFor(() => turn.aborted, 'the abort');
    expect(normalizeAbortCause(turn.aborted)).toMatchObject({ kind: 'client_disconnected' });
    release();
    await waitFor(() => !postStreams.has('chat-temp-close'), 'the sink to go');
  });

  test('closing a kept chat’s POST leaves its turn running', async () => {
    let release;
    let finished = false;
    turn.hold = new Promise(resolve => {
      release = resolve;
    });
    ChatService.prototype.runTurn = async function (params) {
      const result = await playTurn(params);
      finished = true;
      return result;
    };
    await post('chat-kept-close', message(), {
      accept: SSE,
      onFirstChunk: req => setTimeout(() => req.destroy(), 20)
    });
    await waitFor(() => !postStreams.has('chat-kept-close'), 'the sink to go');
    expect(turn.aborted).toBeNull();
    expect(finished).toBe(false);
    release();
    await waitFor(() => finished, 'the turn to finish');
    expect(turn.aborted).toBeNull();
  });
});

describe('openChatPostStream', () => {
  test('a response already gone is not registered and leaves another POST in place', () => {
    const other = { response: {}, lastActivity: new Date(), seq: 0, endedRuns: new Set() };
    postStreams.set('chat-dead', other);
    try {
      const handle = openChatPostStream({
        req: {},
        res: { destroyed: true },
        chatId: 'chat-dead'
      });
      expect(postStreams.get('chat-dead')).toBe(other);
      expect(handle.isOpen()).toBe(false);
      expect(handle.write({ type: 'run/ended', runId: 'r' })).toBe(false);
    } finally {
      postStreams.delete('chat-dead');
    }
  });
});

describe('refusals before the commit point are problem+json in both modes', () => {
  const modes = [
    ['json', undefined],
    ['stream', SSE]
  ];

  test.each(modes)('%s: 400 CLIENT_HISTORY_NOT_ALLOWED', async (_mode, accept) => {
    const res = await post(
      `chat-history-${_mode}`,
      {
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' }
        ]
      },
      { accept }
    );
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.parse(res.text).code).toBe('CLIENT_HISTORY_NOT_ALLOWED');
    expect(turn.calls).toHaveLength(0);
  });

  test.each(modes)('%s: 400 VALIDATION_FAILED', async (_mode, accept) => {
    const res = await post(`chat-invalid-${_mode}`, { nope: true }, { accept });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.parse(res.text).code).toBe('VALIDATION_FAILED');
  });

  test.each(modes)('%s: 428 AI_ACKNOWLEDGEMENT_REQUIRED', async (_mode, accept) => {
    configCache.setCacheEntry('config/platform.json', {
      chats: { enabled: true },
      anonymousAuth: { enabled: true },
      aiAcknowledgement: { enabled: true, enforce: true, requiredVersion: 1 }
    });
    const res = await post(`chat-ack-${_mode}`, message(), { accept });
    expect(res.status).toBe(428);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.parse(res.text).code).toBe('AI_ACKNOWLEDGEMENT_REQUIRED');
  });

  test.each(modes)('%s: 503 CHAT_STORAGE_UNAVAILABLE', async (_mode, accept) => {
    await shutdownStorageBootstrap();
    try {
      const res = await post(`chat-nostore-${_mode}`, message(), { accept });
      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(JSON.parse(res.text).code).toBe('CHAT_STORAGE_UNAVAILABLE');
    } finally {
      await bootstrapStorage({
        storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
      });
    }
  });
});

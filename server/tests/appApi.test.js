import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';

/**
 * App API routes (`/api/v1`): OpenAI-shaped chat completions against an app,
 * streamed and not, attachments, stored conversations, and the errors a
 * caller can run into. The chat pipeline is a fake that plays the frames a
 * real turn would emit through the injected emitter.
 */

const apps = [
  { id: 'chat', name: 'Chat', tools: [] },
  { id: 'onehot', name: 'One shot', sendChatHistory: false }
];
let platform;
let features;
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => platform,
    getFeatures: () => features,
    getAppsForUser: async user => ({
      data: user.id === 'nobody' ? [] : apps
    })
  },
  resolveEnvVarsInObject: value => value
}));

// authRequired stand-in: "Bearer alice" and "Bearer bob" authenticate; others
// pass through without a user (anonymous access is off in the test platform).
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, _res, next) => {
    const header = req.headers.authorization || '';
    const name = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (name === 'alice' || name === 'bob') {
      req.user = {
        id: name,
        groups: ['users'],
        permissions: { apps: new Set(['*']), models: new Set(['*']) }
      };
    }
    next();
  }
}));
jest.unstable_mockModule('../utils/authorization.js', () => ({
  isAnonymousAccessAllowed: () => false,
  enhanceUserWithPermissions: user => user
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../utils.js', () => ({
  getApiKeyForModel: jest.fn(),
  getErrorDetails: jest.fn(() => ({})),
  logInteraction: jest.fn(async () => {}),
  trackSession: jest.fn(),
  logNewSession: jest.fn(async () => {}),
  resolveModelId: jest.fn(id => id)
}));
jest.unstable_mockModule('../telemetry/ActivityTracker.js', () => ({
  default: { recordActivity: jest.fn() }
}));
jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null,
  readFacet: () => null
}));
jest.unstable_mockModule('../sse.js', () => ({ activeRequests: new Map() }));

// Chat persistence: a fake repository with one stored chat owned by alice.
const storedMessages = new Map([
  [
    'chat-1',
    [
      { id: 'm1', role: 'user', content: 'Earlier question' },
      { id: 'm2', role: 'assistant', content: 'Earlier answer' }
    ]
  ]
]);
const repository = {
  getChat: async chatId =>
    chatId === 'chat-1'
      ? { id: 'chat-1', ownerId: 'alice', appId: 'chat', identityMode: 'full' }
      : null,
  getMessages: async chatId => ({ version: 1, messages: storedMessages.get(chatId) || [] })
};
jest.unstable_mockModule('../services/chat/ChatRepository.js', () => ({
  getChatRepository: () => repository,
  isPersistableChatId: id => /^[A-Za-z0-9._-]+$/.test(id),
  normalizeChatSettings: settings => settings
}));
let persistenceActive = true;
jest.unstable_mockModule('../services/chat/chatPersistence.js', () => ({
  isChatPersistenceActive: () => persistenceActive
}));
jest.unstable_mockModule('../services/loop/RunLog.js', () => ({
  default: { identityMode: () => 'full' },
  newRunId: kind => `${kind}-run-1`
}));
jest.unstable_mockModule('../services/loop/runIdentity.js', () => ({
  resolvePrincipal: async user => ({ id: user.id, mode: 'full' }),
  isAnonymousUser: user => !user || user.id === 'anonymous',
  isAdminUser: () => false
}));
// The route's default ChatService is replaced per test; keep its import graph
// (adapters, request builder, …) out of this suite.
jest.unstable_mockModule('../services/chat/ChatService.js', () => ({ default: {} }));
jest.unstable_mockModule('../services/loop/LLMClient.js', () => ({
  usageToOpenAI: usage => ({
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens
  })
}));

const { default: registerAppApiRoutes } = await import('../routes/appApi.js');
const { ApiAttachmentStore } = await import('../services/api/attachmentStore.js');

/** A ChatService double: prepareChatRequest echoes what it got, runTurn plays a scripted answer. */
function fakeChatService({
  answer = 'Hello from the app',
  usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  outcome
} = {}) {
  const calls = { prepare: [], run: [] };
  return {
    calls,
    prepareChatRequest: jest.fn(async params => {
      calls.prepare.push(params);
      if (params.appId === 'broken')
        return { success: false, error: { code: 'modelAccessDenied' } };
      return {
        success: true,
        data: {
          app: { id: params.appId },
          model: { id: params.modelId || 'gpt-test' },
          llmMessages: params.messages,
          tools: [],
          maxTokens: 4000
        }
      };
    }),
    runTurn: jest.fn(async params => {
      calls.run.push(params);
      const { emitter } = params;
      if (outcome) return outcome;
      emitter.emit(SSE_V2_EVENTS.RUN_STARTED, { kind: 'chat', refs: { chatId: params.chatId } });
      for (const piece of answer.match(/.{1,6}/g) || []) {
        emitter.emit(SSE_V2_EVENTS.STEP_DELTA, { step: 0, kind: 'text', content: piece });
      }
      emitter.emit(SSE_V2_EVENTS.RUN_ENDED, {
        status: 'completed',
        finishReason: 'stop',
        usage: { ...usage }
      });
      return {
        runId: params.runId,
        status: 'completed',
        content: answer,
        finishReason: 'stop',
        usage,
        messages: []
      };
    })
  };
}

function buildApp(chatService, attachmentStore) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  registerAppApiRoutes(app, {
    chatService,
    getLocalizedError: async key => `localized:${key}`,
    DEFAULT_TIMEOUT: 1000,
    attachmentStore
  });
  return app;
}

function sseFrames(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(line => {
      expect(line.startsWith('data: ')).toBe(true);
      const payload = line.slice(6);
      return payload === '[DONE]' ? '[DONE]' : JSON.parse(payload);
    });
}

const asAlice = req => req.set('Authorization', 'Bearer alice');
const userMessage = (content, extra = {}) => ({ role: 'user', content, ...extra });

beforeEach(() => {
  platform = { defaultLanguage: 'en', auth: {} };
  features = {};
  persistenceActive = true;
});

describe('POST /api/v1/apps/:appId/chat/completions', () => {
  it('requires authentication and an app the caller may use', async () => {
    const app = buildApp(fakeChatService());
    const anon = await request(app)
      .post('/api/v1/apps/chat/chat/completions')
      .send({ messages: [userMessage('hi')] });
    expect(anon.status).toBe(401);
    const missing = await asAlice(request(app).post('/api/v1/apps/nope/chat/completions')).send({
      messages: [userMessage('hi')]
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('APP_NOT_FOUND');
    const hidden = await request(app)
      .post('/api/v1/apps/chat/chat/completions')
      .set('Authorization', 'Bearer alice')
      .send({ messages: [] });
    expect(hidden.status).toBe(400);
  });

  it('answers in OpenAI shape and runs the app pipeline headlessly with the conversation', async () => {
    const service = fakeChatService();
    const app = buildApp(service);
    const res = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      messages: [
        userMessage('first'),
        { role: 'assistant', content: 'reply' },
        userMessage('Say hello')
      ],
      variables: { tone: 'formal' },
      temperature: 0.3,
      model: 'gpt-override'
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-override',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from the app' },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
    expect(res.body.id).toMatch(/^chatcmpl-/);
    expect(res.body.chat_id).toBeUndefined();

    const prep = service.calls.prepare[0];
    expect(prep).toMatchObject({
      appId: 'chat',
      modelId: 'gpt-override',
      temperature: 0.3,
      language: 'en'
    });
    expect(prep.user.id).toBe('alice');
    expect(prep.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'Say hello', variables: { tone: 'formal' } }
    ]);
    // Ephemeral: the chat id cannot be stored, and nothing is persisted.
    expect(prep.chatId).toMatch(/^api:/);
    const run = service.calls.run[0];
    expect(run).toMatchObject({
      streaming: true,
      headless: true,
      persistence: null,
      chatId: prep.chatId,
      timeoutMs: 1000
    });
    expect(run.emitter).toBeDefined();
  });

  it('streams OpenAI chunks ending with [DONE], usage on request', async () => {
    const app = buildApp(fakeChatService({ answer: 'Streamed answer text' }));
    const res = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions'))
      .send({
        messages: [userMessage('go')],
        stream: true,
        stream_options: { include_usage: true }
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (text += chunk));
        response.on('end', () => callback(null, text));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const frames = sseFrames(res.body);
    expect(frames.at(-1)).toBe('[DONE]');
    const chunks = frames.filter(f => f !== '[DONE]');
    expect(chunks[0].object).toBe('chat.completion.chunk');
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    const text = chunks
      .filter(c => c.choices[0]?.delta?.content)
      .map(c => c.choices[0].delta.content)
      .join('');
    expect(text).toBe('Streamed answer text');
    const finish = chunks.find(c => c.choices[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe('stop');
    expect(chunks.at(-1).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    });
    expect(chunks.at(-1).choices).toEqual([]);
  });

  it('reports a failed turn as an HTTP error, or in-band when streaming', async () => {
    const failing = fakeChatService({
      outcome: {
        status: 'error',
        content: '',
        finishReason: 'error',
        errorInfo: {
          code: 'CONTEXT_WINDOW_EXCEEDED',
          message: 'Too long',
          isContextWindowError: true
        }
      }
    });
    const app = buildApp(failing);
    const plain = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      messages: [userMessage('x')]
    });
    expect(plain.status).toBe(400);
    expect(plain.body).toEqual({ error: 'Too long', code: 'CONTEXT_WINDOW_EXCEEDED' });

    const streamed = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions'))
      .send({ messages: [userMessage('x')], stream: true })
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.on('data', chunk => (text += chunk));
        response.on('end', () => callback(null, text));
      });
    expect(streamed.status).toBe(200);
    const frames = sseFrames(streamed.body);
    expect(frames[0].error).toMatchObject({ message: 'Too long', code: 'CONTEXT_WINDOW_EXCEEDED' });
    expect(frames.at(-1)).toBe('[DONE]');
  });

  it('maps request preparation failures and refuses system messages', async () => {
    const app = buildApp(fakeChatService());
    apps.push({ id: 'broken', name: 'Broken' });
    try {
      const denied = await asAlice(request(app).post('/api/v1/apps/broken/chat/completions')).send({
        messages: [userMessage('x')]
      });
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({
        error: 'localized:modelAccessDenied',
        code: 'modelAccessDenied'
      });
    } finally {
      apps.pop();
    }
    const system = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      messages: [{ role: 'system', content: 'be terse' }, userMessage('x')]
    });
    expect(system.status).toBe(400);
    expect(system.body.code).toBe('SYSTEM_MESSAGE_NOT_ALLOWED');
    const notUser = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      messages: [userMessage('x'), { role: 'assistant', content: 'y' }]
    });
    expect(notUser.body.code).toBe('LAST_MESSAGE_NOT_USER');
  });

  it('continues a stored conversation with chat_id and records the turn', async () => {
    const service = fakeChatService();
    const app = buildApp(service);
    const res = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      chat_id: 'chat-1',
      messages: [userMessage('And now?')]
    });
    expect(res.status).toBe(200);
    expect(res.body.chat_id).toBe('chat-1');
    const prep = service.calls.prepare[0];
    expect(prep.chatId).toBe('chat-1');
    expect(prep.messages).toEqual([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'And now?' }
    ]);
    const run = service.calls.run[0];
    expect(run.persistence).toMatchObject({
      repository,
      ownerId: 'alice',
      identityMode: 'full',
      content: 'And now?',
      attachments: []
    });

    // Only the new message may be posted for a stored chat.
    const history = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      chat_id: 'chat-1',
      messages: [userMessage('a'), { role: 'assistant', content: 'b' }, userMessage('c')]
    });
    expect(history.status).toBe(400);
    expect(history.body.code).toBe('CLIENT_HISTORY_NOT_ALLOWED');

    // Somebody else's chat is not found; a fresh id starts a new stored chat.
    const bob = await request(app)
      .post('/api/v1/apps/chat/chat/completions')
      .set('Authorization', 'Bearer bob')
      .send({ chat_id: 'chat-1', messages: [userMessage('x')] });
    expect(bob.status).toBe(404);
    const fresh = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      chat_id: 'brand-new',
      messages: [userMessage('x')]
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.chat_id).toBe('brand-new');
    expect(service.calls.run.at(-1).persistence.ownerId).toBe('alice');

    // An app that opted out of history stays a one-shot prompt.
    storedMessages.set('one-1', [{ id: 'x', role: 'user', content: 'old' }]);
    await asAlice(request(app).post('/api/v1/apps/onehot/chat/completions')).send({
      chat_id: 'one-1',
      messages: [userMessage('new')]
    });
    expect(service.calls.prepare.at(-1).messages).toEqual([{ role: 'user', content: 'new' }]);

    persistenceActive = false;
    const off = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      chat_id: 'chat-2',
      messages: [userMessage('x')]
    });
    expect(off.status).toBe(400);
    expect(off.body.code).toBe('CHAT_PERSISTENCE_UNAVAILABLE');
  });

  it('passes inline images and uploaded attachments to the app as imageData / fileData', async () => {
    const service = fakeChatService();
    const store = new ApiAttachmentStore({ documents: null, blobs: null });
    const app = buildApp(service, store);
    const meta = await store.put({
      ownerId: 'alice',
      fileName: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Notes\nhello')
    });
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const res = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      messages: [
        userMessage(
          [
            { type: 'text', text: 'Look at this' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
            {
              type: 'file',
              file: {
                filename: 'data.csv',
                file_data: `data:text/csv;base64,${Buffer.from('a,b\n1,2').toString('base64')}`
              }
            }
          ],
          { attachments: [meta.id] }
        )
      ]
    });
    expect(res.status).toBe(200);
    const last = service.calls.prepare[0].messages.at(-1);
    expect(last.content).toBe('Look at this');
    expect(last.imageData).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'image-1.png',
        fileType: 'image/png',
        base64: `data:image/png;base64,${png}`
      })
    ]);
    expect(last.fileData.map(f => [f.fileName, f.fileType, f.content])).toEqual([
      ['data.csv', 'text/csv', 'a,b\n1,2'],
      ['notes.md', 'text/markdown', '# Notes\nhello']
    ]);

    const strangers = await request(app)
      .post('/api/v1/apps/chat/chat/completions')
      .set('Authorization', 'Bearer bob')
      .send({
        messages: [userMessage('x', { attachments: [meta.id] })]
      });
    expect(strangers.status).toBe(404);
    expect(strangers.body.code).toBe('ATTACHMENT_NOT_FOUND');

    const remote = await asAlice(request(app).post('/api/v1/apps/chat/chat/completions')).send({
      messages: [
        userMessage([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }])
      ]
    });
    expect(remote.status).toBe(400);
    expect(remote.body.code).toBe('IMAGE_URL_NOT_SUPPORTED');
  });
});

describe('POST /api/v1/attachments', () => {
  it('stores an upload for the caller and rejects unsupported or missing files', async () => {
    const store = new ApiAttachmentStore({ documents: null, blobs: null });
    const app = buildApp(fakeChatService(), store);
    const res = await asAlice(request(app).post('/api/v1/attachments')).attach(
      'file',
      Buffer.from('hello world'),
      {
        filename: 'hello.txt',
        contentType: 'text/plain'
      }
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: 'attachment',
      filename: 'hello.txt',
      mime_type: 'text/plain',
      size: 11
    });
    expect(res.body.id).toMatch(/^att_/);
    expect((await store.get(res.body.id, 'alice')).data.toString()).toBe('hello world');

    const none = await asAlice(request(app).post('/api/v1/attachments')).field('other', 'x');
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('NO_FILE');

    const zip = await asAlice(request(app).post('/api/v1/attachments')).attach(
      'file',
      Buffer.from('PK'),
      {
        filename: 'a.zip',
        contentType: 'application/zip'
      }
    );
    expect(zip.status).toBe(415);

    const anon = await request(app)
      .post('/api/v1/attachments')
      .attach('file', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(anon.status).toBe(401);
  });
});

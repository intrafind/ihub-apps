import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * HTTP surface of the A2A endpoint (routes/mcpServer.js): the public and
 * authenticated Agent Cards, the per-skill endpoints, the X-API-Key shim,
 * JSON-RPC over POST and the SSE framing of message/stream.
 */

const apps = [
  { id: 'chat', name: { en: 'Chat' }, description: 'General chat' },
  { id: 'summary', name: 'Summarizer', description: 'Summarize' }
];
let platform;
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => platform,
    getApps: () => ({ data: apps }),
    getWorkflows: () => ({ data: [] }),
    getUI: () => ({ data: { title: 'iHub' } })
  },
  resolveEnvVarsInObject: value => value
}));

// mcpAuth stand-in: "Bearer good" (or the shimmed X-API-Key) authenticates
// alice with the app scope; anything else is a 401.
const seenAuthHeaders = [];
jest.unstable_mockModule('../../middleware/mcpAuth.js', () => ({
  default: (req, res, next) => {
    seenAuthHeaders.push(req.headers.authorization || null);
    if (req.headers.authorization === 'Bearer good') {
      req.user = {
        id: 'alice',
        scopes: ['mcp:apps:invoke'],
        permissions: { apps: new Set(['*']), workflows: new Set() }
      };
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Bearer realm="ihub-mcp"');
    return res.status(401).json({ error: 'invalid_token' });
  },
  MCP_METHOD_SCOPES: {}
}));
jest.unstable_mockModule('../../services/mcp/McpServerService.js', () => ({
  buildMcpServer: jest.fn()
}));
const invokeApp = jest.fn();
jest.unstable_mockModule('../../services/mcp/appInvoker.js', () => ({
  invokeApp,
  invokeAppNonStreaming: jest.fn()
}));
jest.unstable_mockModule('../../toolLoader.js', () => ({
  runTool: jest.fn(),
  loadConfiguredTools: jest.fn(async () => [])
}));
jest.unstable_mockModule('../../services/mcp/permissions.js', () => ({
  getVisibleToolIds: jest.fn(async () => new Set()),
  toolVisibleInSet: () => false
}));
jest.unstable_mockModule('../../utils/versionHelper.js', () => ({ getAppVersion: () => '1.2.3' }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../../storage/bootstrap.js', () => ({
  getStorage: () => null,
  readFacet: () => null
}));
jest.unstable_mockModule('../../clusterBus.js', () => ({
  publish: jest.fn(() => false),
  subscribe: jest.fn(() => () => {})
}));

const { default: registerMcpServerRoutes } = await import('../../routes/mcpServer.js');
const { A2aTaskStore, setA2aTaskStoreForTests } =
  await import('../../services/mcp/a2aTaskStore.js');

const app = express();
registerMcpServerRoutes(app);

const message = (text, metadata) => ({
  kind: 'message',
  role: 'user',
  messageId: 'm1',
  parts: [{ kind: 'text', text }],
  ...(metadata ? { metadata } : {})
});

beforeEach(() => {
  platform = {
    defaultLanguage: 'en',
    mcpServer: {
      enabled: true,
      publicUrl: 'https://ihub.example/',
      transports: { streamableHttp: { enabled: true }, sse: { enabled: false } },
      expose: { tools: false, apps: true, workflows: false },
      a2a: { enabled: true }
    }
  };
  setA2aTaskStoreForTests(new A2aTaskStore({ documents: null, relayCancel: false }));
  invokeApp.mockReset();
  invokeApp.mockImplementation(async ({ onTextDelta }) => {
    onTextDelta?.('Hi ');
    onTextDelta?.('there');
    return { text: 'Hi there', result: {} };
  });
  seenAuthHeaders.length = 0;
});

describe('Agent Card', () => {
  it('is public at the well-known and gateway-scoped paths, without skills', async () => {
    for (const path of ['/.well-known/agent-card.json', '/a2a/.well-known/agent-card.json']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        url: 'https://ihub.example/a2a',
        protocolVersion: '0.3.0',
        version: '1.2.3',
        skills: []
      });
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(seenAuthHeaders).toEqual([]);
  });

  it("lists the caller's skills when credentials are sent, as Bearer or X-API-Key", async () => {
    const bearer = await request(app)
      .get('/.well-known/agent-card.json')
      .set('Authorization', 'Bearer good');
    expect(bearer.status).toBe(200);
    expect(bearer.body.skills.map(s => s.id)).toEqual(['app__chat', 'app__summary']);

    const apiKey = await request(app).get('/.well-known/agent-card.json').set('X-API-Key', 'good');
    expect(apiKey.status).toBe(200);
    expect(apiKey.body.skills).toHaveLength(2);
    expect(seenAuthHeaders).toEqual(['Bearer good', 'Bearer good']);

    const bad = await request(app)
      .get('/.well-known/agent-card.json')
      .set('Authorization', 'Bearer nope');
    expect(bad.status).toBe(401);
  });

  it('serves a per-skill card bound to that skill', async () => {
    const res = await request(app)
      .get('/a2a/skills/app__summary/.well-known/agent-card.json')
      .set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://ihub.example/a2a/skills/app__summary');
    expect(res.body.skills.map(s => s.id)).toEqual(['app__summary']);

    const unknown = await request(app)
      .get('/a2a/skills/app__nope/.well-known/agent-card.json')
      .set('Authorization', 'Bearer good');
    expect(unknown.status).toBe(404);
  });

  it('is absent while A2A is disabled', async () => {
    platform.mcpServer.a2a.enabled = false;
    const card = await request(app).get('/.well-known/agent-card.json');
    expect(card.status).toBe(404);
    const rpc = await request(app)
      .post('/a2a')
      .set('Authorization', 'Bearer good')
      .send({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } });
    expect(rpc.status).toBe(404);
  });
});

describe('POST /a2a', () => {
  it('requires a bearer token (X-API-Key is accepted as one)', async () => {
    const anon = await request(app)
      .post('/a2a')
      .send({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } });
    expect(anon.status).toBe(401);

    const viaKey = await request(app)
      .post('/a2a')
      .set('X-API-Key', 'good')
      .send({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } });
    expect(viaKey.status).toBe(200);
    expect(viaKey.body.error.code).toBe(-32001);
  });

  it('answers message/send with the finished task', async () => {
    const res = await request(app)
      .post('/a2a')
      .set('Authorization', 'Bearer good')
      .send({
        jsonrpc: '2.0',
        id: 'r1',
        method: 'message/send',
        params: { message: message('hello', { skillId: 'app__chat' }) }
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 'r1' });
    expect(res.body.result.status.state).toBe('completed');
    expect(res.body.result.artifacts[0].parts[0].text).toBe('Hi there');
    expect(invokeApp.mock.calls[0][0].appId).toBe('chat');
  });

  it('routes a per-skill endpoint to its skill without metadata', async () => {
    const res = await request(app)
      .post('/a2a/skills/app__summary')
      .set('Authorization', 'Bearer good')
      .send({ jsonrpc: '2.0', id: 2, method: 'message/send', params: { message: message('x') } });
    expect(res.status).toBe(200);
    expect(res.body.result.status.state).toBe('completed');
    expect(invokeApp.mock.calls[0][0].appId).toBe('summary');
  });

  it('streams message/stream as SSE frames carrying JSON-RPC responses', async () => {
    const res = await request(app)
      .post('/a2a')
      .set('Authorization', 'Bearer good')
      .set('Accept', 'text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 'stream-1',
        method: 'message/stream',
        params: { message: message('hello', { skillId: 'app__chat' }) }
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (text += chunk));
        response.on('end', () => callback(null, text));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    const frames = res.body
      .split('\n\n')
      .filter(Boolean)
      .map(frame => {
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n');
        return JSON.parse(data);
      });
    expect(frames.length).toBeGreaterThanOrEqual(5);
    for (const frame of frames) expect(frame).toMatchObject({ jsonrpc: '2.0', id: 'stream-1' });
    expect(frames[0].result.kind).toBe('task');
    expect(frames.at(-1).result).toMatchObject({
      kind: 'status-update',
      final: true,
      status: { state: 'completed' }
    });
    const text = frames
      .map(f => f.result)
      .filter(e => e.kind === 'artifact-update')
      .flatMap(e => e.artifact.parts.map(p => p.text))
      .join('');
    expect(text).toBe('Hi there');
  });

  it('answers a message/stream that fails before streaming with a JSON error', async () => {
    const res = await request(app)
      .post('/a2a')
      .set('Authorization', 'Bearer good')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'message/stream',
        params: { message: message('hello', { skillId: 'app__nope' }) }
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe(-32602);
  });

  it('refuses message/stream inside a batch and still answers the rest', async () => {
    const res = await request(app)
      .post('/a2a')
      .set('Authorization', 'Bearer good')
      .send([
        { jsonrpc: '2.0', id: 1, method: 'message/stream', params: { message: message('x') } },
        { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'nope' } }
      ]);
    expect(res.status).toBe(200);
    expect(res.body[0].error.code).toBe(-32600);
    expect(res.body[1].error.code).toBe(-32001);
  });
});

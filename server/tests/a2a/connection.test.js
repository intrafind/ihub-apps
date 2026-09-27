import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * A2aAgentConnection against a scripted agent: `safeFetch` is replaced by a
 * router that answers the card URL, the token URL and JSON-RPC calls, and
 * records every request (URL, method, headers, body) that left iHub.
 */

const requests = [];
let handler;

jest.unstable_mockModule('../../services/mcp/safeFetch.js', () => ({
  assertSafeHost: jest.fn(async () => {}),
  safeFetch: jest.fn(async (url, init = {}, opts = {}) => {
    const entry = {
      url: String(url),
      method: init.method || 'GET',
      headers: Object.fromEntries(new Headers(init.headers || {})),
      body: init.body ? tryJson(init.body) : undefined,
      opts
    };
    requests.push(entry);
    return handler(entry);
  })
}));

jest.unstable_mockModule('../../services/CredentialService.js', () => ({
  default: { resolveSecret: ref => `secret-of-${ref}` }
}));

const { A2aAgentConnection } = await import('../../services/a2a/A2aAgentConnection.js');
const { a2aAgentConfigSchema } = await import('../../validators/a2aAgentConfigSchema.js');

function tryJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const CARD_URL = 'https://agent.example.com/.well-known/agent-card.json';
const RPC_URL = 'https://agent.example.com/a2a';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function sse(events) {
  const text = events.map(e => `id: 1\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function rpcOk(req, result) {
  return json({ jsonrpc: '2.0', id: req.body.id, result });
}

function card(overrides = {}) {
  return {
    name: 'Test agent',
    description: 'Answers questions',
    url: RPC_URL,
    protocolVersion: '0.3.0',
    version: '1.0.0',
    capabilities: { streaming: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [{ id: 'Ask Agent', name: 'Ask Agent', description: 'Ask it', tags: [] }],
    securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    ...overrides
  };
}

/** Route card fetches to `cardBody` and JSON-RPC calls to `rpc(method, req)`. */
function agentWith({ cardBody = card(), rpc }) {
  handler = req => {
    if (req.url === CARD_URL) return json(cardBody);
    if (req.url === RPC_URL) return rpc(req.body.method, req);
    return new Response('not found', { status: 404 });
  };
}

function connection(overrides = {}) {
  const config = a2aAgentConfigSchema.parse({
    id: 'agent',
    name: 'Agent',
    cardUrl: CARD_URL,
    ...overrides
  });
  return new A2aAgentConnection(config, { blockPrivateIps: true, allowedHosts: ['a.internal'] });
}

const agentMessage = text => ({
  kind: 'message',
  role: 'agent',
  messageId: 'm-agent',
  contextId: 'ctx-1',
  parts: [{ kind: 'text', text }]
});

function task(state, extra = {}) {
  return {
    kind: 'task',
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state, timestamp: '2026-09-27T00:00:00Z', ...(extra.status || {}) },
    ...(extra.artifacts ? { artifacts: extra.artifacts } : {})
  };
}

beforeEach(() => {
  requests.length = 0;
});

describe('Agent Card', () => {
  it('fetches, validates and caches the card through safeFetch with the SSRF policy', async () => {
    agentWith({ rpc: () => json({}) });
    const conn = connection();
    const first = await conn.getCard();
    const second = await conn.getCard();
    expect(first).toBe(second);
    expect(requests).toHaveLength(1);
    expect(requests[0].opts).toEqual({ allowHosts: ['a.internal'], blockPrivateIps: true });
    expect(conn.endpoint).toBe(RPC_URL);
    expect(conn.status()).toMatchObject({ connected: true, agentName: 'Test agent' });

    await conn.getCard({ force: true });
    expect(requests).toHaveLength(2);
  });

  it('reports a card without the essentials and remembers the failure', async () => {
    agentWith({ cardBody: { name: 'x' }, rpc: () => json({}) });
    const conn = connection();
    await expect(conn.getCard()).rejects.toMatchObject({ code: 'A2A_CARD_INVALID' });
    expect(conn.status()).toMatchObject({ connected: false, consecutiveFailures: 1 });
    // Not retried immediately: a dead agent must not slow down every turn.
    await expect(conn.getCard()).rejects.toThrow(/unavailable/);
    expect(requests).toHaveLength(1);
  });

  it('builds tool definitions from the skills', async () => {
    agentWith({ rpc: () => json({}) });
    const tools = await connection().listTools();
    expect(tools.map(t => t.id)).toEqual(['a2a__agent__ask_agent']);
    expect(await connection({ enabled: false }).listTools()).toEqual([]);
  });
});

describe('auth headers', () => {
  const send = async overrides => {
    agentWith({ rpc: (method, req) => rpcOk(req, agentMessage('ok')) });
    await connection(overrides).sendMessage({ skillId: 'Ask Agent', text: 'hi' });
    return requests.find(r => r.url === RPC_URL).headers;
  };

  it('sends an API key in the header the card names', async () => {
    const headers = await send({ auth: { type: 'apiKey', valueRef: 'lk' } });
    expect(headers['x-api-key']).toBe('secret-of-lk');
    expect(headers.authorization).toBeUndefined();
  });

  it('prefers a configured header name over the card', async () => {
    const headers = await send({ auth: { type: 'apiKey', headerName: 'X-Key', valueRef: 'lk' } });
    expect(headers['x-key']).toBe('secret-of-lk');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('falls back to X-API-Key when the card names no apiKey scheme', async () => {
    agentWith({
      cardBody: card({ securitySchemes: undefined }),
      rpc: (method, req) => rpcOk(req, agentMessage('ok'))
    });
    await connection({ auth: { type: 'apiKey', valueRef: 'lk' } }).sendMessage({
      skillId: 'Ask Agent',
      text: 'hi'
    });
    expect(requests.at(-1).headers['x-api-key']).toBe('secret-of-lk');
  });

  it('sends a bearer token', async () => {
    const headers = await send({ auth: { type: 'bearer', tokenRef: 'tk' } });
    expect(headers.authorization).toBe('Bearer secret-of-tk');
  });

  it('fetches an OAuth client-credentials token once and reuses it', async () => {
    const TOKEN_URL = 'https://auth.example.com/token';
    handler = req => {
      if (req.url === TOKEN_URL) return json({ access_token: 'at-1', expires_in: 3600 });
      if (req.url === CARD_URL) return json(card());
      return rpcOk(req, agentMessage('ok'));
    };
    const conn = connection({
      auth: { type: 'oauth', tokenUrl: TOKEN_URL, clientId: 'ihub', clientSecretRef: 'cs' }
    });
    await conn.sendMessage({ skillId: 'Ask Agent', text: 'one' });
    await conn.sendMessage({ skillId: 'Ask Agent', text: 'two' });
    const tokenCalls = requests.filter(r => r.url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toContain('grant_type=client_credentials');
    expect(tokenCalls[0].body).toContain('client_secret=secret-of-cs');
    for (const r of requests.filter(r => r.url !== TOKEN_URL)) {
      expect(r.headers.authorization).toBe('Bearer at-1');
    }
  });

  it('reports HTTP 401/403 as A2A_AUTH_FAILED', async () => {
    handler = req => (req.url === CARD_URL ? json(card()) : json({ error: 'nope' }, 401));
    await expect(
      connection().sendMessage({ skillId: 'Ask Agent', text: 'hi' })
    ).rejects.toMatchObject({ code: 'A2A_AUTH_FAILED' });
  });
});

describe('message/send', () => {
  it('sends the A2A 0.3 message shape and returns a Message reply directly', async () => {
    agentWith({ rpc: (method, req) => rpcOk(req, agentMessage('The implementation is great')) });
    const result = await connection().sendMessage({
      skillId: 'Ask Agent',
      text: 'Is it good?',
      data: { lang: 'en' },
      contextId: 'ctx-0'
    });
    expect(result).toEqual({
      text: 'The implementation is great',
      contextId: 'ctx-1',
      taskId: null,
      state: 'completed'
    });
    const { body } = requests.find(r => r.url === RPC_URL);
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'message/send' });
    expect(body.params.message).toMatchObject({
      kind: 'message',
      role: 'user',
      parts: [
        { kind: 'text', text: 'Is it good?' },
        { kind: 'data', data: { lang: 'en' } }
      ],
      contextId: 'ctx-0',
      metadata: { skillId: 'Ask Agent' }
    });
    expect(typeof body.params.message.messageId).toBe('string');
    expect(body.params.configuration).toEqual({
      blocking: true,
      acceptedOutputModes: ['text/plain', 'application/json']
    });
  });

  it('returns the artifacts of a completed task, data parts as JSON', async () => {
    agentWith({
      rpc: (method, req) =>
        rpcOk(
          req,
          task('completed', {
            artifacts: [
              { artifactId: 'a1', parts: [{ kind: 'text', text: 'Answer' }] },
              { artifactId: 'a2', parts: [{ kind: 'data', data: { score: 3 } }] }
            ]
          })
        )
    });
    const result = await connection().sendMessage({ skillId: 'Ask Agent', text: 'q' });
    expect(result.text).toBe('Answer\n\n{\n  "score": 3\n}');
    expect(result).toMatchObject({ taskId: 'task-1', contextId: 'ctx-1', state: 'completed' });
  });

  it('polls tasks/get until the task is final and reports progress', async () => {
    let polls = 0;
    agentWith({
      rpc: (method, req) => {
        if (method === 'message/send') return rpcOk(req, task('submitted'));
        polls++;
        if (polls < 3) {
          return rpcOk(
            req,
            task('working', {
              status: {
                message: {
                  kind: 'message',
                  role: 'agent',
                  messageId: 'p',
                  parts: [{ kind: 'text', text: `step ${polls}` }]
                }
              }
            })
          );
        }
        return rpcOk(
          req,
          task('completed', {
            artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: 'done' }] }]
          })
        );
      }
    });
    const progress = [];
    const result = await connection({ pollIntervalMs: 250 }).sendMessage({
      skillId: 'Ask Agent',
      text: 'q',
      onProgress: p => progress.push(p)
    });
    expect(result.text).toBe('done');
    expect(polls).toBe(3);
    const gets = requests.filter(r => r.body?.method === 'tasks/get');
    expect(gets.every(r => r.body.params.id === 'task-1')).toBe(true);
    expect(progress[0]).toEqual({ state: 'submitted' });
    expect(progress).toContainEqual({ state: 'working', message: 'step 1' });
  });

  it("returns the agent's question when the task needs input", async () => {
    agentWith({
      rpc: (method, req) =>
        rpcOk(
          req,
          task('input-required', {
            status: {
              message: {
                kind: 'message',
                role: 'agent',
                messageId: 'q',
                parts: [{ kind: 'text', text: 'Which year?' }]
              }
            }
          })
        )
    });
    const result = await connection().sendMessage({ skillId: 'Ask Agent', text: 'q' });
    expect(result).toMatchObject({ text: 'Which year?', state: 'input-required' });
  });

  it('throws A2A_TASK_FAILED with the status message of a failed task', async () => {
    agentWith({
      rpc: (method, req) =>
        rpcOk(
          req,
          task('failed', {
            status: {
              message: {
                kind: 'message',
                role: 'agent',
                messageId: 'f',
                parts: [{ kind: 'text', text: 'Quota exceeded' }]
              }
            }
          })
        )
    });
    await expect(
      connection().sendMessage({ skillId: 'Ask Agent', text: 'q' })
    ).rejects.toMatchObject({
      code: 'A2A_TASK_FAILED',
      message: 'Quota exceeded',
      state: 'failed'
    });
  });

  it('throws A2A_RPC_ERROR with the remote code for a JSON-RPC error', async () => {
    agentWith({
      rpc: (method, req) =>
        json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32602, message: 'Unknown skill' } })
    });
    await expect(
      connection().sendMessage({ skillId: 'Ask Agent', text: 'q' })
    ).rejects.toMatchObject({ code: 'A2A_RPC_ERROR', rpcCode: -32602 });
  });

  it('cancels the task and throws A2A_TIMEOUT when the agent takes too long', async () => {
    agentWith({
      rpc: (method, req) => {
        if (method === 'tasks/cancel') return rpcOk(req, task('canceled'));
        return rpcOk(req, task('working'));
      }
    });
    const started = Date.now();
    await expect(
      connection({ timeoutMs: 1000, pollIntervalMs: 250 }).sendMessage({
        skillId: 'Ask Agent',
        text: 'q'
      })
    ).rejects.toMatchObject({ code: 'A2A_TIMEOUT', taskId: 'task-1' });
    expect(Date.now() - started).toBeLessThan(3000);
    await new Promise(resolve => setTimeout(resolve, 20));
    const cancel = requests.find(r => r.body?.method === 'tasks/cancel');
    expect(cancel.body.params).toEqual({ id: 'task-1' });
  });
});

describe('message/stream', () => {
  const streamingCard = card({ capabilities: { streaming: true } });

  it('streams when the card supports it, joining artifact chunks until the final status', async () => {
    agentWith({
      cardBody: streamingCard,
      rpc: (method, req) => {
        expect(method).toBe('message/stream');
        expect(req.headers.accept).toBe('text/event-stream');
        const id = req.body.id;
        return sse([
          { jsonrpc: '2.0', id, result: task('submitted') },
          {
            jsonrpc: '2.0',
            id,
            result: {
              kind: 'status-update',
              taskId: 'task-1',
              contextId: 'ctx-1',
              status: {
                state: 'working',
                message: {
                  kind: 'message',
                  role: 'agent',
                  messageId: 's',
                  parts: [{ kind: 'text', text: 'Thinking' }]
                }
              },
              final: false
            }
          },
          {
            jsonrpc: '2.0',
            id,
            result: {
              kind: 'artifact-update',
              taskId: 'task-1',
              contextId: 'ctx-1',
              artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'Hi ' }] },
              append: false
            }
          },
          {
            jsonrpc: '2.0',
            id,
            result: {
              kind: 'artifact-update',
              taskId: 'task-1',
              contextId: 'ctx-1',
              artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'there' }] },
              append: true,
              lastChunk: true
            }
          },
          {
            jsonrpc: '2.0',
            id,
            result: {
              kind: 'status-update',
              taskId: 'task-1',
              contextId: 'ctx-1',
              status: { state: 'completed' },
              final: true
            }
          }
        ]);
      }
    });
    const progress = [];
    const result = await connection().sendMessage({
      skillId: 'Ask Agent',
      text: 'q',
      onProgress: p => progress.push(p)
    });
    expect(result).toEqual({
      text: 'Hi there',
      contextId: 'ctx-1',
      taskId: 'task-1',
      state: 'completed'
    });
    expect(progress).toContainEqual({ state: 'working', message: 'Thinking' });
    expect(requests.some(r => r.body?.method === 'message/send')).toBe(false);
  });

  it('accepts a single Message event (the cookbook agent over SSE)', async () => {
    agentWith({
      cardBody: streamingCard,
      rpc: (method, req) =>
        sse([{ jsonrpc: '2.0', id: req.body.id, result: agentMessage('Hello') }])
    });
    const result = await connection().sendMessage({ skillId: 'Ask Agent', text: 'q' });
    expect(result).toMatchObject({ text: 'Hello', contextId: 'ctx-1' });
  });

  it('fails the call on a final failed status', async () => {
    agentWith({
      cardBody: streamingCard,
      rpc: (method, req) =>
        sse([
          { jsonrpc: '2.0', id: req.body.id, result: task('submitted') },
          {
            jsonrpc: '2.0',
            id: req.body.id,
            result: {
              kind: 'status-update',
              taskId: 'task-1',
              contextId: 'ctx-1',
              status: { state: 'failed' },
              final: true
            }
          }
        ])
    });
    await expect(
      connection().sendMessage({ skillId: 'Ask Agent', text: 'q' })
    ).rejects.toMatchObject({ code: 'A2A_TASK_FAILED' });
  });

  it('polls tasks/get when the stream ends before the final event', async () => {
    agentWith({
      cardBody: streamingCard,
      rpc: (method, req) => {
        if (method === 'message/stream') {
          return sse([{ jsonrpc: '2.0', id: req.body.id, result: task('working') }]);
        }
        return rpcOk(
          req,
          task('completed', {
            artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: 'late' }] }]
          })
        );
      }
    });
    const result = await connection().sendMessage({ skillId: 'Ask Agent', text: 'q' });
    expect(result.text).toBe('late');
  });

  it("uses message/send when streaming is set to 'never'", async () => {
    agentWith({
      cardBody: streamingCard,
      rpc: (method, req) => rpcOk(req, agentMessage(`via ${method}`))
    });
    const result = await connection({ streaming: 'never' }).sendMessage({
      skillId: 'Ask Agent',
      text: 'q'
    });
    expect(result.text).toBe('via message/send');
  });
});

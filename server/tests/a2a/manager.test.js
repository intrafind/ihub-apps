import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * A2aClientManager: config diffing, tool aggregation, dispatch by tool id,
 * the (user, chat, agent) conversation memory and tool progress frames. The
 * agents are scripted through a mocked `safeFetch`.
 */

const requests = [];
const agents = {}; // host -> { card, reply(method, body) }

jest.unstable_mockModule('../../services/mcp/safeFetch.js', () => ({
  assertSafeHost: jest.fn(async () => {}),
  safeFetch: jest.fn(async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ host: u.host, path: u.pathname, body, headers: init.headers });
    const agent = agents[u.host];
    if (!agent) return new Response('no agent', { status: 502 });
    if (u.pathname.endsWith('agent-card.json')) return Response.json(agent.card);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: agent.reply(body.method, body) });
  })
}));

jest.unstable_mockModule('../../services/CredentialService.js', () => ({
  default: { resolveSecret: ref => `secret-of-${ref}` }
}));

const progressFrames = [];
jest.unstable_mockModule('../../services/loop/RunStream.js', () => ({
  emitToolProgress: (chatId, progress) => progressFrames.push({ chatId, ...progress })
}));

const { default: manager, MAX_REMEMBERED_CONTEXTS } =
  await import('../../services/a2a/A2aClientManager.js');

function defineAgent(host, skills, reply) {
  agents[host] = {
    card: {
      name: host,
      url: `https://${host}/a2a`,
      protocolVersion: '0.3.0',
      capabilities: { streaming: false },
      skills
    },
    reply
  };
}

function agentConfig(id, host, extra = {}) {
  return {
    id,
    name: { en: `Agent ${id}` },
    cardUrl: `https://${host}/.well-known/agent-card.json`,
    ...extra
  };
}

let replies;
beforeEach(async () => {
  requests.length = 0;
  progressFrames.length = 0;
  replies = 0;
  defineAgent(
    'one.example',
    [{ id: 'Ask Langdock Agent', name: 'Ask' }, { id: 'summarize' }],
    (method, body) => {
      replies++;
      return {
        kind: 'message',
        role: 'agent',
        messageId: `m${replies}`,
        contextId: body.params.message.contextId || `ctx-${replies}`,
        parts: [{ kind: 'text', text: `reply ${replies}: ${body.params.message.parts[0].text}` }]
      };
    }
  );
  defineAgent('two.example', [{ id: 'translate' }], () => ({
    kind: 'message',
    role: 'agent',
    messageId: 'x',
    parts: [{ kind: 'text', text: 'übersetzt' }]
  }));
  await manager.shutdown();
  await manager.initialize({
    agents: [agentConfig('one', 'one.example'), agentConfig('two', 'two.example')]
  });
});

describe('initialize', () => {
  it('tolerates an invalid file and ends up with no agents', async () => {
    await manager.initialize({ agents: [{ name: 'no id' }] });
    expect(manager.hasAgent('one')).toBe(false);
    expect(await manager.listAllTools()).toEqual([]);
  });

  it('keeps a connection (and its card) when only non-connection fields change', async () => {
    await manager.listAllTools();
    const conn = manager.getConnection('one');
    const cardFetches = requests.length;
    await manager.initialize({
      agents: [
        agentConfig('one', 'one.example', { allowedSkills: ['summarize'], timeoutMs: 5000 }),
        agentConfig('two', 'two.example')
      ]
    });
    expect(manager.getConnection('one')).toBe(conn);
    const tools = await manager.listAllTools();
    expect(requests.length).toBe(cardFetches);
    expect(tools.filter(t => t._a2a.agentId === 'one').map(t => t._a2a.skillId)).toEqual([
      'summarize'
    ]);
  });

  it('replaces the connection when the card URL or auth changes, drops removed agents', async () => {
    const conn = manager.getConnection('one');
    await manager.initialize({
      agents: [agentConfig('one', 'one.example', { auth: { type: 'bearer', tokenRef: 't' } })]
    });
    expect(manager.getConnection('one')).not.toBe(conn);
    expect(manager.hasAgent('two')).toBe(false);
  });
});

describe('listAllTools', () => {
  it('merges the skills of every enabled agent as a2a__ tools', async () => {
    const tools = await manager.listAllTools();
    expect(tools.map(t => t.id).sort()).toEqual([
      'a2a__one__ask_langdock_agent',
      'a2a__one__summarize',
      'a2a__two__translate'
    ]);
    expect(manager.ownsTool('a2a__two__translate')).toBe(true);
  });

  it('skips disabled and unreachable agents without failing the others', async () => {
    await manager.initialize({
      agents: [
        agentConfig('one', 'one.example', { enabled: false }),
        agentConfig('two', 'two.example'),
        agentConfig('dead', 'dead.example')
      ]
    });
    expect((await manager.listAllTools()).map(t => t.id)).toEqual(['a2a__two__translate']);
    const catalog = await manager.listSkillsByAgent();
    expect(catalog.find(a => a.id === 'dead').error).toMatch(/HTTP 502/);
    expect(catalog.find(a => a.id === 'one')).toMatchObject({ enabled: false, skills: [] });
    expect(catalog.find(a => a.id === 'two').skills).toEqual([
      expect.objectContaining({ id: 'translate', toolId: 'a2a__two__translate' })
    ]);
  });
});

describe('callTool', () => {
  const user = { id: 'alice', permissions: {} };

  it('dispatches to the owning agent with the skill id and only the model arguments', async () => {
    const answer = await manager.callTool('a2a__one__ask_langdock_agent', {
      message: 'Is A2A great?',
      data: { mood: 'curious' },
      chatId: 'chat-1',
      user,
      appConfig: { id: 'app', secret: 'x' },
      language: 'en'
    });
    expect(answer).toBe('reply 1: Is A2A great?');
    const rpc = requests.find(r => r.body?.method === 'message/send');
    expect(rpc.host).toBe('one.example');
    expect(rpc.body.params.message.metadata).toEqual({ skillId: 'Ask Langdock Agent' });
    expect(rpc.body.params.message.parts).toEqual([
      { kind: 'text', text: 'Is A2A great?' },
      { kind: 'data', data: { mood: 'curious' } }
    ]);
    // iHub's own context never leaves iHub.
    expect(JSON.stringify(rpc.body)).not.toMatch(/alice|appConfig|chat-1/);
  });

  it('refuses unknown tools and empty messages', async () => {
    await expect(manager.callTool('a2a__nope__x', { message: 'hi' })).rejects.toThrow(/not found/);
    await expect(manager.callTool('a2a__one__summarize', { message: '  ' })).rejects.toThrow(
      /message/
    );
  });

  it('continues the conversation per user and chat, never across them', async () => {
    const call = (chatId, u) =>
      manager.callTool('a2a__one__summarize', { message: 'x', chatId, user: u });
    const contextOf = n =>
      requests.filter(r => r.body?.method === 'message/send')[n].body.params.message.contextId;

    await call('chat-1', user);
    await call('chat-1', user);
    await call('chat-2', user);
    await call('chat-1', { id: 'bob' });
    expect(contextOf(0)).toBeUndefined();
    expect(contextOf(1)).toBe('ctx-1');
    expect(contextOf(2)).toBeUndefined();
    expect(contextOf(3)).toBeUndefined();
  });

  it('keeps the conversation memory bounded', () => {
    for (let i = 0; i < MAX_REMEMBERED_CONTEXTS + 10; i++) manager._remember(`k${i}`, `c${i}`);
    expect(manager.contexts.size).toBe(MAX_REMEMBERED_CONTEXTS);
    expect(manager.contexts.has('k0')).toBe(false);
  });

  it('reports the agent status to the chat as tool progress', async () => {
    agents['one.example'].reply = (method, body) =>
      method === 'message/send'
        ? { kind: 'task', id: 't1', contextId: 'c', status: { state: 'working' } }
        : {
            kind: 'task',
            id: 't1',
            contextId: 'c',
            status: { state: 'completed' },
            artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: `done ${body.method}` }] }]
          };
    await manager.initialize({
      agents: [agentConfig('one', 'one.example', { pollIntervalMs: 250 })]
    });
    const answer = await manager.callTool('a2a__one__summarize', {
      message: 'x',
      chatId: 'chat-9',
      user
    });
    expect(answer).toBe('done tasks/get');
    expect(progressFrames[0]).toMatchObject({
      chatId: 'chat-9',
      phase: 'a2a.status',
      toolId: 'a2a__one__summarize',
      message: 'Agent one: working',
      data: { agentId: 'one', skillId: 'summarize', state: 'working' }
    });
  });
});

describe('admin probes', () => {
  it('testConfig previews every skill and marks the allowed ones', async () => {
    const result = await manager.testConfig(
      agentConfig('draft', 'one.example', { allowedSkills: ['summarize'] })
    );
    expect(result.card).toMatchObject({ name: 'one.example', protocolVersion: '0.3.0' });
    expect(result.skills.map(s => [s.id, s.allowed])).toEqual([
      ['Ask Langdock Agent', false],
      ['summarize', true]
    ]);
    expect(manager.hasAgent('draft')).toBe(false);
    await expect(manager.testConfig({ id: 'bad id' })).rejects.toThrow(/Invalid agent config/);
  });

  it('testConnection re-fetches the card of a saved agent', async () => {
    await manager.listAllTools();
    const before = requests.length;
    const result = await manager.testConnection('two');
    expect(requests.length).toBe(before + 1);
    expect(result.status).toMatchObject({ id: 'two', connected: true, toolCount: 1 });
    await expect(manager.testConnection('missing')).rejects.toThrow(/not found/);
  });
});

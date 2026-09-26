import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * A2A 0.3 protocol handler: Agent Card, skills, message/send, message/stream,
 * tasks/get and tasks/cancel, with the app invoker, the workflow tool runner
 * and storage replaced by fakes.
 */

const apps = [
  {
    id: 'chat',
    name: { en: 'Chat' },
    description: { en: 'General chat' },
    starterPrompts: [{ title: { en: 'Hi' }, message: { en: 'Say hello' } }]
  },
  { id: 'summary', name: { en: 'Summarizer' }, description: 'Summarize text' },
  { id: 'hidden', name: 'Hidden', enabled: false }
];
const workflows = [
  {
    id: 'wf1',
    name: { en: 'Report' },
    chatIntegration: { enabled: true, toolDescription: 'Build a report' }
  },
  { id: 'wf2', name: 'No chat', chatIntegration: { enabled: false } }
];

let platform;
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getApps: () => ({ data: apps }),
    getWorkflows: () => ({ data: workflows }),
    getUI: () => ({ data: { title: { en: 'iHub Test' } } }),
    getPlatform: () => platform
  }
}));

const invokeApp = jest.fn();
jest.unstable_mockModule('../../services/mcp/appInvoker.js', () => ({
  invokeApp,
  invokeAppNonStreaming: jest.fn()
}));

const runTool = jest.fn();
jest.unstable_mockModule('../../toolLoader.js', () => ({
  runTool,
  loadConfiguredTools: jest.fn(async () => [])
}));
jest.unstable_mockModule('../../services/mcp/permissions.js', () => ({
  getVisibleToolIds: jest.fn(async () => new Set()),
  toolVisibleInSet: () => false
}));
jest.unstable_mockModule('../../utils/versionHelper.js', () => ({ getAppVersion: () => '9.9.9' }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../../storage/bootstrap.js', () => ({
  getStorage: () => null,
  readFacet: () => null
}));
const published = [];
jest.unstable_mockModule('../../clusterBus.js', () => ({
  publish: jest.fn((type, payload) => {
    published.push({ type, payload });
    return false;
  }),
  subscribe: jest.fn(() => () => {})
}));

const { dispatchA2A, buildAgentCard, listA2aSkills, parseSkillId, A2aError, A2A_ERRORS } =
  await import('../../services/mcp/a2aHandler.js');
const { A2aTaskStore, FINAL_TASK_STATES } = await import('../../services/mcp/a2aTaskStore.js');

const fullUser = () => ({
  id: 'alice',
  scopes: ['mcp:apps:invoke', 'mcp:workflows:run'],
  permissions: { apps: new Set(['*']), workflows: new Set(['wf1', 'wf2']) }
});

const textMessage = (text, extra = {}) => ({
  kind: 'message',
  role: 'user',
  messageId: 'm1',
  parts: [{ kind: 'text', text }],
  ...extra
});

let store;
const ctx = (overrides = {}) => ({
  user: fullUser(),
  platform,
  baseUrl: 'https://ihub.example',
  store,
  ...overrides
});

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

beforeEach(() => {
  platform = {
    defaultLanguage: 'en',
    mcpServer: { expose: { tools: true, apps: true, workflows: true }, a2a: { enabled: true } },
    oauth: { issuer: 'https://ihub.example' }
  };
  store = new A2aTaskStore({ documents: null, relayCancel: false });
  invokeApp.mockReset();
  invokeApp.mockImplementation(async ({ onTextDelta }) => {
    onTextDelta?.('Hel');
    onTextDelta?.('lo');
    return { text: 'Hello', result: {} };
  });
  runTool.mockReset();
  runTool.mockImplementation(async () => ({ report: 'done' }));
  published.length = 0;
});

describe('skill ids', () => {
  it('accepts app__ and workflow__ ids with safe inner ids only', () => {
    expect(parseSkillId('app__chat')).toEqual({ kind: 'app', id: 'chat' });
    expect(parseSkillId('workflow__wf-1.v2')).toEqual({ kind: 'workflow', id: 'wf-1.v2' });
    expect(parseSkillId('app__../etc')).toBeNull();
    expect(parseSkillId('app__a/b')).toBeNull();
    expect(parseSkillId('tool')).toBeNull();
    expect(parseSkillId(42)).toBeNull();
  });
});

describe('skills', () => {
  it('lists the apps and workflows the caller may run, honouring exposure, scopes and groups', () => {
    const skills = listA2aSkills(fullUser(), platform);
    expect(skills.map(s => s.id)).toEqual(['app__chat', 'app__summary', 'workflow__wf1']);
    const chat = skills.find(s => s.id === 'app__chat');
    expect(chat).toMatchObject({ name: 'Chat', description: 'General chat', tags: ['app'] });
    expect(chat.examples).toEqual(['Say hello']);

    const noWorkflowScope = { ...fullUser(), scopes: ['mcp:apps:invoke'] };
    expect(listA2aSkills(noWorkflowScope, platform).map(s => s.id)).toEqual([
      'app__chat',
      'app__summary'
    ]);

    const oneApp = {
      ...fullUser(),
      permissions: { apps: new Set(['summary']), workflows: new Set() }
    };
    expect(listA2aSkills(oneApp, platform).map(s => s.id)).toEqual(['app__summary']);

    platform.mcpServer.expose.apps = false;
    expect(listA2aSkills(fullUser(), platform).map(s => s.id)).toEqual(['workflow__wf1']);
  });
});

describe('agent card', () => {
  it('is public without skills and names the endpoint, protocol and auth schemes', () => {
    const card = buildAgentCard({ baseUrl: 'https://ihub.example', platform });
    expect(card).toMatchObject({
      name: 'iHub Test',
      url: 'https://ihub.example/a2a',
      protocolVersion: '0.3.0',
      version: '9.9.9',
      preferredTransport: 'JSONRPC',
      capabilities: { streaming: true, pushNotifications: false },
      supportsAuthenticatedExtendedCard: true,
      skills: []
    });
    expect(card.securitySchemes.oauth2).toMatchObject({
      type: 'oauth2',
      oauth2MetadataUrl: 'https://ihub.example/.well-known/oauth-authorization-server'
    });
    expect(card.securitySchemes.oauth2.flows.authorizationCode.tokenUrl).toBe(
      'https://ihub.example/api/oauth/token'
    );
    expect(card.securitySchemes.apiKey).toEqual(
      expect.objectContaining({ type: 'apiKey', in: 'header', name: 'X-API-Key' })
    );
    expect(card.security).toEqual([
      { oauth2: ['mcp:apps:invoke', 'mcp:workflows:run'] },
      { bearer: [] },
      { apiKey: [] }
    ]);
  });

  it("lists the caller's skills without internal markers, and binds a per-skill card to one skill", () => {
    const card = buildAgentCard({ baseUrl: 'https://ihub.example', platform, user: fullUser() });
    expect(card.skills.map(s => s.id)).toEqual(['app__chat', 'app__summary', 'workflow__wf1']);
    for (const skill of card.skills) {
      expect(skill).not.toHaveProperty('_kind');
      expect(skill).not.toHaveProperty('_id');
    }
    const one = buildAgentCard({
      baseUrl: 'https://ihub.example',
      platform,
      user: fullUser(),
      skillId: 'app__summary'
    });
    expect(one.url).toBe('https://ihub.example/a2a/skills/app__summary');
    expect(one.name).toBe('iHub Test — Summarizer');
    expect(one.skills.map(s => s.id)).toEqual(['app__summary']);
    expect(() =>
      buildAgentCard({ baseUrl: 'x', platform, user: fullUser(), skillId: 'app__nope' })
    ).toThrow(A2aError);
    expect(() => buildAgentCard({ baseUrl: 'x', platform, skillId: '../x' })).toThrow(A2aError);
  });

  it("agent/getAuthenticatedExtendedCard returns the caller's card", async () => {
    const r = await dispatchA2A(rpc('agent/getAuthenticatedExtendedCard'), ctx());
    expect(r.result.skills).toHaveLength(3);
    expect(r.result.url).toBe('https://ihub.example/a2a');
  });
});

describe('message/send', () => {
  it('needs a skill when the caller has several and none is configured', async () => {
    const r = await dispatchA2A(rpc('message/send', { message: textMessage('hi') }), ctx());
    expect(r.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
    expect(r.error.message).toMatch(/metadata\.skillId/);
    expect(invokeApp).not.toHaveBeenCalled();
  });

  it('runs the app named by metadata.skillId and returns the finished task', async () => {
    const r = await dispatchA2A(
      rpc('message/send', {
        message: textMessage('hi', {
          metadata: { skillId: 'app__chat' },
          parts: [
            { kind: 'text', text: 'hi' },
            { kind: 'data', data: { tone: 'formal' } }
          ]
        })
      }),
      ctx()
    );
    expect(r.error).toBeUndefined();
    const task = r.result;
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(task.contextId).toEqual(expect.any(String));
    expect(task.artifacts).toEqual([
      {
        artifactId: expect.any(String),
        name: 'response',
        parts: [{ kind: 'text', text: 'Hello' }]
      }
    ]);
    expect(task.history.map(m => m.role)).toEqual(['user', 'agent']);
    expect(task.history[0]).toMatchObject({ contextId: task.contextId, taskId: task.id });
    expect(task.status.message).toMatchObject({
      role: 'agent',
      parts: [{ kind: 'text', text: 'Hello' }]
    });
    expect(task.metadata).toEqual({ skillId: 'app__chat' });

    expect(invokeApp).toHaveBeenCalledTimes(1);
    const call = invokeApp.mock.calls[0][0];
    expect(call).toMatchObject({
      appId: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      variables: { tone: 'formal' },
      language: 'en',
      runId: `a2a-${task.id}`
    });
    expect(call.user.id).toBe('alice');
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('continues a context with its skill and history', async () => {
    const first = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx()
    );
    const { contextId } = first.result;
    const second = await dispatchA2A(
      rpc('message/send', { message: textMessage('and now?', { contextId, messageId: 'm2' }) }),
      ctx()
    );
    expect(second.error).toBeUndefined();
    expect(second.result.contextId).toBe(contextId);
    expect(second.result.id).not.toBe(first.result.id);
    expect(invokeApp.mock.calls[1][0].messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'and now?' }
    ]);
  });

  it("does not hand one caller's context to another", async () => {
    const first = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx()
    );
    const bob = { ...fullUser(), id: 'bob' };
    const r = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { contextId: first.result.contextId }) }),
      ctx({ user: bob })
    );
    // Bob has several skills and the context is not his, so no skill is inferred.
    expect(r.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
  });

  it('falls back to the configured default skill, and to the only skill', async () => {
    platform.mcpServer.a2a.defaultSkill = 'app__summary';
    const r = await dispatchA2A(rpc('message/send', { message: textMessage('hi') }), ctx());
    expect(r.result.status.state).toBe('completed');
    expect(invokeApp.mock.calls[0][0].appId).toBe('summary');

    delete platform.mcpServer.a2a.defaultSkill;
    const single = {
      ...fullUser(),
      scopes: ['mcp:apps:invoke'],
      permissions: { apps: new Set(['chat']), workflows: new Set() }
    };
    const r2 = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi') }),
      ctx({ user: single })
    );
    expect(r2.result.status.state).toBe('completed');
    expect(invokeApp.mock.calls[1][0].appId).toBe('chat');
  });

  it('refuses skills the caller may not use, and mismatching per-skill endpoints', async () => {
    const r = await dispatchA2A(
      rpc('message/send', {
        message: textMessage('hi', { metadata: { skillId: 'app__hidden' } })
      }),
      ctx()
    );
    expect(r.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
    expect(r.error.message).toMatch(/Unknown skill/);

    const traversal = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__../x' } }) }),
      ctx()
    );
    expect(traversal.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);

    const mismatch = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx({ fixedSkillId: 'app__summary' })
    );
    expect(mismatch.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
    expect(invokeApp).not.toHaveBeenCalled();

    const fixed = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi') }),
      ctx({ fixedSkillId: 'app__summary' })
    );
    expect(fixed.result.status.state).toBe('completed');
    expect(invokeApp.mock.calls[0][0].appId).toBe('summary');
  });

  it('runs a workflow skill through the workflow tool with the caller and a task chat id', async () => {
    const r = await dispatchA2A(
      rpc('message/send', {
        message: textMessage('quarterly', { metadata: { skillId: 'workflow__wf1' } })
      }),
      ctx()
    );
    expect(r.result.status.state).toBe('completed');
    expect(r.result.artifacts[0].parts[0].text).toBe(JSON.stringify({ report: 'done' }));
    expect(runTool).toHaveBeenCalledWith(
      'workflow_wf1',
      expect.objectContaining({
        input: 'quarterly',
        chatId: `a2a-${r.result.id}`,
        language: 'en',
        user: expect.objectContaining({ id: 'alice' })
      })
    );
  });

  it('rejects file parts, push notification requests and messages for finished tasks', async () => {
    const file = await dispatchA2A(
      rpc('message/send', {
        message: textMessage('x', {
          metadata: { skillId: 'app__chat' },
          parts: [{ kind: 'file', file: { bytes: 'AA==', mimeType: 'image/png' } }]
        })
      }),
      ctx()
    );
    expect(file.error.code).toBe(A2A_ERRORS.CONTENT_TYPE_NOT_SUPPORTED);

    const push = await dispatchA2A(
      rpc('message/send', {
        message: textMessage('x', { metadata: { skillId: 'app__chat' } }),
        configuration: { pushNotificationConfig: { url: 'https://cb.example' } }
      }),
      ctx()
    );
    expect(push.error.code).toBe(A2A_ERRORS.PUSH_NOT_SUPPORTED);

    const done = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx()
    );
    const again = await dispatchA2A(
      rpc('message/send', { message: textMessage('more', { taskId: done.result.id }) }),
      ctx()
    );
    expect(again.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
    expect(again.error.message).toMatch(/completed/);

    const unknownTask = await dispatchA2A(
      rpc('message/send', { message: textMessage('more', { taskId: 'nope' }) }),
      ctx()
    );
    expect(unknownTask.error.code).toBe(A2A_ERRORS.TASK_NOT_FOUND);
  });

  it('marks a failing skill as failed with the error on the status message', async () => {
    invokeApp.mockRejectedValueOnce(Object.assign(new Error('model down'), { code: 'LLM' }));
    const r = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx()
    );
    expect(r.result.status.state).toBe('failed');
    expect(r.result.status.message.parts[0].text).toMatch(/model down/);
    expect(r.result.artifacts).toEqual([]);
  });

  it('honours historyLength and non-blocking sends', async () => {
    const trimmed = await dispatchA2A(
      rpc('message/send', {
        message: textMessage('hi', { metadata: { skillId: 'app__chat' } }),
        configuration: { historyLength: 0 }
      }),
      ctx()
    );
    expect(trimmed.result.history).toEqual([]);

    let release;
    invokeApp.mockImplementationOnce(
      () => new Promise(resolve => (release = () => resolve({ text: 'Later', result: {} })))
    );
    const pending = await dispatchA2A(
      rpc('message/send', {
        message: textMessage('hi', { metadata: { skillId: 'app__chat' } }),
        configuration: { blocking: false }
      }),
      ctx()
    );
    expect(['submitted', 'working']).toContain(pending.result.status.state);
    const taskId = pending.result.id;
    // The run continues in the background; give it a tick to reach the model.
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    const got = await dispatchA2A(rpc('tasks/get', { id: taskId }), ctx());
    expect(got.result.status.state).toBe('completed');
    expect(got.result.artifacts[0].parts[0].text).toBe('Later');
  });
});

describe('tasks/get and tasks/cancel', () => {
  it("returns only the caller's tasks", async () => {
    const created = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx()
    );
    const mine = await dispatchA2A(
      rpc('tasks/get', { id: created.result.id, historyLength: 1 }),
      ctx()
    );
    expect(mine.result.id).toBe(created.result.id);
    expect(mine.result.history).toHaveLength(1);
    expect(mine.result.history[0].role).toBe('agent');

    const other = await dispatchA2A(
      rpc('tasks/get', { id: created.result.id }),
      ctx({ user: { ...fullUser(), id: 'bob' } })
    );
    expect(other.error.code).toBe(A2A_ERRORS.TASK_NOT_FOUND);
    const missing = await dispatchA2A(rpc('tasks/get', { id: 'nope' }), ctx());
    expect(missing.error.code).toBe(A2A_ERRORS.TASK_NOT_FOUND);
    const noId = await dispatchA2A(rpc('tasks/get', {}), ctx());
    expect(noId.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
  });

  it('cannot cancel a finished task', async () => {
    const created = await dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx()
    );
    const r = await dispatchA2A(rpc('tasks/cancel', { id: created.result.id }), ctx());
    expect(r.error.code).toBe(A2A_ERRORS.TASK_NOT_CANCELABLE);
    expect(FINAL_TASK_STATES).toContain('completed');
  });

  it('cancels a running task through its abort signal', async () => {
    invokeApp.mockImplementationOnce(
      ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })
    );
    const pending = dispatchA2A(
      rpc('message/send', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx()
    );
    // Let the task start, then cancel it by id.
    await new Promise(resolve => setTimeout(resolve, 10));
    const [taskId] = [...store.runs.keys()];
    expect(taskId).toBeDefined();
    const cancel = await dispatchA2A(rpc('tasks/cancel', { id: taskId }), ctx());
    expect(cancel.result.status.state).toBe('canceled');
    const finished = await pending;
    expect(finished.result.status.state).toBe('canceled');
    expect(published).toEqual([]); // aborted locally, nothing relayed
  });

  it('relays a cancel for a task running elsewhere and records it', async () => {
    const task = await store.createTask({
      ownerId: 'alice',
      skillId: 'app__chat',
      message: textMessage('hi')
    });
    await store.setStatus(task.id, 'working');
    const r = await dispatchA2A(rpc('tasks/cancel', { id: task.id }), ctx());
    expect(r.result.status.state).toBe('canceled');
    expect(published).toEqual([{ type: 'a2a:cancel', payload: { taskId: task.id } }]);
  });
});

describe('message/stream', () => {
  it('streams the task, working status, artifact chunks and the final status as JSON-RPC responses', async () => {
    const events = [];
    const r = await dispatchA2A(
      rpc(
        'message/stream',
        { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) },
        'req-7'
      ),
      ctx({ stream: e => events.push(e) })
    );
    expect(r).toBeNull();
    for (const e of events) expect(e).toMatchObject({ jsonrpc: '2.0', id: 'req-7' });
    const results = events.map(e => e.result);
    expect(results[0]).toMatchObject({ kind: 'task', status: { state: 'submitted' } });
    expect(results[1]).toMatchObject({
      kind: 'status-update',
      status: { state: 'working' },
      final: false
    });
    const chunks = results.filter(e => e.kind === 'artifact-update');
    expect(chunks.map(c => c.artifact.parts.map(p => p.text).join(''))).toEqual(['Hel', 'lo', '']);
    expect(chunks.map(c => c.append)).toEqual([false, true, true]);
    expect(chunks.map(c => c.lastChunk)).toEqual([false, false, true]);
    expect(new Set(chunks.map(c => c.artifact.artifactId)).size).toBe(1);
    expect(results.at(-1)).toMatchObject({
      kind: 'status-update',
      status: { state: 'completed', message: { role: 'agent' } },
      final: true
    });
    const taskId = results[0].id;
    for (const e of results.slice(1)) expect(e.taskId).toBe(taskId);
  });

  it('replaces the streamed text when the final answer differs from the fragments', async () => {
    invokeApp.mockImplementationOnce(async ({ onTextDelta }) => {
      onTextDelta('thinking…');
      return { text: 'Final answer', result: {} };
    });
    const events = [];
    await dispatchA2A(
      rpc('message/stream', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx({ stream: e => events.push(e.result) })
    );
    const last = events.filter(e => e.kind === 'artifact-update').at(-1);
    expect(last).toMatchObject({ append: false, lastChunk: true });
    expect(last.artifact.parts[0].text).toBe('Final answer');
  });

  it('is refused without a streaming response, as are unsupported task methods', async () => {
    const r = await dispatchA2A(
      rpc('message/stream', { message: textMessage('hi', { metadata: { skillId: 'app__chat' } }) }),
      ctx()
    );
    expect(r.error.code).toBe(A2A_ERRORS.INVALID_REQUEST);
    const resub = await dispatchA2A(rpc('tasks/resubscribe', { id: 'x' }), ctx());
    expect(resub.error.code).toBe(A2A_ERRORS.UNSUPPORTED_OPERATION);
    const push = await dispatchA2A(rpc('tasks/pushNotificationConfig/set', {}), ctx());
    expect(push.error.code).toBe(A2A_ERRORS.PUSH_NOT_SUPPORTED);
  });
});

describe('legacy draft methods', () => {
  it('agent/info still answers', async () => {
    const r = await dispatchA2A(rpc('agent/info'), ctx());
    expect(r.result.name).toBe('ihub-apps');
  });
});

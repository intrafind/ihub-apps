import { describe, it, expect } from '@jest/globals';
import {
  PROVIDER_TOOL_NAME_PATTERN,
  StreamCollector,
  buildSkillTools,
  cardApiKeyHeader,
  findAgentIdConflict,
  markAgentIdConflicts,
  parseSseStream,
  partsText,
  resolveRpcEndpoint,
  skillSlug,
  validateAgentCard
} from '../../services/a2a/a2aTools.js';
import { isToolSelected } from '../../utils/toolSelection.js';

// What OpenAI and Anthropic accept as a function name.
const PROVIDER_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
import { toolVisibleInSet } from '../../services/mcp/permissions.js';

const agent = { id: 'langdock', name: 'Langdock', allowedSkills: ['*'] };

describe('skillSlug', () => {
  it('lower-cases and collapses every run of other characters to one underscore', () => {
    expect(skillSlug('Ask Langdock Agent')).toBe('ask_langdock_agent');
    expect(skillSlug('  --Weird__Skill!!v2  ')).toBe('weird_skill_v2');
    expect(skillSlug('x'.repeat(80))).toHaveLength(40);
  });
});

describe('buildSkillTools', () => {
  it('turns the cookbook skill into a valid tool with the A2A marker', () => {
    const { tools, skillsByToolId } = buildSkillTools(agent, {
      skills: [
        {
          id: 'Ask Langdock Agent',
          name: 'Ask Langdock Agent',
          description: 'Ask the Langdock Agent a question.',
          examples: ['Is A2A great?']
        }
      ]
    });
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.id).toBe('a2a__langdock__ask_langdock_agent');
    expect(tool.name).toBe(tool.id);
    expect(tool.id).toMatch(PROVIDER_NAME);
    expect(tool.description).toBe('Ask the Langdock Agent a question. Examples: "Is A2A great?"');
    expect(tool.parameters.required).toEqual(['message']);
    expect(tool.parameters.properties.data.type).toBe('object');
    expect(tool._a2a).toEqual({
      agentId: 'langdock',
      agentName: 'Langdock',
      skillId: 'Ask Langdock Agent',
      skillName: 'Ask Langdock Agent'
    });
    expect(skillsByToolId.get(tool.id).id).toBe('Ask Langdock Agent');
  });

  it('applies allowedSkills and keeps ids unique and within 64 characters', () => {
    const longAgent = { id: 'a'.repeat(48), name: 'x', allowedSkills: ['*'] };
    const { tools } = buildSkillTools(longAgent, {
      skills: [{ id: 'Summarize document' }, { id: 'summarize-document' }, { id: '???' }]
    });
    const ids = tools.map(t => t.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(PROVIDER_NAME);
    }

    const { tools: allowed } = buildSkillTools(
      { ...agent, allowedSkills: ['b'] },
      { skills: [{ id: 'a' }, { id: 'b' }] }
    );
    expect(allowed.map(t => t._a2a.skillId)).toEqual(['b']);
  });

  it('keeps a skill’s tool id whatever allowedSkills and the card order are', () => {
    const skills = [{ id: 'Ask Agent' }, { id: 'ask-agent' }];
    const idOf = (config, cardSkills, skillId) =>
      buildSkillTools({ ...agent, ...config }, { skills: cardSkills }).tools.find(
        t => t._a2a.skillId === skillId
      )?.id;

    const preview = idOf({}, skills, 'ask-agent');
    expect(preview).toBe('a2a__langdock__ask_agent_2');
    // Runtime with only that skill allowed: the same id as the preview.
    expect(idOf({ allowedSkills: ['ask-agent'] }, skills, 'ask-agent')).toBe(preview);
    // The agent reorders its card: still the same ids.
    expect(idOf({}, [...skills].reverse(), 'ask-agent')).toBe(preview);
    expect(idOf({}, [...skills].reverse(), 'Ask Agent')).toBe('a2a__langdock__ask_agent');
  });

  it('never produces a tool name a provider rejects', () => {
    expect(PROVIDER_TOOL_NAME_PATTERN.source).toBe(PROVIDER_NAME.source);
    // A dotted id slipped past the schema (hand-edited file): no tools at all
    // rather than a name that fails every chat request with HTTP 400.
    const { tools } = buildSkillTools(
      { id: 'lang.dock', allowedSkills: ['*'] },
      { skills: [{ id: 'Ask' }] }
    );
    expect(tools).toEqual([]);
  });
});

describe('tool selection of A2A tools', () => {
  const tool = { id: 'a2a__langdock__ask', _a2a: { agentId: 'langdock' } };

  it('selects an agent tool by its id or by the agent id', () => {
    expect(isToolSelected(tool, ['a2a__langdock__ask'])).toBe(true);
    expect(isToolSelected(tool, ['langdock'])).toBe(true);
    expect(isToolSelected(tool, new Set(['langdock']))).toBe(true);
    expect(isToolSelected(tool, ['other'])).toBe(false);
  });

  it('does not select an agent by an id that is also a tool or MCP server id', () => {
    const clashing = { ...tool, _a2a: { agentId: 'langdock', idConflict: true } };
    expect(isToolSelected(clashing, ['langdock'])).toBe(false);
    expect(isToolSelected(clashing, ['a2a__langdock__ask'])).toBe(true);
  });

  it('selects every skill of an agent by a2a__<agentId>, clash or not', () => {
    const clashing = { ...tool, _a2a: { agentId: 'langdock', idConflict: true } };
    expect(isToolSelected(clashing, ['a2a__langdock'])).toBe(true);
    expect(isToolSelected(tool, new Set(['a2a__langdock']))).toBe(true);
    // It names one agent only.
    expect(isToolSelected({ ...tool, _a2a: { agentId: 'other' } }, ['a2a__langdock'])).toBe(false);
    expect(isToolSelected({ id: 'langdock_search' }, ['a2a__langdock'])).toBe(false);
    expect(
      toolVisibleInSet('a2a__langdock__ask', new Set(['a2a__langdock']), null, 'langdock')
    ).toBe(true);
  });

  it('never selects every agent through the literal base id "a2a"', () => {
    expect(isToolSelected(tool, ['a2a'])).toBe(false);
    expect(isToolSelected({ id: 'a2a__langdock__ask' }, ['a2a'])).toBe(false);
    expect(toolVisibleInSet('a2a__langdock__ask', new Set(['a2a']))).toBe(false);
  });

  it('lets a gateway grant cover an agent through its id', () => {
    expect(toolVisibleInSet('a2a__langdock__ask', new Set(['langdock']), null, 'langdock')).toBe(
      true
    );
    expect(toolVisibleInSet('a2a__langdock__ask', new Set(['*']))).toBe(true);
  });
});

describe('Agent Card helpers', () => {
  const card = { url: 'https://a.example/a2a', protocolVersion: '0.3.0', skills: [] };

  it('validates the essentials and normalises streaming', () => {
    expect(validateAgentCard(card).capabilities.streaming).toBe(false);
    expect(
      validateAgentCard({ ...card, capabilities: { streaming: true } }).capabilities.streaming
    ).toBe(true);
    expect(() => validateAgentCard({ ...card, url: undefined })).toThrow(/url/);
    expect(() => validateAgentCard({ ...card, skills: null })).toThrow(/skills/);
    expect(() => validateAgentCard({ ...card, protocolVersion: '' })).toThrow(/protocolVersion/);
    try {
      validateAgentCard(null);
    } catch (err) {
      expect(err.code).toBe('A2A_CARD_INVALID');
    }
  });

  it('picks the JSON-RPC endpoint', () => {
    expect(resolveRpcEndpoint(card)).toBe(card.url);
    expect(resolveRpcEndpoint({ ...card, preferredTransport: 'JSONRPC' })).toBe(card.url);
    expect(
      resolveRpcEndpoint({
        ...card,
        preferredTransport: 'GRPC',
        additionalInterfaces: [
          { transport: 'GRPC', url: 'https://a.example/grpc' },
          { transport: 'JSONRPC', url: 'https://a.example/rpc' }
        ]
      })
    ).toBe('https://a.example/rpc');
    expect(() => resolveRpcEndpoint({ ...card, preferredTransport: 'GRPC' })).toThrow(/JSON-RPC/);
  });

  it('refuses a JSON-RPC endpoint that is not HTTPS (loopback HTTP excepted)', () => {
    expect(() => resolveRpcEndpoint({ ...card, url: 'http://a.example/a2a' })).toThrow(/HTTPS/);
    expect(() =>
      resolveRpcEndpoint({
        ...card,
        preferredTransport: 'GRPC',
        additionalInterfaces: [{ transport: 'JSONRPC', url: 'http://a.example/rpc' }]
      })
    ).toThrow(/HTTPS/);
    expect(resolveRpcEndpoint({ ...card, url: 'http://localhost:3333/' })).toBe(
      'http://localhost:3333/'
    );
  });

  it('reads the header of an apiKey security scheme', () => {
    expect(
      cardApiKeyHeader({
        securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } }
      })
    ).toBe('X-API-Key');
    expect(
      cardApiKeyHeader({ securitySchemes: { q: { type: 'apiKey', in: 'query', name: 'k' } } })
    ).toBeNull();
    expect(cardApiKeyHeader({})).toBeNull();
  });
});

describe('partsText', () => {
  it('joins text parts and appends data parts as JSON', () => {
    expect(
      partsText(
        [
          { kind: 'text', text: 'a' },
          { kind: 'text', text: 'b' },
          { kind: 'data', data: { n: 1 } },
          { kind: 'file', file: { uri: 'x' } }
        ],
        { separator: '\n' }
      )
    ).toBe('a\nb\n{\n  "n": 1\n}');
  });
});

describe('parseSseStream', () => {
  async function* chunks(...parts) {
    for (const part of parts) yield new TextEncoder().encode(part);
  }

  it('yields one JSON object per event across chunk boundaries', async () => {
    const frames = [];
    for await (const frame of parseSseStream(
      chunks(
        'id: 1\ndata: {"a":',
        '1}\n\n: comment\n\nevent: x\r\ndata: {"b":2}\r\n\r\n',
        'data: {"c":\ndata: 3}'
      )
    )) {
      frames.push(frame);
    }
    expect(frames).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('refuses a line, an event or a stream over its limit', async () => {
    const drain = async (body, limits) => {
      for await (const _frame of parseSseStream(body, limits)) {
        /* drain */
      }
    };
    await expect(
      drain(chunks('data: ' + 'x'.repeat(40), 'x'.repeat(40)), { maxEventBytes: 64 })
    ).rejects.toMatchObject({ code: 'A2A_RESPONSE_TOO_LARGE' });
    await expect(
      drain(chunks(`data: ${'x'.repeat(40)}\n`, `data: ${'x'.repeat(40)}\n`), {
        maxEventBytes: 64
      })
    ).rejects.toMatchObject({ code: 'A2A_RESPONSE_TOO_LARGE' });
    await expect(
      drain(chunks('data: {}\n\n', 'data: {}\n\n', 'data: {}\n\n'), { maxTotalBytes: 20 })
    ).rejects.toMatchObject({ code: 'A2A_RESPONSE_TOO_LARGE' });
  });

  it('reports a broken frame', async () => {
    const run = async () => {
      for await (const _frame of parseSseStream(chunks('data: {oops\n\n'))) {
        /* drain */
      }
    };
    await expect(run()).rejects.toMatchObject({ code: 'A2A_RPC_ERROR' });
  });
});

describe('StreamCollector', () => {
  it('assembles artifact chunks, honouring append and lastChunk', () => {
    const c = new StreamCollector();
    c.add({ kind: 'task', id: 't', contextId: 'c', status: { state: 'submitted' } });
    c.add({
      kind: 'artifact-update',
      artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'Hel' }] }
    });
    c.add({
      kind: 'artifact-update',
      append: true,
      artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'lo' }] }
    });
    c.add({
      kind: 'artifact-update',
      append: true,
      lastChunk: true,
      artifact: { artifactId: 'a', parts: [] }
    });
    expect(c.artifactsText()).toBe('Hello');
    expect(c.final).toBe(false);
    const change = c.add({
      kind: 'status-update',
      final: true,
      status: { state: 'completed' }
    });
    expect(change).toMatchObject({ kind: 'status', state: 'completed' });
    expect(c.final).toBe(true);
    expect(c.taskId).toBe('t');
    expect(c.contextId).toBe('c');
  });

  it('takes the task and context from update events when no Task event comes', () => {
    const c = new StreamCollector();
    c.add({ kind: 'status-update', taskId: 't1', contextId: 'c1', status: { state: 'submitted' } });
    c.add({
      kind: 'artifact-update',
      taskId: 't1',
      contextId: 'c1',
      artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'hi' }] }
    });
    c.add({
      kind: 'status-update',
      taskId: 't1',
      contextId: 'c1',
      status: { state: 'completed' },
      final: true
    });
    expect([c.taskId, c.contextId, c.final, c.artifactsText()]).toEqual(['t1', 'c1', true, 'hi']);
  });

  it('ignores events of another task or context', () => {
    const c = new StreamCollector();
    c.add({ kind: 'task', id: 't', contextId: 'c', status: { state: 'working' } });
    expect(
      c.add({
        kind: 'status-update',
        taskId: 'other',
        contextId: 'c',
        status: { state: 'failed' },
        final: true
      })
    ).toBeNull();
    expect(
      c.add({
        kind: 'artifact-update',
        taskId: 't',
        contextId: 'other',
        artifact: { artifactId: 'x', parts: [{ kind: 'text', text: 'injected' }] }
      })
    ).toBeNull();
    expect(c.final).toBe(false);
    expect(c.status.state).toBe('working');
    expect(c.artifactsText()).toBe('');
  });

  it('refuses more artifact text than its limit', () => {
    const c = new StreamCollector({ maxArtifactChars: 10 });
    const chunk = text => ({
      kind: 'artifact-update',
      append: true,
      artifact: { artifactId: 'a', parts: [{ kind: 'text', text }] }
    });
    c.add({ kind: 'artifact-update', artifact: { artifactId: 'a', parts: [] } });
    c.add(chunk('12345'));
    expect(() => c.add(chunk('678901'))).toThrow(
      expect.objectContaining({ code: 'A2A_RESPONSE_TOO_LARGE' })
    );
  });

  it('replaces an artifact that is sent again without append', () => {
    const c = new StreamCollector();
    c.add({
      kind: 'artifact-update',
      artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'draft' }] }
    });
    c.add({
      kind: 'artifact-update',
      append: false,
      lastChunk: true,
      artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'final' }] }
    });
    expect(c.artifactsText()).toBe('final');
  });
});

describe('agent ids that clash with tool or MCP server ids', () => {
  const tools = [
    { id: 'jira_searchTickets' },
    { id: 'braveSearch' },
    { id: 'drawio__create_diagram', _mcp: { serverId: 'drawio' } }
  ];
  const mcpServers = [{ id: 'atlassian' }, { id: 'excalidraw', toolPrefix: 'exc_' }];

  it('finds a clash with a tool id, a base id and an MCP server id (any case)', () => {
    expect(findAgentIdConflict('jira', { tools })).toEqual({
      kind: 'tool',
      id: 'jira_searchTickets'
    });
    expect(findAgentIdConflict('BraveSearch', { tools })).toMatchObject({ kind: 'tool' });
    expect(findAgentIdConflict('drawio', { tools })).toEqual({ kind: 'mcpServer', id: 'drawio' });
    expect(findAgentIdConflict('atlassian', { mcpServers })).toEqual({
      kind: 'mcpServer',
      id: 'atlassian'
    });
    expect(findAgentIdConflict('exc', { mcpServers })).toMatchObject({ id: 'excalidraw' });
    expect(findAgentIdConflict('langdock', { tools, mcpServers })).toBeNull();
    // Another agent's tools are no clash (duplicates are the admin route's business).
    expect(
      findAgentIdConflict('x', { tools: [{ id: 'a2a__x__ask', _a2a: { agentId: 'x' } }] })
    ).toBeNull();
  });

  it('marks the clashing agent’s tools so its id no longer selects them', () => {
    const a2aTools = [
      { id: 'a2a__jira__ask', _a2a: { agentId: 'jira' } },
      { id: 'a2a__langdock__ask', _a2a: { agentId: 'langdock' } }
    ];
    const { tools: marked, conflicts } = markAgentIdConflicts(a2aTools, { tools, mcpServers });
    expect([...conflicts.keys()]).toEqual(['jira']);
    expect(marked[0]._a2a.idConflict).toBe(true);
    expect(a2aTools[0]._a2a.idConflict).toBeUndefined(); // the cached tool is untouched
    expect(marked[1]).toBe(a2aTools[1]);
    // An app listing `jira` for the local Jira tools does not get the agent.
    expect(isToolSelected(marked[0], ['jira'])).toBe(false);
    expect(isToolSelected(marked[1], ['langdock'])).toBe(true);
  });
});

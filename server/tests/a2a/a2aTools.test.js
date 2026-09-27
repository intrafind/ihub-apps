import { describe, it, expect } from '@jest/globals';
import {
  StreamCollector,
  buildSkillTools,
  cardApiKeyHeader,
  parseSseStream,
  partsText,
  resolveRpcEndpoint,
  skillSlug,
  validateAgentCard
} from '../../services/a2a/a2aTools.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { isToolSelected } from '../../utils/toolSelection.js';
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
    expect(isValidId(tool.id)).toBe(true);
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
      expect(isValidId(id)).toBe(true);
    }

    const { tools: allowed } = buildSkillTools(
      { ...agent, allowedSkills: ['b'] },
      { skills: [{ id: 'a' }, { id: 'b' }] }
    );
    expect(allowed.map(t => t._a2a.skillId)).toEqual(['b']);
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

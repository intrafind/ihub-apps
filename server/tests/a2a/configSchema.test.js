import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import {
  a2aAgentConfigSchema,
  a2aAgentsFileSchema
} from '../../validators/a2aAgentConfigSchema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const minimal = {
  id: 'langdock',
  name: 'Langdock agent',
  cardUrl: 'https://agent.example.com/.well-known/agent-card.json'
};

describe('a2aAgentConfigSchema', () => {
  it('fills in the defaults of a minimal agent', () => {
    const result = a2aAgentConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      enabled: true,
      auth: { type: 'none' },
      allowedSkills: ['*'],
      timeoutMs: 60000,
      streaming: 'auto',
      pollIntervalMs: 1500
    });
  });

  it('accepts every auth type with credential references', () => {
    for (const auth of [
      { type: 'apiKey', valueRef: 'langdock-key' },
      { type: 'apiKey', headerName: 'X-Agent-Key', valueRef: 'k' },
      { type: 'bearer', tokenRef: 't' },
      {
        type: 'oauth',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'ihub',
        clientSecretRef: 's',
        scope: 'agent'
      }
    ]) {
      expect(a2aAgentConfigSchema.safeParse({ ...minimal, auth }).success).toBe(true);
    }
  });

  it('leaves the apiKey header name to the card when none is configured', () => {
    const { data } = a2aAgentConfigSchema.safeParse({
      ...minimal,
      auth: { type: 'apiKey', valueRef: 'k' }
    });
    expect(data.auth.headerName).toBeUndefined();
  });

  it('refuses inline secrets, unknown auth types and Authorization as apiKey header', () => {
    expect(
      a2aAgentConfigSchema.safeParse({ ...minimal, auth: { type: 'apiKey', value: 'plain' } })
        .success
    ).toBe(false);
    expect(
      a2aAgentConfigSchema.safeParse({ ...minimal, auth: { type: 'oauthUser' } }).success
    ).toBe(false);
    expect(
      a2aAgentConfigSchema.safeParse({
        ...minimal,
        auth: { type: 'apiKey', headerName: 'Authorization', valueRef: 'k' }
      }).success
    ).toBe(false);
  });

  it('requires https, except for a loopback agent', () => {
    expect(
      a2aAgentConfigSchema.safeParse({ ...minimal, cardUrl: 'http://agent.example.com/card' })
        .success
    ).toBe(false);
    expect(
      a2aAgentConfigSchema.safeParse({ ...minimal, cardUrl: 'ftp://agent.example.com/card' })
        .success
    ).toBe(false);
    for (const cardUrl of [
      'http://localhost:3333/.well-known/agent-card.json',
      'http://127.0.0.1:3333/.well-known/agent-card.json'
    ]) {
      expect(a2aAgentConfigSchema.safeParse({ ...minimal, cardUrl }).success).toBe(true);
    }
  });

  it('rejects unsafe or too long ids and out-of-range timings', () => {
    expect(a2aAgentConfigSchema.safeParse({ ...minimal, id: 'bad id' }).success).toBe(false);
    expect(a2aAgentConfigSchema.safeParse({ ...minimal, id: '../x' }).success).toBe(false);
    expect(a2aAgentConfigSchema.safeParse({ ...minimal, id: 'a'.repeat(49) }).success).toBe(false);
    expect(a2aAgentConfigSchema.safeParse({ ...minimal, timeoutMs: 500 }).success).toBe(false);
    expect(a2aAgentConfigSchema.safeParse({ ...minimal, timeoutMs: 600001 }).success).toBe(false);
    expect(a2aAgentConfigSchema.safeParse({ ...minimal, streaming: 'always' }).success).toBe(false);
  });
});

describe('a2aAgentsFileSchema', () => {
  it('defaults an empty file to no agents and a blocking SSRF policy', () => {
    const { data } = a2aAgentsFileSchema.safeParse({});
    expect(data).toEqual({ agents: [], security: { blockPrivateIps: true, allowedHosts: [] } });
  });

  it('accepts the shipped default file', () => {
    const file = JSON.parse(
      fs.readFileSync(path.join(here, '../../defaults/config/a2aAgents.json'), 'utf8')
    );
    expect(a2aAgentsFileSchema.safeParse(file).success).toBe(true);
  });
});

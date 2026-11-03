// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Model guidance of integrations in the system prompt (#2974): the guidance
 * of an action (the definition's or the admin's override) and the
 * installation's instructions reach the system prompt of a chat in which the
 * integration is active — and only then. The tools come from the real tool
 * loader (`getToolsForApp`), the prompt step is the one `RequestBuilder` and
 * the workflow prompt node run (`appendIntegrationGuidance`).
 *
 * Run with `npm run test:integrations`.
 */

const { default: configCache } = await import('../../configCache.js');
const { default: registry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const { getToolsForApp } = await import('../../toolLoader.js');
const { appendIntegrationGuidance, buildIntegrationGuidance, withActionOverrides } =
  await import('../../services/integrations/actionGuidance.js');

let root;

const document = {
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  paths: {
    '/search': {
      get: {
        operationId: 'search',
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        responses: {}
      }
    },
    '/note': { post: { operationId: 'note', responses: {} } }
  }
};

const definition = {
  id: 'test.notes',
  version: '1.0.0',
  name: { en: 'Notes' },
  protocol: { type: 'openapi', document: 'api.json', baseUrl: '{baseUrl}' },
  auth: { modes: ['none'] },
  install: [{ key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true }],
  instructions: { en: 'Notes are the team’s meeting notes.', de: 'Notizen sind Protokolle.' },
  actions: [
    {
      name: 'search_notes',
      operationId: 'search',
      title: { en: 'Search notes' },
      description: { en: 'Search the notes.' },
      sideEffect: 'read',
      guidance: { en: 'Search before answering.' }
    },
    {
      name: 'add_note',
      operationId: 'note',
      title: { en: 'Add a note' },
      sideEffect: 'write',
      guidance: { en: 'Add a note only when asked.' }
    }
  ]
};

function installation(id, extra = {}) {
  return {
    id,
    definition: 'test.notes',
    definitionVersion: '1.0.0',
    enabled: true,
    values: { baseUrl: 'https://notes.example' },
    auth: { mode: 'none' },
    ...extra
  };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-integration-guidance-'));
  const dir = path.join(root, 'shipped', 'test.notes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'integration.json'), JSON.stringify(definition));
  await fs.writeFile(path.join(dir, 'api.json'), JSON.stringify(document));
  registry.shippedDir = path.join(root, 'shipped');
  registry.contentsDirOverride = path.join(root, 'contents');
  await registry.reload();

  configCache.setCacheEntry('config/tools.json', []);
  configCache.setCacheEntry('config/a2aAgents.json', { agents: [] });
  configCache.setCacheEntry('config/platform.json', {});
  configCache.setCacheEntry('config/groups.json', {
    groups: {
      anonymous: { id: 'anonymous', permissions: { integrations: ['*'] } },
      users: { id: 'users', permissions: { integrations: ['*'] } }
    }
  });
  configCache.setCacheEntry('config/integrations.json', {
    installed: [
      installation('team-notes', {
        actions: {
          enabled: ['*'],
          disabled: [],
          overrides: {
            search_notes: {
              description: { en: 'Search the team’s meeting notes.' },
              guidance: { en: 'Quote the title of every note you use.' }
            }
          }
        }
      }),
      installation('private-notes', {
        instructions: { en: 'Private notes: never share them outside this chat.' }
      })
    ],
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
  configCache.cache?.clear?.();
});

const user = { id: 'u', groups: ['users'] };

/** The system prompt of a turn of `app`, built as the chat builds it. */
async function systemPromptOf(app) {
  const messages = [{ role: 'system', content: 'You are the notes assistant.' }];
  const tools = await getToolsForApp(app, 'en', { user });
  appendIntegrationGuidance(messages, tools);
  return { prompt: messages[0].content, tools };
}

describe('integration guidance in the system prompt', () => {
  it('adds the edited guidance of an action when the integration is active', async () => {
    const { prompt, tools } = await systemPromptOf({
      id: 'notes',
      tools: [],
      integrations: { 'team-notes': {} }
    });
    assert.match(prompt, /^You are the notes assistant\./);
    assert.match(prompt, /<integration-guidance integration="Notes" id="team-notes">/);
    // The admin's guidance replaces the definition's …
    assert.match(prompt, /Search notes \(tool `team-notes__search_notes`\): Quote the title/);
    assert.doesNotMatch(prompt, /Search before answering/);
    // … the other action keeps its own, and the definition's instructions lead the block.
    assert.match(prompt, /Add a note only when asked\./);
    assert.match(prompt, /Notes are the team’s meeting notes\./);
    // The guidance is in the prompt, not in the tool description the model reads.
    const search = tools.find(t => t.id === 'team-notes__search_notes');
    assert.equal(search.description, 'Search the team’s meeting notes.');
    assert.equal(search._integration.guidance, 'Quote the title of every note you use.');
  });

  it('adds nothing for an integration the app does not bind', async () => {
    const { prompt } = await systemPromptOf({ id: 'plain', tools: [] });
    assert.equal(prompt, 'You are the notes assistant.');
    const { prompt: other } = await systemPromptOf({
      id: 'other',
      tools: [],
      integrations: { 'team-notes': {} }
    });
    assert.doesNotMatch(other, /private-notes/);
    assert.doesNotMatch(other, /Private notes/);
  });

  it('adds only the guidance of the actions the app binds', async () => {
    const { prompt } = await systemPromptOf({
      id: 'read-only',
      tools: [],
      integrations: { 'team-notes': { actions: ['search_notes'] } }
    });
    assert.match(prompt, /Quote the title/);
    assert.doesNotMatch(prompt, /Add a note only when asked/);
  });

  it('uses the installation’s own instructions instead of the definition’s', async () => {
    const { prompt } = await systemPromptOf({
      id: 'private',
      tools: [],
      integrations: { 'private-notes': {} }
    });
    assert.match(prompt, /Private notes: never share them outside this chat\./);
    assert.doesNotMatch(prompt, /meeting notes/);
    assert.match(prompt, /Search before answering\./);
  });

  it('is idempotent and adds a system message when there is none', async () => {
    const tools = await getToolsForApp(
      { id: 'x', tools: [], integrations: { 'team-notes': {} } },
      'en',
      { user }
    );
    const messages = [{ role: 'user', content: 'hi' }];
    assert.equal(appendIntegrationGuidance(messages, tools), true);
    assert.equal(messages[0].role, 'system');
    assert.equal(appendIntegrationGuidance(messages, tools), false);
    assert.equal(messages.filter(m => m.role === 'system').length, 1);
  });
});

describe('action overrides', () => {
  it('replaces the texts an admin set and keeps the defaults beside them', () => {
    const shaped = withActionOverrides(
      { name: 'a', description: 'Vendor text', guidance: 'Vendor hint', examples: ['One'] },
      {
        actions: {
          overrides: { a: { guidance: { en: 'Mine', de: 'Meins' }, examples: [{ de: 'Zwei' }] } }
        }
      },
      'de'
    );
    assert.equal(shaped.description, 'Vendor text');
    assert.equal(shaped.guidance, 'Meins');
    assert.deepEqual(shaped.examples, ['Zwei']);
    assert.deepEqual(shaped.overridden, { description: false, guidance: true, examples: true });
    assert.deepEqual(shaped.defaults, {
      description: 'Vendor text',
      guidance: 'Vendor hint',
      examples: ['One']
    });
  });

  it('builds no block for tools without guidance or instructions', () => {
    assert.equal(buildIntegrationGuidance([{ id: 'plain_tool' }]), '');
    assert.equal(
      buildIntegrationGuidance([{ id: 'x__a', _integration: { instanceId: 'x', action: 'a' } }]),
      ''
    );
  });
});

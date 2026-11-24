// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The project knowledge tools are the one thing the approval rule of personal
 * apps leaves out (design 07, section 2.4): a shared app that answers from a
 * project does not ask before every search. That rests on what the shipped
 * definition (`server/defaults/tools/knowledge.json`) declares, so this test
 * reads the real file:
 *
 *  - all three functions declare that they only read and keep the data inside iHub,
 *    and carry the mark of a shipped definition;
 *  - for a personal app the three do not ask, for any runner;
 *  - the tools a personal app can have beside them (the page reader, web search,
 *    a connected system) keep asking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readShippedToolDefinitions } from '../services/tools/shippedToolDefinitions.js';
import { KNOWLEDGE_TOOL_IDS } from '../services/knowledge/knowledgeTools.js';
import { resolveToolApproval, stampToolApproval } from '../utils/toolApproval.js';
import { effectiveUserApp } from '../services/userApps/ceiling.js';
import { userAppSettings } from '../services/userApps/userAppSettings.js';

const knowledge = readShippedToolDefinitions(['knowledge']);

test('the three functions declare that they only read and keep the data inside iHub', () => {
  assert.deepEqual([...knowledge.keys()], [...KNOWLEDGE_TOOL_IDS]);
  for (const [id, tool] of knowledge) {
    assert.equal(tool.sideEffect, 'read', id);
    assert.equal(tool.dataFlow, 'internal', id);
    assert.equal(tool._shipped, true, id);
  }
});

const principal = id => ({
  id,
  groups: ['users'],
  authMode: 'local',
  permissions: { apps: new Set(['*']), models: new Set(['*']), integrations: new Set(['*']) }
});

function personalApp(runner) {
  const anna = principal('anna');
  const record = {
    id: 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8',
    owner: { id: 'anna' },
    ownerPrincipal: { userId: 'anna', authMode: 'local', groups: ['users'], recorded: true },
    ownerPrincipalAt: new Date().toISOString(),
    content: { name: { en: 'A' }, description: { en: 'B' }, system: { en: 'C' } }
  };
  return effectiveUserApp(record, {
    runner,
    owner: anna,
    settings: userAppSettings({}),
    catalog: { models: [], installations: [], features: {}, webSearch: {}, skills: {} }
  }).app;
}

test('for a personal app the knowledge tools do not ask, for the owner and for everyone else', () => {
  for (const runner of [principal('anna'), principal('ben')]) {
    const app = personalApp(runner);
    for (const [id, tool] of knowledge) {
      const policy = resolveToolApproval(tool, app, {});
      assert.equal(policy.approval, 'never', `${id} for ${runner.id}`);
    }
  }
});

test('beside them the page reader, web search and a connected system keep asking someone else', () => {
  const app = personalApp(principal('ben'));
  const others = [
    { id: 'read_url', sideEffect: 'read', dataFlow: 'external' },
    { id: 'brave_search', sideEffect: 'read', dataFlow: 'external' },
    {
      id: 'wiki__search',
      _integration: { instanceId: 'wiki', action: 'search' },
      sideEffect: 'read'
    }
  ];
  const stamped = stampToolApproval([...knowledge.values(), ...others], app, {});
  const asks = Object.fromEntries(stamped.map(tool => [tool.id, tool.approval]));
  assert.deepEqual(asks, {
    knowledge_search: 'never',
    knowledge_read: 'never',
    knowledge_list: 'never',
    read_url: 'always',
    brave_search: 'always',
    wiki__search: 'always'
  });
});

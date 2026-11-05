// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Regression fixture for the tool ids of apps bound to the built-in
 * integrations (#2973): `getToolsForApp` returns, for each app in
 * `fixtures/builtin-app-tool-ids.json`, exactly the tool ids listed there —
 * iFinder, iAssistant, Jira, the web search engines and the iHub tools, by
 * kept tool id, base id, binding, narrowed binding and the chat's selection.
 *
 * It pins the ids before the legacy branches of the tool loader go (#2913):
 * a refactor that changes one of these lists changes what apps offer their
 * models, and has to change the fixture visibly. The order of the tools is
 * not part of the contract; the ids are compared as sets.
 *
 * The shipped definitions and native connectors are real; the installations,
 * the groups and the user are the fixture's. Scheduled tasks are on (storage
 * on a temporary directory), so the scheduling tools are listed.
 *
 * Run: node --test server/tests/builtin-app-tool-ids.test.js (part of `npm run test:server`)
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import configCache from '../configCache.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import { getToolsForApp } from '../services/tools/appTools.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { setUpWebSearch, tearDownWebSearch, useWebSearch } from './helpers/webSearchEngines.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures', 'builtin-app-tool-ids.json'), 'utf8')
);

let baseDir;
const originalGetFeatures = configCache.getFeatures;

before(async () => {
  await setUpWebSearch();
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-builtin-tool-ids-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.getFeatures = () => ({
    skills: false,
    appAsTool: false,
    chatPersistence: true,
    scheduledTasks: true
  });
  configCache.setCacheEntry('config/platform.json', {
    defaultLanguage: 'en',
    chats: { enabled: true },
    scheduledTasks: {}
  });
  // Each installation records its definition's current version, so a version
  // bump of a built-in does not turn the fixture into a pending migration.
  const installed = FIXTURE.installed.map(instance => ({
    ...instance,
    definitionVersion: integrationRegistry.get(instance.definition).definition.version
  }));
  useWebSearch({ installed, groups: FIXTURE.groups });
});

after(async () => {
  configCache.getFeatures = originalGetFeatures;
  tearDownWebSearch();
  await shutdownStorageBootstrap();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('tool ids of apps bound to the built-in integrations (#2973)', () => {
  it('the fixture covers iFinder, iAssistant, Jira, web search and the iHub tools', () => {
    const expected = new Set(FIXTURE.cases.flatMap(entry => entry.expectedToolIds));
    for (const id of [
      'iFinder_search',
      'iassistant__ask',
      'jira_addComment',
      'braveSearch',
      'ask_user'
    ]) {
      assert.ok(expected.has(id), `the fixture expects ${id} somewhere`);
    }
  });

  for (const entry of FIXTURE.cases) {
    it(entry.name, async () => {
      const tools = await getToolsForApp(structuredClone(entry.app), 'en', {
        user: structuredClone(FIXTURE.user),
        ...structuredClone(entry.context || {})
      });
      const ids = tools.map(tool => tool.id);
      assert.equal(new Set(ids).size, ids.length, `no tool twice: ${ids.join(', ')}`);
      assert.deepEqual([...ids].sort(), [...entry.expectedToolIds].sort());
    });
  }
});

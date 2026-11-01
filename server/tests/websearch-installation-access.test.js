#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `websearch` installation's enabled state and groups decide who gets web
 * search, whichever way it is asked for:
 *
 * - a workflow node (or an app) that lists `braveSearch` / `read_url` in its
 *   `tools` — the shipped `claude-style-agent` and `research-assistant`
 *   workflows do, and `PromptNodeExecutor` pushes `braveSearch` for models
 *   without native search — gets the installation's tools through
 *   `getAgentTools` → `getToolsForApp`;
 * - native search on Google, OpenAI or Anthropic (`resolveAppNativeWebSearch`);
 * - the search tool offered when a provider turns native search down
 *   (`resolveNativeWebSearchFallbackTools`).
 *
 * Run: node --test server/tests/websearch-installation-access.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import {
  getToolsForApp,
  isWebSearchAvailableTo,
  resolveAppNativeWebSearch,
  resolveNativeWebSearchFallbackTools,
  READ_URL_TOOL_ID
} from '../toolLoader.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

const PARAMETERS = JSON.parse(
  await readFile(
    new URL(
      '../services/integrations/protocols/native/connectors/websearch/parameters.json',
      import.meta.url
    ),
    'utf8'
  )
);
function connectorTool(action) {
  const spec = PARAMETERS[action];
  return {
    id: spec.toolId,
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    type: 'integration',
    _integration: {
      instanceId: 'websearch',
      action,
      definition: 'com.intrafind/web-search',
      fixedToolId: true
    }
  };
}

const brave = connectorTool('brave');
const qwant = connectorTool('qwant');
const reader = connectorTool('readUrl');
/** A tool of another installation, bound through `app.integrations` only. */
const portal = {
  id: 'portal__search',
  name: 'Portal: Search',
  parameters: { type: 'object', properties: {} },
  type: 'integration',
  _integration: { instanceId: 'portal', action: 'search', definition: 'test.portal' }
};
const jira = { id: 'jira', name: 'Jira', script: 'jira.js', parameters: { type: 'object' } };

const WEB_SEARCH = 'com.intrafind/web-search';
let installed;
const open = () => {
  installed = [{ id: 'websearch', definition: WEB_SEARCH, enabled: true }];
};
const closedTo = groups => {
  installed = [{ id: 'websearch', definition: WEB_SEARCH, enabled: true, allowedGroups: groups }];
};
configCache.getTools = () => ({ data: [brave, qwant, reader, portal, jira] });
configCache.getIntegrations = () => ({ data: { installed } });
// The installed-integration service reads the same file by its path.
const cachedConfig = configCache.get.bind(configCache);
configCache.get = configPath =>
  configPath === 'config/integrations.json' ? { data: { installed } } : cachedConfig(configPath);
configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getSources = () => ({ data: [] });
configCache.getFeatures = () => ({ skills: false });
mcpClientManager.listAllTools = async () => [];

const ids = list => list.map(t => t.id).sort();
const RESEARCHER = { id: 'u', groups: ['research'] };
const STAFF = { id: 'u', groups: ['staff'] };

describe('isWebSearchAvailableTo', () => {
  beforeEach(open);

  it('is true while the installation is on and has no groups', () => {
    assert.equal(isWebSearchAvailableTo(undefined), true);
    assert.equal(isWebSearchAvailableTo(STAFF), true);
  });

  it('is false while the installation is off or missing', () => {
    installed = [{ id: 'websearch', definition: WEB_SEARCH, enabled: false }];
    assert.equal(isWebSearchAvailableTo(RESEARCHER), false);
    installed = [];
    assert.equal(isWebSearchAvailableTo(RESEARCHER), false);
  });

  it('asks the groups when the installation has any', () => {
    closedTo(['research']);
    assert.equal(isWebSearchAvailableTo(RESEARCHER), true);
    assert.equal(isWebSearchAvailableTo(STAFF), false);
    assert.equal(isWebSearchAvailableTo(undefined), false);
  });
});

describe('a workflow node that lists the web search tools', () => {
  beforeEach(open);
  const executor = new PromptNodeExecutor({ llmClient: { complete: async () => ({}) } });
  const nodeTools = (toolIds, user) =>
    executor.getAgentTools(toolIds, 'en', { user, chatId: 'c1', _skillIds: [] });

  it('gets the search tool and the page reader from the installation', async () => {
    // The shape of claude-style-agent.json / research-assistant.json, and of
    // the `webSearch` fallback for a model without native search.
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url'], RESEARCHER)), [
      'braveSearch',
      READ_URL_TOOL_ID
    ]);
    assert.deepEqual(ids(await nodeTools(['braveSearch'], RESEARCHER)), ['braveSearch']);
    assert.deepEqual(ids(await nodeTools(['read_url'], undefined)), [READ_URL_TOOL_ID]);
  });

  it('gets the tool as the connector defines it, by its exact id', async () => {
    const [tool] = await nodeTools(['braveSearch'], RESEARCHER);
    assert.equal(tool._integration.instanceId, 'websearch');
    assert.equal(tool._integration.action, 'brave');
    assert.equal(tool.parameters.properties.query.type, 'string');
    // The installation id selects nothing through `tools`; neither does a base id.
    assert.deepEqual(ids(await nodeTools(['websearch'], RESEARCHER)), []);
    assert.deepEqual(ids(await nodeTools(['read'], RESEARCHER)), []);
  });

  it('gets nothing while the installation is off', async () => {
    installed = [{ id: 'websearch', definition: WEB_SEARCH, enabled: false }];
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url', 'jira'], RESEARCHER)), [
      'jira'
    ]);
  });

  it('gets nothing for a user outside the installation’s groups', async () => {
    closedTo(['research']);
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url'], STAFF)), []);
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url'], undefined)), []);
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url'], RESEARCHER)), [
      'braveSearch',
      READ_URL_TOOL_ID
    ]);
  });

  it('still gets no other installation’s tool through tools', async () => {
    assert.deepEqual(ids(await nodeTools(['portal__search', 'portal', 'jira'], RESEARCHER)), [
      'jira'
    ]);
  });
});

describe('an app that lists a web search tool in tools', () => {
  beforeEach(open);

  it('gets it from the installation, once, next to what app.websearch resolves', async () => {
    const app = {
      id: 'research',
      tools: ['braveSearch', 'read_url'],
      websearch: {
        enabled: true,
        provider: 'brave',
        useNativeSearch: false,
        enabledByDefault: true
      }
    };
    const offered = await getToolsForApp(app, 'en', { modelProvider: 'mistral', user: RESEARCHER });
    assert.deepEqual(ids(offered), ['braveSearch', READ_URL_TOOL_ID]);
  });

  it('gets the one it names even without app.websearch', async () => {
    const offered = await getToolsForApp({ id: 'a', tools: ['qwantSearch'] }, 'en', {
      modelProvider: 'mistral',
      user: STAFF
    });
    assert.deepEqual(ids(offered), ['qwantSearch']);
  });

  it('respects the chat’s narrowing like any other tool', async () => {
    const offered = await getToolsForApp({ id: 'a', tools: ['qwantSearch', 'read_url'] }, 'en', {
      modelProvider: 'mistral',
      user: STAFF,
      enabledTools: ['read_url']
    });
    assert.deepEqual(ids(offered), [READ_URL_TOOL_ID]);
  });
});

describe('native web search and the installation', () => {
  beforeEach(open);
  const app = {
    id: 'web-chat',
    websearch: { enabled: true, enabledByDefault: true, useNativeSearch: true }
  };

  it('is resolved for a user in the installation’s groups and not for one outside', () => {
    closedTo(['research']);
    for (const provider of ['google', 'openai-responses', 'anthropic']) {
      assert.equal(
        resolveAppNativeWebSearch(app, provider, undefined, undefined, RESEARCHER)?.provider,
        provider
      );
      assert.equal(resolveAppNativeWebSearch(app, provider, undefined, undefined, STAFF), null);
    }
  });

  it('is not resolved while the installation is off', () => {
    installed = [{ id: 'websearch', definition: WEB_SEARCH, enabled: false }];
    assert.equal(resolveAppNativeWebSearch(app, 'anthropic', undefined, undefined, STAFF), null);
  });

  it('offers no page reader next to it to a user outside the groups', async () => {
    closedTo(['research']);
    const outside = await getToolsForApp(app, 'en', { modelProvider: 'anthropic', user: STAFF });
    assert.deepEqual(ids(outside), []);
    const inside = await getToolsForApp(app, 'en', {
      modelProvider: 'anthropic',
      user: RESEARCHER
    });
    assert.deepEqual(ids(inside), [READ_URL_TOOL_ID]);
  });
});

describe('the fallback tool when a provider turns native search down', () => {
  beforeEach(open);
  const directive = { provider: 'anthropic', fallback: 'braveSearch' };
  const app = { id: 'web-chat', websearch: { enabled: true, provider: 'brave' } };

  it('is offered, with the page reader, to a user in the groups', async () => {
    closedTo(['research']);
    const offered = await resolveNativeWebSearchFallbackTools(directive, {
      app,
      language: 'en',
      user: RESEARCHER
    });
    assert.deepEqual(ids(offered), ['braveSearch', READ_URL_TOOL_ID]);
  });

  it('is not offered to a user outside the groups, nor while the installation is off', async () => {
    closedTo(['research']);
    assert.deepEqual(
      await resolveNativeWebSearchFallbackTools(directive, { app, language: 'en', user: STAFF }),
      []
    );
    assert.deepEqual(
      await resolveNativeWebSearchFallbackTools(directive, { app, language: 'en' }),
      []
    );
    installed = [{ id: 'websearch', definition: WEB_SEARCH, enabled: false }];
    assert.deepEqual(
      await resolveNativeWebSearchFallbackTools(directive, {
        app,
        language: 'en',
        user: RESEARCHER
      }),
      []
    );
  });
});

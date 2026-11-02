// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Workflow nodes bind their integration tools to a scope (#3057): a prompt or
 * tool node's `config.integrationScopes`, fixed in the definition or read
 * from a workflow input, is checked as the run's user and handed to the tool
 * after its arguments, so an `iFinder_*` call searches the node's profile
 * whatever the model passes. A scope the user may not use fails the node,
 * naming it, instead of searching elsewhere.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import iFinderService from '../services/integrations/iFinderService.js';
import iFinderSearchProfiles from '../services/integrations/iFinderSearchProfiles.js';
import {
  registerScopeProvider,
  resolveNamedScopes,
  unregisterScopeProvider
} from '../services/integrations/scopes/index.js';
import iFinderScopes from '../services/integrations/scopes/iFinderScopes.js';
import iFinderTool from '../tools/iFinder.js';
import { ToolNodeExecutor } from '../services/workflow/executors/ToolNodeExecutor.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';
import { resolveNodeScopes } from '../services/workflow/nodeScopes.js';
import { nodeConfigSchema } from '../validators/workflowConfigSchema.js';
import { stubInstallations } from './helpers/installedIFinder.js';

const USER = { id: 'user-1', email: 'u@example.com', groups: ['users'] };
// A workflow's tools run with the workflow's own settings, not an app that
// binds iFinder: the node names the integration itself.
const WORKFLOW_APP = { id: 'workflow-x', tools: ['iFinder_search'] };
const PROFILES = [
  { id: 'searchprofile-standard', name: 'Standard', isDefault: true },
  { id: 'contracts', name: 'Contracts', isDefault: false },
  { id: 'hr', name: 'HR policies', isDefault: false }
];

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const originals = {};
let searched;
let platform;

beforeEach(() => {
  originals.getPlatform = configCache.getPlatform;
  originals.getUserSearchProfiles = iFinderSearchProfiles.getUserSearchProfiles;
  originals.search = iFinderService.search;
  platform = {
    iFinder: {
      enabled: true,
      baseUrl: 'https://ifinder.example',
      defaultSearchProfile: 'searchprofile-standard'
    }
  };
  configCache.getPlatform = () => platform;
  originals.restoreInstallations = stubInstallations(configCache, () => platform);
  iFinderService.resetConfig();
  iFinderSearchProfiles.getUserSearchProfiles = async () => PROFILES;
  searched = [];
  iFinderService.search = async params => {
    searched.push(params.searchProfile);
    return { searchProfile: params.searchProfile, results: [] };
  };
  registerScopeProvider(iFinderScopes);
});

afterEach(() => {
  configCache.getPlatform = originals.getPlatform;
  originals.restoreInstallations();
  iFinderSearchProfiles.getUserSearchProfiles = originals.getUserSearchProfiles;
  iFinderService.search = originals.search;
  iFinderService.resetConfig();
  unregisterScopeProvider('ifinder');
});

const context = (extra = {}) => ({
  user: USER,
  chatId: 'wf-exec-1',
  appConfig: WORKFLOW_APP,
  language: 'en',
  ...extra
});

/** A tool node whose tool call is handed to the real iFinder tool. */
function toolNodeExecutor() {
  const executor = new ToolNodeExecutor({ logger: silent });
  const calls = [];
  executor.executeWithTimeout = async (toolId, params) => {
    calls.push({ toolId, params });
    return iFinderTool.search(params);
  };
  return { executor, calls };
}

describe('resolveNamedScopes', () => {
  it('keeps a scope the user may use, for an integration the node names itself', async () => {
    const result = await resolveNamedScopes({
      requested: { ifinder: 'contracts' },
      user: USER,
      app: WORKFLOW_APP
    });
    assert.deepEqual(result, { ok: true, scopes: { ifinder: 'contracts' } });
  });

  it('refuses a scope the user may not use, and an integration that offers none', async () => {
    const refused = await resolveNamedScopes({
      requested: { ifinder: 'board-minutes' },
      user: USER,
      app: WORKFLOW_APP
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.integrationId, 'ifinder');
    assert.equal(refused.code, 'INTEGRATION_SCOPE_NOT_ALLOWED');
    assert.match(refused.message, /"board-minutes"/);

    const missing = await resolveNamedScopes({
      requested: { sharepoint: 'legal' },
      user: USER,
      app: WORKFLOW_APP
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.integrationId, 'sharepoint');
    assert.match(missing.message, /"legal"/);

    assert.equal(
      (await resolveNamedScopes({ requested: { ifinder: 42 }, user: USER })).code,
      'INVALID_INTEGRATION_SCOPE'
    );
    assert.deepEqual(await resolveNamedScopes({ requested: undefined, user: USER }), {
      ok: true,
      scopes: {}
    });
  });

  it('applies a profile the installation pins', async () => {
    platform.iFinder.allowUserSearchProfileChange = false;
    iFinderService.resetConfig();
    const result = await resolveNamedScopes({
      requested: { ifinder: 'contracts' },
      user: USER,
      app: WORKFLOW_APP
    });
    assert.deepEqual(result, { ok: true, scopes: { ifinder: 'searchprofile-standard' } });
  });
});

describe('a tool node with a scope', () => {
  it('searches the node’s profile, whatever its parameters name', async () => {
    const { executor, calls } = toolNodeExecutor();
    const result = await executor.execute(
      {
        id: 'search',
        type: 'tool',
        config: {
          toolId: 'iFinder_search',
          parameters: {
            query: 'notice period',
            searchProfile: 'hr',
            integrationScopes: { ifinder: 'hr' }
          },
          integrationScopes: { ifinder: 'contracts' }
        }
      },
      { data: {} },
      context()
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls[0].params.integrationScopes, { ifinder: 'contracts' });
    assert.deepEqual(searched, ['contracts']);
    // The execution view shows the scope the call ran in.
    assert.deepEqual(result.resolvedInputs.integrationScopes, { ifinder: 'contracts' });
  });

  it('takes the scope from a workflow input; an empty input leaves it unscoped', async () => {
    const node = {
      id: 'search',
      type: 'tool',
      config: {
        toolId: 'iFinder_search',
        parameters: { query: 'x' },
        integrationScopes: { ifinder: '$.data.searchProfile' }
      }
    };
    const { executor, calls } = toolNodeExecutor();
    await executor.execute(node, { data: { searchProfile: 'hr' } }, context());
    await executor.execute(node, { data: {} }, context());
    assert.deepEqual(
      calls.map(call => call.params.integrationScopes),
      [{ ifinder: 'hr' }, {}]
    );
    assert.deepEqual(searched, ['hr', 'searchprofile-standard']);
  });

  it('fails, naming the scope, when the user may not use it; nothing is searched', async () => {
    const { executor, calls } = toolNodeExecutor();
    const result = await executor.execute(
      {
        id: 'search',
        type: 'tool',
        config: {
          toolId: 'iFinder_search',
          parameters: { query: 'x' },
          optional: true,
          integrationScopes: { ifinder: 'board-minutes' }
        }
      },
      { data: {} },
      context()
    );
    assert.equal(result.status, 'failed');
    assert.match(result.error, /ifinder/);
    assert.match(result.error, /"board-minutes"/);
    assert.equal(result.details.code, 'INTEGRATION_SCOPE_NOT_ALLOWED');
    assert.deepEqual(calls, []);
    assert.deepEqual(searched, []);
  });
});

describe('a prompt node with a scope', () => {
  it('hands the node’s scope to every tool call, after the model’s arguments', async () => {
    const executor = new PromptNodeExecutor({
      logger: silent,
      runTool: (toolId, params) => iFinderTool.search(params)
    });
    const tools = [{ id: 'iFinder_search', name: 'iFinder_search' }];
    await executor.executeToolCall(
      {
        id: 'call_1',
        function: {
          name: 'iFinder_search',
          arguments: JSON.stringify({ query: 'x', searchProfile: 'hr' })
        }
      },
      tools,
      context({ integrationScopes: { ifinder: 'contracts' } })
    );
    assert.deepEqual(searched, ['contracts']);
  });

  it('fails the node, naming the scope, before any model call', async () => {
    const executor = new PromptNodeExecutor({
      logger: silent,
      llmClient: {
        execute: async () => {
          throw new Error('the model must not be asked');
        }
      }
    });
    const result = await executor.execute(
      {
        id: 'agent',
        type: 'agent',
        config: {
          system: 'Research.',
          prompt: 'Find contracts',
          tools: ['iFinder_search'],
          integrationScopes: { ifinder: 'board-minutes' }
        }
      },
      { data: {} },
      context()
    );
    assert.equal(result.status, 'failed');
    assert.match(result.error, /"board-minutes"/);
    assert.equal(result.details.code, 'INTEGRATION_SCOPE_NOT_ALLOWED');
  });

  it('tells the model the profile is fixed and drops iFinder_listProfiles', async () => {
    const { applyIntegrationScopes } = await import('../services/chat/RequestBuilder.js');
    const messages = [{ role: 'system', content: 'Research.' }];
    const tools = applyIntegrationScopes(
      messages,
      [{ id: 'iFinder_search' }, { id: 'iFinder_listProfiles' }],
      { ifinder: 'contracts' }
    );
    assert.deepEqual(
      tools.map(tool => tool.id),
      ['iFinder_search']
    );
    assert.match(messages[0].content, /"contracts"/);
  });
});

describe('the workflow definition', () => {
  it('accepts integrationScopes on a node and refuses a malformed one', () => {
    const node = scopes => ({
      id: 'search',
      type: 'tool',
      name: { en: 'Search' },
      position: { x: 0, y: 0 },
      config: { toolId: 'iFinder_search', integrationScopes: scopes }
    });
    assert.equal(nodeConfigSchema.safeParse(node({ ifinder: 'contracts' })).success, true);
    assert.equal(
      nodeConfigSchema.safeParse(node({ ifinder: '$.data.searchProfile' })).success,
      true
    );
    assert.equal(nodeConfigSchema.safeParse(node({ ifinder: '' })).success, false);
    assert.equal(nodeConfigSchema.safeParse(node('contracts')).success, false);
  });

  it('resolves nothing for a node without scopes', async () => {
    const executor = new ToolNodeExecutor({ logger: silent });
    assert.deepEqual(await resolveNodeScopes({ config: {} }, { data: {} }, context(), executor), {
      ok: true,
      scopes: {}
    });
  });
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The platform tools of workflows and agents — the agent workspace
 * (`write_artifact`, `read_memory`, `write_memory`, `read_inbox`,
 * `write_inbox`, `create_task`, `list_tasks`, `mark_task_done`) and the
 * evidence tools (`evidence_*`) — are plain tools owned by those features,
 * not actions of the iHub integration. Everything that resolves them by id
 * keeps working as it did with their tool files: workflow prompt nodes and
 * agent runs, apps, group grants, `runTool`, a scheduled run's memory tools;
 * and a file of the same id in `contents/tools/` still takes their place.
 *
 * Run: node --test server/tests/platform-tools.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import configCache from '../configCache.js';
import '../services/integrations/protocols/native/connectors/register.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import { getToolsForApp, loadLocalTools, loadTools, runTool } from '../toolLoader.js';
import {
  PLATFORM_TOOL_FILE_IDS,
  PLATFORM_TOOL_IDS,
  isPlatformTool,
  platformToolDefinitions
} from '../services/tools/platformTools.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';
import { getAgentToolIds } from '../agents/runtime/agentToolRegistrar.js';
import { addMemoryTools } from '../services/scheduler/tasks/runMemory.js';
import { copyDefaultConfiguration } from '../utils/setupUtils.js';

const AGENT_WORKSPACE = [
  'create_task',
  'list_tasks',
  'mark_task_done',
  'read_inbox',
  'read_memory',
  'write_artifact',
  'write_inbox',
  'write_memory'
];
const EVIDENCE = ['evidence_collect', 'evidence_validateQuotesFastPath', 'evidence_composeReport'];

const everything = { tools: new Set(['*']), apps: new Set(['*']) };
const member = { id: 'member', groups: ['users'], permissions: everything };
const ids = tools => tools.map(tool => tool.id).sort();

function setIntegrations(installed = []) {
  configCache.setCacheEntry('config/integrations.json', {
    installed,
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
}

/** The `ihub` installation with every moved tool switched off, as a pre-V201 file could say. */
const ihubSwitchingEverythingOff = {
  id: 'ihub',
  definition: 'com.intrafind/ihub',
  enabled: true,
  values: {},
  auth: { mode: 'none' },
  actions: { enabled: ['*'], disabled: [...AGENT_WORKSPACE, ...EVIDENCE], overrides: {} }
};

const originalGetFeatures = configCache.getFeatures;

before(async () => {
  await integrationRegistry.ensureLoaded();
  configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
  configCache.setCacheEntry('config/groups.json', { groups: { users: {} } });
  configCache.setCacheEntry('config/apps.json', []);
  configCache.getFeatures = () => ({ skills: false, appAsTool: false, projects: true });
});

beforeEach(() => {
  configCache.setCacheEntry('config/tools.json', []);
  setIntegrations();
});

after(() => {
  configCache.getFeatures = originalGetFeatures;
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
});

describe('the platform tools', () => {
  it('are the agent workspace and evidence tools of the shipped files', () => {
    assert.deepEqual([...PLATFORM_TOOL_FILE_IDS].sort(), [...AGENT_WORKSPACE, 'evidence'].sort());
    assert.deepEqual([...PLATFORM_TOOL_IDS].sort(), [...AGENT_WORKSPACE, ...EVIDENCE].sort());
    assert.equal(isPlatformTool('write_artifact'), true);
    assert.equal(isPlatformTool('ask_user'), false);
    // Fresh copies: a caller changing one does not change the next.
    platformToolDefinitions()[0].description = 'changed';
    assert.notEqual(platformToolDefinitions()[0].description, 'changed');
  });

  it('are loaded as plain, localized tools with their flags', async () => {
    const tools = await loadTools('de');
    for (const id of [...AGENT_WORKSPACE, ...EVIDENCE]) {
      const tool = tools.find(t => t.id === id);
      assert.ok(tool, `${id} is loaded`);
      assert.equal(tool._integration, undefined, `${id} belongs to no integration`);
      assert.equal(typeof tool.description, 'string', `${id} is localized`);
    }
    const writeMemory = tools.find(t => t.id === 'write_memory');
    assert.equal(writeMemory.isAgentTool, true);
    assert.equal(writeMemory.script, 'agentTools.js');
    assert.equal(writeMemory.method, 'writeMemory');
    const collect = tools.find(t => t.id === 'evidence_collect');
    assert.equal(collect.method, 'collect');
    assert.equal(typeof collect.parameters.properties.extraction.description, 'string');
  });

  it('do not follow the ihub installation’s action switches or groups', async () => {
    setIntegrations([ihubSwitchingEverythingOff]);
    const tools = await loadTools('en');
    for (const id of [...AGENT_WORKSPACE, ...EVIDENCE]) {
      assert.ok(
        tools.some(t => t.id === id),
        `${id} is loaded`
      );
    }
    const offered = await getToolsForApp({ id: 'a', tools: ['write_artifact', 'evidence'] }, 'en', {
      user: member
    });
    assert.deepEqual(ids(offered), ['write_artifact', ...EVIDENCE].sort());
  });

  it('give way to a tool file of the same id in contents/tools, enabled or not', async () => {
    configCache.setCacheEntry('config/tools.json', [
      {
        id: 'write_artifact',
        name: 'write_artifact',
        description: { en: 'Our own wording' },
        script: 'agentTools.js',
        method: 'writeArtifact'
      },
      { id: 'read_inbox', name: 'read_inbox', script: 'agentTools.js', enabled: false }
    ]);
    const tools = await loadTools('en');
    assert.equal(tools.find(t => t.id === 'write_artifact').description, 'Our own wording');
    assert.equal(
      tools.some(t => t.id === 'read_inbox'),
      false,
      'a disabled file keeps the tool off'
    );
    assert.equal(tools.filter(t => t.id === 'write_artifact').length, 1);
  });

  it('are not seeded into contents/tools by the initial setup, which would shadow them', async () => {
    const contentsPath = mkdtempSync(path.join(os.tmpdir(), 'platform-tools-seed-'));
    try {
      await copyDefaultConfiguration({ contentsPath });
      const toolsDir = path.join(contentsPath, 'tools');
      assert.ok(existsSync(toolsDir), 'the tools directory is still created');
      // Neither the platform tools, nor iHub's own, nor the knowledge tools.
      assert.deepEqual(readdirSync(toolsDir), []);
    } finally {
      rmSync(contentsPath, { recursive: true, force: true });
    }
  });
});

describe('resolving the platform tools by id', () => {
  const executor = new PromptNodeExecutor({ llmClient: { complete: async () => ({}) } });
  const nodeTools = toolIds =>
    executor.getAgentTools(toolIds, 'en', { user: member, chatId: 'c1', _skillIds: [] });

  it('a workflow prompt node gets the tools it names, a base id included', async () => {
    assert.deepEqual(
      ids(await nodeTools(['write_artifact', 'read_memory', 'evidence'])),
      [...EVIDENCE, 'read_memory', 'write_artifact'].sort()
    );
  });

  it('an agent run gets the tools its registrar attaches', async () => {
    const attached = getAgentToolIds(
      { memory: { enabled: true }, dynamicTasks: { enabled: true } },
      {}
    );
    const resolved = ids(await nodeTools(attached));
    // `set_plan` and `update_task` are handled by the runtime and have no definition.
    assert.deepEqual(resolved, ['create_task', 'list_tasks', 'read_memory', 'write_memory']);
  });

  it('a group grant lists them by exact or base id', async () => {
    const grantee = { id: 'g', groups: ['users'], permissions: { tools: new Set(['evidence']) } };
    const { data } = await configCache.getToolsForUser(grantee, { defaultLanguage: 'en' }, 'en');
    assert.deepEqual(ids(data), [...EVIDENCE].sort());
  });

  it('the inbound MCP gateway lists them with iHub’s local tools, not the iHub actions', async () => {
    const local = await loadLocalTools('en');
    assert.deepEqual(
      ids(local.filter(tool => [...AGENT_WORKSPACE, ...EVIDENCE].includes(tool.id))),
      [...AGENT_WORKSPACE, ...EVIDENCE].sort()
    );
    assert.equal(
      local.some(tool => tool._integration || tool.id === 'ask_user'),
      false,
      'installed integrations stay out of the gateway'
    );
  });

  it('runTool runs them through their script', async () => {
    const result = await runTool('evidence_validateQuotesFastPath', {
      quotes: ['the deposit is returned'],
      sourceText: 'The lease says: the deposit is returned within 30 days.'
    });
    assert.equal(result.ok, true);
    assert.equal(result.summary.total, 1);
  });

  it('a scheduled run with memory gets the memory tools and the run history tools', async () => {
    const prepared = { tools: [] };
    const { added, missing } = await addMemoryTools(prepared, 'en');
    assert.deepEqual(missing, []);
    assert.deepEqual(added, ['read_memory', 'write_memory', 'list_task_runs', 'get_task_run']);
    // The memory tools are platform tools, the history tools iHub actions.
    const byId = Object.fromEntries(prepared.tools.map(tool => [tool.id, tool]));
    assert.equal(byId.read_memory._integration, undefined);
    assert.equal(byId.list_task_runs._integration?.instanceId, 'ihub');
  });
});

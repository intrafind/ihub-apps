// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a workflow node, agent profile or planner template can use
 * (`integrations`, `systemTools`, `webSearch`), the planner's per-task pick,
 * and the tools such a node is offered (`getToolsForNode`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { getToolsForNode } from '../services/tools/appTools.js';
import {
  capabilitiesOf,
  hasCapabilities,
  pickCapabilities
} from '../services/workflow/nodeCapabilities.js';
import { SubWorkflowMaterializer } from '../services/workflow/SubWorkflowMaterializer.js';
import {
  FIXTURE_OPEN_GROUPS,
  fixtureIntegrationTool,
  fixtureIntegrations
} from './helpers/integrationToolFixture.js';

const template = {
  integrations: { lookup: { actions: ['lookup'] }, other: {} },
  systemTools: ['read_url', 'write_artifact'],
  webSearch: true
};

describe('capabilitiesOf / pickCapabilities', () => {
  it('names the integration keys, the platform tools and webSearch', () => {
    assert.deepEqual(capabilitiesOf(template), [
      'lookup',
      'other',
      'read_url',
      'write_artifact',
      'webSearch'
    ]);
    assert.deepEqual(capabilitiesOf({}), []);
    assert.equal(hasCapabilities({}), false);
    assert.equal(hasCapabilities({ webSearch: true }), true);
  });

  it('picks a subset and drops ids the template does not offer', () => {
    assert.deepEqual(pickCapabilities(template, ['lookup', 'read_url', 'invented']), {
      integrations: { lookup: { actions: ['lookup'] } },
      systemTools: ['read_url'],
      webSearch: false
    });
    assert.equal(pickCapabilities(template, ['webSearch']).webSearch, true);
    assert.deepEqual(pickCapabilities(template, []), {
      integrations: {},
      systemTools: [],
      webSearch: false
    });
  });
});

describe('materialized planner tasks', () => {
  const plan = tasks => ({ tasks });
  const nodesOf = definition => definition.nodes.filter(node => node.config?._isPlannerTask);

  it('inherit the template, or take exactly the capabilities the planner picked', () => {
    const parent = { taskTemplate: { ...template, system: { en: 'Do it' } } };
    const definition = SubWorkflowMaterializer.materialize(
      plan([
        { id: 't1', title: 'inherits' },
        { id: 't2', title: 'search only', tools: ['webSearch'] },
        { id: 't3', title: 'none', tools: [] }
      ]),
      parent,
      1
    );
    const [t1, t2, t3] = nodesOf(definition);
    assert.deepEqual(Object.keys(t1.config.integrations), ['lookup', 'other']);
    assert.deepEqual(t1.config.systemTools, ['read_url', 'write_artifact']);
    assert.equal(t1.config.webSearch, true);
    assert.deepEqual(t2.config.integrations, {});
    assert.deepEqual(t2.config.systemTools, []);
    assert.equal(t2.config.webSearch, true);
    assert.equal(t3.config.webSearch, false);
    assert.equal('tools' in t1.config, false);
  });
});

describe('getToolsForNode', () => {
  const user = { id: 'u', groups: ['users'] };

  before(() => {
    configCache.getFeatures = () => ({ skills: false, appAsTool: false });
    configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
    configCache.setCacheEntry('config/tools.json', [fixtureIntegrationTool('lookup')]);
    configCache.setCacheEntry('config/integrations.json', fixtureIntegrations('lookup'));
    configCache.setCacheEntry('config/groups.json', { groups: { ...FIXTURE_OPEN_GROUPS } });
  });
  after(() => {
    for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
  });

  const ids = async node => (await getToolsForNode(node, 'en', { user })).map(tool => tool.id);

  it('offers the bound integrations and the named platform tools, by exact or base id', async () => {
    assert.deepEqual(await ids({ integrations: { lookup: {} } }), ['lookup']);
    assert.deepEqual(await ids({ systemTools: ['read_url'] }), ['read_url']);
    assert.deepEqual((await ids({ systemTools: ['evidence'] })).sort(), [
      'evidence_collect',
      'evidence_composeReport',
      'evidence_validateQuotesFastPath'
    ]);
  });

  it('offers no integration tool by a tool reference, and no integration without its grant', async () => {
    assert.deepEqual(await ids({ systemTools: ['lookup'] }), []);
    const guest = { id: 'g', groups: ['nobody'], permissions: { integrations: new Set() } };
    assert.deepEqual(
      (await getToolsForNode({ integrations: { lookup: {} } }, 'en', { user: guest })).map(
        t => t.id
      ),
      []
    );
  });
});

#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The built-in web search engine connectors (`brave`, `staan`, `qwant`): one
 * action `search` under the historical tool id, the shipped definitions that
 * name them, and the installation test, which checks the key of the values
 * under test (credential, environment variable) and runs one live search with
 * that key.
 *
 * Run: node --test server/tests/websearch-engine-connectors.test.js
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import credentialService from '../services/CredentialService.js';
import webSearchService from '../services/WebSearchService.js';
import {
  apiKeyStep,
  braveSearchConnector,
  qwantSearchConnector,
  staanSearchConnector
} from '../services/integrations/protocols/native/connectors/websearch/index.js';
import { getConnector } from '../services/integrations/protocols/native/connectors/index.js';
import '../services/integrations/protocols/native/connectors/register.js';
import { integrationDefinitionSchema } from '../validators/integrationDefinitionSchema.js';
import { BUILT_IN_ENGINES } from '../services/search/webSearchEngines.js';

const definitionOf = async id =>
  JSON.parse(
    await readFile(
      new URL(
        `../defaults/integration-definitions/com.intrafind__${id}-search/integration.json`,
        import.meta.url
      ),
      'utf8'
    )
  );

const SECRETS = { 'brave-key': 'secret-brave', 'empty-key': '' };
let savedResolve;
let savedSearch;
let savedEnv;
let searches;

before(() => {
  savedResolve = credentialService.tryResolveSecret;
  savedSearch = webSearchService.search;
  credentialService.tryResolveSecret = ref => SECRETS[ref] ?? null;
});
beforeEach(() => {
  savedEnv = { brave: process.env.BRAVE_SEARCH_API_KEY, staan: process.env.STAAN_API_KEY };
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.STAAN_API_KEY;
  searches = [];
  webSearchService.search = async (query, options) => {
    searches.push({ query, options });
    return { results: [{ title: 'Hit', url: 'https://example.com/' }] };
  };
});
after(() => {
  credentialService.tryResolveSecret = savedResolve;
  webSearchService.search = savedSearch;
  for (const [name, value] of [
    ['BRAVE_SEARCH_API_KEY', savedEnv?.brave],
    ['STAAN_API_KEY', savedEnv?.staan]
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('definitions and connectors', () => {
  for (const { id, toolId, definition } of BUILT_IN_ENGINES) {
    it(`${id}: a valid built-in web-search singleton with one search action`, async () => {
      const def = await definitionOf(id);
      const parsed = integrationDefinitionSchema.safeParse(def);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
      assert.equal(def.id, definition);
      assert.equal(def.type, 'web-search');
      assert.equal(def.builtIn, true);
      assert.equal(def.singleton.instanceId, id);
      assert.equal(def.version, '1.0.0');
      assert.equal(def.releases[0].version, '1.0.0');
      assert.deepEqual(
        def.actions.map(action => [action.name, action.toolId]),
        [['search', toolId]]
      );
      const connector = getConnector(def.protocol.module);
      assert.ok(connector, `connector ${def.protocol.module} is registered`);
      assert.deepEqual(Object.keys(connector.actions), ['search']);
      assert.equal(connector.actions.search.parameters.properties.query.type, 'string');
    });
  }

  it('Brave and Staan take a credential API key; Qwant has no field', async () => {
    for (const id of ['brave', 'staan']) {
      const def = await definitionOf(id);
      assert.deepEqual(
        def.install.map(field => [field.key, field.type, field.credentialTypes]),
        [['apiKeyRef', 'credential', ['secret']]]
      );
    }
    assert.deepEqual((await definitionOf('qwant')).install, []);
  });
});

describe('the API key step', () => {
  it('reads the credential of the values under test', () => {
    const { step, key } = apiKeyStep('brave', { apiKeyRef: 'brave-key' });
    assert.equal(step.status, 'ok');
    assert.equal(key, 'secret-brave');
    assert.match(step.message, /credential "brave-key"/);
  });

  it('falls back to the environment variable', () => {
    process.env.STAAN_API_KEY = 'from-env';
    const { step, key } = apiKeyStep('staan', {});
    assert.equal(step.status, 'ok');
    assert.equal(key, 'from-env');
    assert.match(step.message, /STAAN_API_KEY/);
  });

  it('warns when a referenced credential is empty and the variable stood in', () => {
    process.env.BRAVE_SEARCH_API_KEY = 'from-env';
    const { step } = apiKeyStep('brave', { apiKeyRef: 'empty-key' });
    assert.equal(step.status, 'warn');
  });

  it('fails without any key, and says what to set', () => {
    const { step } = apiKeyStep('brave', {});
    assert.equal(step.status, 'fail');
    assert.match(step.message, /BRAVE_SEARCH_API_KEY/);
  });

  it('needs nothing for Qwant', () => {
    assert.equal(apiKeyStep('qwant', {}).step.status, 'ok');
  });
});

describe('the installation test', () => {
  it('searches once with the key under test, bypassing the cache', async () => {
    const steps = await braveSearchConnector.test({ values: { apiKeyRef: 'brave-key' } });
    assert.deepEqual(
      steps.map(step => [step.id, step.status]),
      [
        ['key', 'ok'],
        ['search', 'ok']
      ]
    );
    assert.equal(searches.length, 1);
    assert.equal(searches[0].options.provider, 'brave');
    assert.equal(searches[0].options.apiKey, 'secret-brave');
    assert.equal(searches[0].options.skipCache, true);
  });

  it('does not search without a key', async () => {
    const steps = await staanSearchConnector.test({ values: {} });
    assert.deepEqual(
      steps.map(step => step.id),
      ['key']
    );
    assert.equal(searches.length, 0);
  });

  it('reports a failed search with the diagnosis', async () => {
    webSearchService.search = async () => {
      const error = new Error('captcha');
      error.code = 'QWANT_CAPTCHA';
      throw error;
    };
    const steps = await qwantSearchConnector.test({ values: {} });
    assert.equal(steps[1].id, 'search');
    assert.equal(steps[1].status, 'fail');
  });
});

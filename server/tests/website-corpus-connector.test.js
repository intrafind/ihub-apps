// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Website Corpus integration as iHub loads it: the shipped definition is
 * valid and matches the connector's actions, and the connector turns the
 * failures a model can act on into error results.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateIntegrationDefinition } from '../validators/integrationDefinitionSchema.js';
import { getConnector } from '../services/integrations/protocols/native/connectors/index.js';
import '../services/integrations/protocols/native/connectors/register.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(
  here,
  '..',
  'defaults',
  'integration-definitions',
  'com.intrafind__website-corpus'
);
const definition = JSON.parse(fs.readFileSync(path.join(DIR, 'integration.json'), 'utf8'));

describe('Website Corpus integration', () => {
  it('ships a valid definition with release notes', () => {
    const result = validateIntegrationDefinition(definition);
    assert.equal(result.success, true, JSON.stringify(result.errors));
    for (const release of definition.releases) {
      for (const note of Object.values(release.notes || {})) {
        assert.ok(fs.existsSync(path.join(DIR, note)), `${note} exists`);
      }
    }
    assert.equal(definition.version, definition.releases[0].version);
  });

  it('is a singleton native integration that needs no sign-in', () => {
    assert.equal(definition.protocol.type, 'native');
    assert.equal(definition.singleton.instanceId, 'website-corpus');
    assert.deepEqual(definition.auth.modes, ['none']);
    assert.equal(definition.builtIn, true);
  });

  it('has a registered connector that implements every declared action', () => {
    const connector = getConnector(definition.protocol.module);
    assert.ok(connector, 'the connector is registered');
    for (const action of definition.actions) {
      const impl = connector.actions[action.name];
      assert.ok(impl, `${action.name} is implemented`);
      assert.equal(impl.parameters.type, 'object');
      assert.ok(Array.isArray(impl.parameters.required) && impl.parameters.required.length > 0);
      assert.equal(typeof impl.run, 'function');
    }
    assert.deepEqual(
      Object.keys(connector.actions).sort(),
      definition.actions.map(a => a.name).sort()
    );
  });

  it('gives every action a distinct tool id', () => {
    const ids = definition.actions.map(action => action.toolId);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => /^[a-z][a-z0-9_]*$/.test(id)));
  });

  it('declares what each action does to the website and where its data goes', () => {
    const policy = Object.fromEntries(
      definition.actions.map(action => [action.name, [action.sideEffect, action.dataFlow]])
    );
    // Nothing writes to a website; only the steps that fetch from it leave the server.
    assert.deepEqual(policy, {
      discover_site: ['read', 'external'],
      outline_pages: ['read', 'external'],
      crawl_pages: ['read', 'external'],
      read_page_text: ['read', 'internal'],
      corpus_report: ['read', 'internal'],
      // Creates a request for an admin in iHub's own store: a write, so users confirm it.
      request_domain: ['write', 'internal']
    });
  });

  it('keeps company-internal addresses off unless the admin switches them on', () => {
    const field = definition.install.find(item => item.key === 'allowPrivateAddresses');
    assert.equal(field.type, 'boolean');
    assert.equal(field.default, false);
    assert.match(
      field.description.en,
      /Loopback, link-local and cloud metadata addresses stay blocked/
    );
  });

  it('offers a maxPages setting within the service cap', () => {
    const field = definition.install.find(item => item.key === 'maxPages');
    assert.equal(field.type, 'number');
    assert.ok(field.default >= field.min && field.default <= field.max);
  });

  it('returns a failure the model can act on as an error result, not a throw', async () => {
    const connector = getConnector('websiteCorpus');
    const user = { id: 'u1' };
    assert.deepEqual(
      await connector.actions.discover_site.run({ siteUrl: 'ftp://a.test' }, { user, values: {} }),
      {
        error: true,
        code: 'INVALID_URL',
        message: 'siteUrl must be an http(s) address'
      }
    );
    const anonymous = await connector.actions.discover_site.run(
      { siteUrl: 'https://a.test' },
      { user: { id: 'anonymous' }, values: {} }
    );
    assert.equal(anonymous.error, true);
    assert.equal(anonymous.code, 'SIGN_IN_REQUIRED');
  });

  it('says so when the storage provider cannot keep a crawl', async () => {
    const connector = getConnector('websiteCorpus');
    const result = await connector.actions.corpus_report.run(
      { corpusId: 'wc_x' },
      { user: { id: 'u1' }, values: {} }
    );
    assert.equal(result.error, true);
    assert.equal(result.code, 'STORAGE_UNAVAILABLE');
    const steps = await connector.test();
    assert.equal(steps.find(step => step.id === 'storage').status, 'fail');
  });
});

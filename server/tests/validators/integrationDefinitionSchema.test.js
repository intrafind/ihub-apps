// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import {
  validateIntegrationDefinition,
  checkInstallValues,
  definitionIdToDirName,
  dirNameToDefinitionId
} from '../../validators/integrationDefinitionSchema.js';
import {
  validateIntegrationsConfig,
  validateInstalledIntegration
} from '../../validators/integrationsConfigSchema.js';

const base = {
  id: 'org.ckan/open-data-portal',
  version: '0.1.0',
  name: { en: 'CKAN Open Data Portal', de: 'CKAN Open-Data-Portal' },
  protocol: { type: 'openapi', document: 'ckan-openapi.json', baseUrl: '{baseUrl}{apiPath}' },
  auth: {
    modes: ['none', 'service-account'],
    serviceAccount: { kind: 'header', header: '{tokenHeader}', field: 'apiToken' }
  },
  install: [
    {
      key: 'baseUrl',
      type: 'url',
      title: { en: 'Portal URL' },
      required: true,
      injectAs: 'urlVariable'
    },
    {
      key: 'apiPath',
      type: 'string',
      title: { en: 'API path' },
      default: '/api/3/action',
      advanced: true
    },
    {
      key: 'tokenHeader',
      type: 'string',
      title: { en: 'Header' },
      default: 'Authorization',
      pattern: '^[A-Za-z0-9-]+$'
    },
    { key: 'apiToken', type: 'secret', title: { en: 'API token' }, injectAs: 'header' },
    { key: 'maxRows', type: 'number', title: { en: 'Rows' }, default: 10, min: 1, max: 50 },
    { key: 'datastoreSql', type: 'boolean', title: { en: 'SQL' }, default: false },
    {
      key: 'metadataProfile',
      type: 'enum',
      title: { en: 'Profile' },
      choices: [
        { value: 'ckan', label: { en: 'Plain CKAN' } },
        { value: 'dcat-ap-de', label: { en: 'DCAT-AP.de' }, requires: ['apiPath'] }
      ],
      default: 'ckan'
    }
  ],
  capabilities: ['tools', 'scopes', 'sources'],
  scopes: {
    action: 'list_organizations',
    label: { en: 'Publisher' },
    map: { id: 'name', name: 'title' },
    applyAs: { 'search_datasets.fq': { value: 'organization:{id}', mode: 'append' } }
  },
  sources: {
    search_datasets: {
      list: 'results',
      fields: { title: 'title', snippet: 'notes' },
      urlTemplate: '{baseUrl}/dataset/{name}'
    }
  },
  health: { action: 'search_datasets', args: { rows: 0 } },
  actions: [
    {
      name: 'search_datasets',
      operationId: 'package_search',
      sideEffect: 'read',
      defaults: {
        rows: { value: '{maxRows}', mode: 'cap' },
        fq: { value: '{defaultFilter}', mode: 'append' },
        include_private: false
      }
    },
    { name: 'list_organizations', operationId: 'organization_list', sideEffect: 'read' },
    {
      name: 'query_datastore_sql',
      operationId: 'datastore_search_sql',
      sideEffect: 'read',
      enabledByDefault: false,
      requires: { 'install.datastoreSql': true }
    }
  ]
};

describe('integrationDefinitionSchema', () => {
  it('accepts a valid openapi definition and applies defaults', () => {
    const result = validateIntegrationDefinition(base);
    expect(result.success).toBe(true);
    const def = result.data;
    expect(def.auth.default).toBe('none');
    expect(def.trusted).toBe(false);
    expect(def.protocol.arrayParameterStyle).toBe('openapi');
    expect(def.protocol.maxResponseBytes).toBe(262144);
    // a secret field is sensitive without saying so
    expect(def.install.find(f => f.key === 'apiToken').sensitive).toBe(true);
    expect(def.install.find(f => f.key === 'baseUrl').sensitive).toBe(false);
    // plain default values are normalized to { value, mode: 'default' }
    expect(def.actions[0].defaults.include_private).toEqual({ value: false, mode: 'default' });
    expect(def.actions[0].defaults.rows).toEqual({ value: '{maxRows}', mode: 'cap' });
    expect(def.actions[2].enabledByDefault).toBe(false);
  });

  it('rejects ids that are not reverse-DNS', () => {
    expect(validateIntegrationDefinition({ ...base, id: 'Open Data' }).success).toBe(false);
    expect(validateIntegrationDefinition({ ...base, id: 'a/b/c' }).success).toBe(false);
    expect(validateIntegrationDefinition({ ...base, id: 'local.custom' }).success).toBe(true);
  });

  it('maps ids to folder names and back', () => {
    expect(definitionIdToDirName('org.ckan/open-data-portal')).toBe('org.ckan__open-data-portal');
    expect(dirNameToDefinitionId('org.ckan__open-data-portal')).toBe('org.ckan/open-data-portal');
    expect(definitionIdToDirName('local.custom')).toBe('local.custom');
  });

  it('requires an operationId on openapi actions', () => {
    const result = validateIntegrationDefinition({
      ...base,
      actions: [...base.actions, { name: 'read_file', sideEffect: 'read' }]
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].path).toEqual(['actions', 3, 'operationId']);
  });

  it('rejects duplicate actions, duplicate install keys and dangling references', () => {
    expect(
      validateIntegrationDefinition({ ...base, actions: [base.actions[0], base.actions[0]] })
        .success
    ).toBe(false);
    expect(
      validateIntegrationDefinition({ ...base, install: [base.install[0], base.install[0]] })
        .success
    ).toBe(false);
    expect(
      validateIntegrationDefinition({ ...base, scopes: { ...base.scopes, action: 'nope' } }).success
    ).toBe(false);
    expect(
      validateIntegrationDefinition({
        ...base,
        scopes: { ...base.scopes, paging: { offset: 'offset', limit: 'limit', size: 25 } }
      }).success
    ).toBe(true);
    expect(
      validateIntegrationDefinition({
        ...base,
        scopes: { ...base.scopes, paging: { offset: 'offset', limit: 'limit', size: 0 } }
      }).success
    ).toBe(false);
    expect(
      validateIntegrationDefinition({ ...base, sources: { nope: base.sources.search_datasets } })
        .success
    ).toBe(false);
    expect(validateIntegrationDefinition({ ...base, health: { action: 'nope' } }).success).toBe(
      false
    );
    expect(
      validateIntegrationDefinition({
        ...base,
        auth: { ...base.auth, serviceAccount: { field: 'missing' } }
      }).success
    ).toBe(false);
  });

  it('rejects an enum field without choices and a sensitive field with a default', () => {
    expect(
      validateIntegrationDefinition({
        ...base,
        install: [{ key: 'x', type: 'enum', title: { en: 'X' } }]
      }).success
    ).toBe(false);
    expect(
      validateIntegrationDefinition({
        ...base,
        install: [{ key: 'x', type: 'secret', title: { en: 'X' }, default: 'abc' }]
      }).success
    ).toBe(false);
  });

  it('requires auth.default to be one of the modes', () => {
    expect(
      validateIntegrationDefinition({ ...base, auth: { modes: ['none'], default: 'oauth-user' } })
        .success
    ).toBe(false);
  });

  it('keeps other protocol types as reserved but unsupported', () => {
    const { scopes, sources, health, ...rest } = base;
    void scopes;
    void sources;
    void health;
    const result = validateIntegrationDefinition({
      ...rest,
      protocol: { type: 'http', request: { url: 'https://api.example.com/{id}' } },
      actions: []
    });
    expect(result.success).toBe(true);
    expect(result.data.protocol.request.url).toBe('https://api.example.com/{id}');
  });
});

describe('checkInstallValues', () => {
  const def = validateIntegrationDefinition(base).data;

  it('passes a complete, well-typed value set', () => {
    expect(
      checkInstallValues(def, {
        baseUrl: 'https://demo.ckan.org',
        apiPath: '/api/3/action',
        maxRows: 10,
        datastoreSql: false,
        metadataProfile: 'ckan'
      })
    ).toEqual([]);
  });

  it('reports missing required fields, unknown keys and type errors', () => {
    const errors = checkInstallValues(def, { nope: 1, maxRows: 'ten', datastoreSql: 'yes' });
    const keys = errors.map(e => e.key).sort();
    expect(keys).toEqual(['baseUrl', 'datastoreSql', 'maxRows', 'nope']);
  });

  it('rejects a sensitive value in the config values', () => {
    const errors = checkInstallValues(def, { baseUrl: 'https://x.org', apiToken: 'secret' });
    expect(errors).toEqual([
      { key: 'apiToken', message: 'sensitive values belong in the credential store' }
    ]);
  });

  it('checks ranges, patterns, enum membership and url scheme', () => {
    const errors = checkInstallValues(def, {
      baseUrl: 'ftp://x.org',
      maxRows: 500,
      tokenHeader: 'bad header',
      metadataProfile: 'other'
    });
    expect(errors.map(e => e.key).sort()).toEqual([
      'baseUrl',
      'maxRows',
      'metadataProfile',
      'tokenHeader'
    ]);
  });

  it('applies choice requirements', () => {
    const errors = checkInstallValues(def, {
      baseUrl: 'https://x.org',
      metadataProfile: 'dcat-ap-de'
    });
    expect(errors).toEqual([
      { key: 'apiPath', message: 'required when metadataProfile is dcat-ap-de' }
    ]);
  });

  it('needs a credential for the service-account mode', () => {
    const errors = checkInstallValues(
      def,
      { baseUrl: 'https://x.org' },
      { authMode: 'service-account', hasCredential: false }
    );
    expect(errors[0]).toEqual({
      key: 'apiToken',
      message: 'a credential is required for this sign-in mode'
    });
    expect(
      checkInstallValues(
        def,
        { baseUrl: 'https://x.org' },
        { authMode: 'service-account', hasCredential: true }
      )
    ).toEqual([]);
  });
});

describe('integrationsConfigSchema', () => {
  it('accepts an empty file and applies defaults', () => {
    const result = validateIntegrationsConfig({});
    expect(result.success).toBe(true);
    expect(result.data.installed).toEqual([]);
    expect(result.data.security.blockPrivateIps).toBe(true);
  });

  it('accepts an instance with defaults', () => {
    const result = validateInstalledIntegration({
      id: 'ckan-demo',
      definition: 'org.ckan/open-data-portal',
      values: { baseUrl: 'https://demo.ckan.org' }
    });
    expect(result.success).toBe(true);
    expect(result.data.enabled).toBe(true);
    expect(result.data.auth).toEqual({ mode: 'none' });
    expect(result.data.actions.enabled).toEqual(['*']);
    expect(result.data.allowedGroups).toEqual([]);
  });

  it('rejects duplicate instance ids and unsafe ids', () => {
    const inst = { id: 'ckan', definition: 'org.ckan/open-data-portal' };
    expect(validateIntegrationsConfig({ installed: [inst, inst] }).success).toBe(false);
    expect(validateInstalledIntegration({ ...inst, id: '../x' }).success).toBe(false);
  });
});

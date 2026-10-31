// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V192: iFinder and iAssistant move from platform.json into the installed
 * integrations, apps bind them instead of requiring and listing tools.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  up,
  precondition,
  version,
  description,
  migrateApp,
  iFinderInstanceFrom,
  withEnvOverrides
} from '../migrations/V192__ifinder_iassistant_installed_integrations.js';
import {
  checkInstallValues,
  validateIntegrationDefinition
} from '../validators/integrationDefinitionSchema.js';

const IFINDER_DEFINITION = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../defaults/integration-definitions/com.intrafind__ifinder/integration.json'
    ),
    'utf8'
  )
);

function makeCtx(files) {
  const logs = [];
  return {
    logs,
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = data;
    },
    deleteFile: async rel => {
      delete files[rel];
    },
    listFiles: async (dir, pattern) =>
      Object.keys(files)
        .filter(rel => rel.startsWith(`${dir}/`) && rel.endsWith(pattern.replaceAll('*', '')))
        .map(rel => rel.slice(dir.length + 1)),
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const PLATFORM = {
  auth: { mode: 'local' },
  iFinder: {
    enabled: true,
    baseUrl: 'https://ifinder.example/',
    useOidcKeyPair: false,
    privateKeyRef: 'ifinder-key',
    algorithm: 'RS256',
    issuer: 'ihub-apps',
    audience: 'ifinder-api',
    tokenExpirationSeconds: 3600,
    defaultScope: 'fa_index_read',
    jwtSubjectField: 'email',
    searchProfileApplication: 'ifinder',
    defaultSearchProfile: 'contracts',
    allowedSearchProfiles: ['contracts', 'hr'],
    allowUserSearchProfileChange: false,
    authMode: 'oidcTokenExchange',
    tokenExchange: {
      oidcProvider: 'keycloak',
      grantType: 'tokenExchange',
      audience: 'ifinder',
      scopeMap: { fa_index_read: 'ifinder.read', fa_iassistant: '', fi_smartcollections: '' },
      extraScopes: ['offline_access']
    }
  },
  iAssistant: {
    defaultProfileId: 'workspace',
    defaultSearchProfile: 'searchprofile-standard',
    verifySearchProfileAccess: false,
    groundedOnly: true
  }
};

describe('V192 iFinder and iAssistant as installed integrations', () => {
  it('has a version and description', () => {
    assert.equal(version, '192');
    assert.ok(description);
  });

  it('runs when platform.json, the tool file or apps exist', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/platform.json': {} })), true);
    assert.equal(await precondition(makeCtx({ 'apps/a.json': {} })), true);
  });

  it('moves the platform blocks into the two installations and removes them', async () => {
    const ctx = makeCtx({
      'config/platform.json': structuredClone(PLATFORM),
      'tools/iFinder.json': { id: 'iFinder' }
    });
    await up(ctx);

    const platform = ctx.files['config/platform.json'];
    assert.equal('iFinder' in platform, false);
    assert.equal('iAssistant' in platform, false);
    assert.deepEqual(platform.auth, { mode: 'local' });
    assert.equal('tools/iFinder.json' in ctx.files, false);

    const { installed } = ctx.files['config/integrations.json'];
    const ifinder = installed.find(i => i.id === 'ifinder');
    assert.equal(ifinder.definition, 'com.intrafind/ifinder');
    assert.equal(ifinder.enabled, true);
    assert.deepEqual(ifinder.values, {
      baseUrl: 'https://ifinder.example/',
      authMode: 'oidcTokenExchange',
      privateKeyRef: 'ifinder-key',
      algorithm: 'RS256',
      issuer: 'ihub-apps',
      audience: 'ifinder-api',
      tokenExpirationSeconds: 3600,
      defaultScope: 'fa_index_read',
      jwtSubjectField: 'email',
      tokenExchangeProvider: 'keycloak',
      tokenExchangeGrant: 'tokenExchange',
      tokenExchangeAudience: 'ifinder',
      tokenExchangeScopeIndexRead: 'ifinder.read',
      tokenExchangeExtraScopes: ['offline_access'],
      searchProfileApplication: 'ifinder',
      defaultSearchProfile: 'contracts',
      allowedSearchProfiles: ['contracts', 'hr'],
      allowUserSearchProfileChange: false
    });
    const iassistant = installed.find(i => i.id === 'iassistant');
    assert.equal(iassistant.definition, 'com.intrafind/iassistant');
    assert.equal(iassistant.enabled, true);
    assert.deepEqual(iassistant.values, {
      connection: 'ifinder',
      defaultProfileId: 'workspace',
      defaultSearchProfile: 'searchprofile-standard',
      verifySearchProfileAccess: false,
      groundedOnly: true
    });
  });

  it('keeps a disabled iFinder disabled and adds to an existing integrations.json', async () => {
    const ctx = makeCtx({
      'config/platform.json': { iFinder: { enabled: false, baseUrl: '' } },
      'config/integrations.json': {
        installed: [{ id: 'open-data-portal', definition: 'org.ckan/open-data-portal' }],
        security: { blockPrivateIps: false, allowedHosts: ['x'] }
      }
    });
    await up(ctx);
    const config = ctx.files['config/integrations.json'];
    assert.deepEqual(
      config.installed.map(i => i.id),
      ['open-data-portal', 'ifinder', 'iassistant']
    );
    assert.equal(config.installed[1].enabled, false);
    assert.deepEqual(config.installed[1].values, {});
    assert.deepEqual(config.security, { blockPrivateIps: false, allowedHosts: ['x'] });
  });

  it('is a no-op the second time', async () => {
    const ctx = makeCtx({ 'config/platform.json': structuredClone(PLATFORM) });
    await up(ctx);
    const once = structuredClone(ctx.files);
    await up(ctx);
    assert.deepEqual(ctx.files, once);
  });

  describe('apps', () => {
    it('turns the requirement and the tool ids into the ifinder binding', () => {
      const { app, notes } = migrateApp({
        id: 'ifinder-search',
        tools: ['iFinder_search', 'iFinder_getContent', 'braveSearch'],
        requiredIntegrations: ['ifinder'],
        integrations: { ifinder: { scopePicker: 'menu' } }
      });
      assert.deepEqual(app.tools, ['braveSearch']);
      assert.equal('requiredIntegrations' in app, false);
      assert.deepEqual(app.integrations.ifinder, {
        scopePicker: 'menu',
        actions: ['search', 'getContent']
      });
      assert.ok(notes.length);
    });

    it('leaves the action list out when every action was listed, or the base id was', () => {
      const all = migrateApp({
        id: 'a',
        tools: [
          'iFinder_search',
          'iFinder_getContent',
          'iFinder_getMetadata',
          'iFinder_discover',
          'iFinder_getFields',
          'iFinder_getFacetValues',
          'iFinder_listProfiles'
        ]
      });
      assert.deepEqual(all.app.integrations.ifinder, {});
      assert.equal('tools' in all.app, false);
      const base = migrateApp({ id: 'b', tools: ['iFinder', 'other'] });
      assert.deepEqual(base.app.integrations.ifinder, {});
      assert.deepEqual(base.app.tools, ['other']);
    });

    it('keeps a scope-only binding without actions', () => {
      const { app } = migrateApp({
        id: 'c',
        tools: ['braveSearch'],
        integrations: { ifinder: { defaultScope: 'hr' } }
      });
      assert.deepEqual(app.integrations.ifinder, { defaultScope: 'hr', actions: [] });
      assert.deepEqual(app.tools, ['braveSearch']);
    });

    it('binds the iAssistant installation to apps on the iAssistant model, without an ifinder binding', () => {
      const { app } = migrateApp({
        id: 'iassistant',
        preferredModel: 'iassistant-conversation',
        requiredIntegrations: ['ifinder', 'peopleDirectories'],
        integrations: { iassistant: { allowAllSearchProfiles: true } }
      });
      assert.deepEqual(app.requiredIntegrations, ['peopleDirectories']);
      // The iAssistant installation runs on iFinder: the gate comes with the
      // iassistant binding, and the app does not gain the iFinder tools.
      assert.deepEqual(app.integrations, {
        iassistant: { allowAllSearchProfiles: true, actions: [] }
      });
    });

    it('keeps the iFinder tools of an app on the iAssistant model', () => {
      const { app } = migrateApp({
        id: 'd',
        preferredModel: 'iassistant-conversation',
        requiredIntegrations: ['ifinder'],
        tools: ['iFinder_search']
      });
      assert.deepEqual(app.integrations, {
        ifinder: { actions: ['search'] },
        iassistant: { actions: [] }
      });
    });

    it('turns a requirement without iFinder tools into a binding without actions', () => {
      const { app, notes } = migrateApp({
        id: 'e',
        requiredIntegrations: ['ifinder'],
        tools: ['braveSearch']
      });
      assert.equal('requiredIntegrations' in app, false);
      // The app only needed iFinder to be on; it never had the seven tools.
      assert.deepEqual(app.integrations, { ifinder: { actions: [] } });
      assert.deepEqual(app.tools, ['braveSearch']);
      assert.ok(notes.some(n => n.includes('requiredIntegrations ifinder')));
    });

    it('leaves an app without iFinder or iAssistant alone', () => {
      assert.equal(migrateApp({ id: 'chat', tools: ['braveSearch'] }), null);
    });

    it('rewrites the app files', async () => {
      const ctx = makeCtx({
        'apps/ifinder-search.json': {
          id: 'ifinder-search',
          tools: ['iFinder'],
          requiredIntegrations: ['ifinder']
        },
        'apps/chat.json': { id: 'chat' }
      });
      await up(ctx);
      assert.deepEqual(ctx.files['apps/ifinder-search.json'], {
        id: 'ifinder-search',
        integrations: { ifinder: {} }
      });
      assert.deepEqual(ctx.files['apps/chat.json'], { id: 'chat' });
    });
  });

  it('maps an empty block to an installation without values', () => {
    assert.deepEqual(iFinderInstanceFrom({}).values, {});
  });

  it('keeps a domain\\username or template subject, which the definition accepts', async () => {
    const definition = validateIntegrationDefinition(IFINDER_DEFINITION);
    assert.ok(definition.success, JSON.stringify(definition.errors));
    for (const jwtSubjectField of [
      String.raw`domain\username`,
      String.raw`CONTOSO\${user.username}`,
      'id',
      'name'
    ]) {
      const ctx = makeCtx({
        'config/platform.json': {
          iFinder: {
            enabled: true,
            baseUrl: 'https://ifinder.example',
            authMode: 'ihubSigned',
            defaultSearchProfile: 'searchprofile-standard',
            jwtSubjectField
          }
        }
      });
      await up(ctx);
      const ifinder = ctx.files['config/integrations.json'].installed.find(i => i.id === 'ifinder');
      assert.equal(ifinder.values.jwtSubjectField, jwtSubjectField);
      assert.deepEqual(checkInstallValues(definition.data, ifinder.values), []);
    }
  });

  it('accepts every migrated value of a full block', async () => {
    const definition = validateIntegrationDefinition(IFINDER_DEFINITION);
    const { values } = iFinderInstanceFrom(PLATFORM.iFinder);
    assert.deepEqual(checkInstallValues(definition.data, values), []);
  });

  describe('IHUB_PLATFORM__I_FINDER__* and __I_ASSISTANT__* variables', () => {
    const env = {
      IHUB_PLATFORM__I_FINDER__ENABLED: 'true',
      IHUB_PLATFORM__I_FINDER__BASE_URL: 'https://ifinder.env',
      IHUB_PLATFORM__I_FINDER__TOKEN_EXCHANGE__OIDC_PROVIDER: 'entra',
      IHUB_PLATFORM__I_FINDER__ALLOWED_SEARCH_PROFILES: '["hr"]',
      IHUB_PLATFORM__I_ASSISTANT__GROUNDED_ONLY: 'true',
      IHUB_PLATFORM__AUTH__MODE: 'local',
      OTHER: 'x'
    };

    it('maps the variables the way configCache did, over the block', () => {
      const { block, applied } = withEnvOverrides(
        { enabled: false, baseUrl: 'https://ifinder.file', timeout: 5 },
        'IHUB_PLATFORM__I_FINDER__',
        env
      );
      assert.deepEqual(block, {
        enabled: true,
        baseUrl: 'https://ifinder.env',
        timeout: 5,
        tokenExchange: { oidcProvider: 'entra' },
        allowedSearchProfiles: ['hr']
      });
      assert.equal(applied.length, 4);
      assert.deepEqual(withEnvOverrides(undefined, 'IHUB_PLATFORM__I_FINDER__', {}), {
        block: undefined,
        applied: []
      });
    });

    it('folds them into the installations, also when platform.json has no block', async () => {
      const ctx = makeCtx({ 'config/platform.json': { auth: { mode: 'local' } } });
      await up(ctx, env);
      const { installed } = ctx.files['config/integrations.json'];
      const ifinder = installed.find(i => i.id === 'ifinder');
      assert.equal(ifinder.enabled, true);
      assert.equal(ifinder.values.baseUrl, 'https://ifinder.env');
      assert.equal(ifinder.values.tokenExchangeProvider, 'entra');
      assert.deepEqual(ifinder.values.allowedSearchProfiles, ['hr']);
      const iassistant = installed.find(i => i.id === 'iassistant');
      assert.equal(iassistant.enabled, true);
      assert.equal(iassistant.values.groundedOnly, true);
      assert.deepEqual(ctx.files['config/platform.json'], { auth: { mode: 'local' } });
      assert.ok(ctx.logs.some(l => l.includes('IHUB_PLATFORM__I_FINDER__BASE_URL')));
    });

    it('lets the variable win over the file, as it did at runtime', async () => {
      const ctx = makeCtx({
        'config/platform.json': {
          iFinder: { enabled: false, baseUrl: 'https://ifinder.file', defaultSearchProfile: 'hr' }
        }
      });
      await up(ctx, env);
      const ifinder = ctx.files['config/integrations.json'].installed.find(i => i.id === 'ifinder');
      assert.equal(ifinder.enabled, true);
      assert.equal(ifinder.values.baseUrl, 'https://ifinder.env');
      assert.equal(ifinder.values.defaultSearchProfile, 'hr');
    });
  });
});

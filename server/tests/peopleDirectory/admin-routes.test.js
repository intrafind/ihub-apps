// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/admin/integrations/people-directories/editor-context`: what the
 * dedicated People directory (LDAP), LDAP browser and Entra ID editors need —
 * the search presets with their mappings, the person fields, the limits, the
 * LDAP sign-in providers a directory can reuse and which `AZURE_*` variables
 * are set. Behind `adminAuth`, and never a secret: no bind password
 * reference, no environment value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import registerAdminPeopleDirectoryEditorRoutes, {
  entraEnvironmentOf,
  ldapProviderSummaries,
  peopleDirectoryEditorContext
} from '../../routes/admin/peopleDirectoryEditor.js';
import { MAPPED_PERSON_FIELDS, SEARCH_PRESET_IDS } from '../../services/peopleDirectory/presets.js';

const PLATFORM = {
  ldapAuth: {
    providers: [
      {
        name: 'corp-ad',
        displayName: 'Corporate AD',
        url: 'ldaps://dc.corp.example:636',
        baseDn: 'dc=corp,dc=example',
        userSearchBase: 'ou=people,dc=corp,dc=example',
        preset: 'activeDirectory',
        adminDn: 'cn=svc,dc=corp,dc=example',
        adminPasswordRef: 'corp-svc-password',
        adminPassword: 'plain-secret'
      },
      { name: 'plain', url: 'ldap://ldap.example:389', starttls: true },
      { url: 'ldaps://nameless.example' }
    ]
  }
};

describe('people directory editor context', () => {
  it('summarises the sign-in providers without their secrets', () => {
    const providers = ldapProviderSummaries(PLATFORM);
    assert.equal(providers.length, 2);
    assert.deepEqual(providers[0], {
      name: 'corp-ad',
      displayName: 'Corporate AD',
      url: 'ldaps://dc.corp.example:636',
      host: 'dc.corp.example',
      baseDn: 'dc=corp,dc=example',
      userSearchBase: 'ou=people,dc=corp,dc=example',
      preset: 'activeDirectory',
      starttls: false,
      hasBindAccount: true
    });
    assert.equal(providers[1].starttls, true);
    assert.equal(providers[1].hasBindAccount, false);
    const text = JSON.stringify(providers);
    assert.ok(!text.includes('corp-svc-password'));
    assert.ok(!text.includes('plain-secret'));
    assert.ok(!text.includes('cn=svc'));
  });

  it('lists every preset with its mapping, the fields and the limits', () => {
    const context = peopleDirectoryEditorContext(PLATFORM, {});
    assert.deepEqual(
      context.presets.map(preset => preset.id),
      SEARCH_PRESET_IDS
    );
    for (const preset of context.presets) {
      assert.ok(preset.personFilter.startsWith('('), preset.id);
      assert.deepEqual(Object.keys(preset.attributeMapping), MAPPED_PERSON_FIELDS);
    }
    assert.deepEqual(context.fields, MAPPED_PERSON_FIELDS);
    assert.equal(context.defaults.maxResults, 10);
    assert.equal(context.limits.maxResults, 50);
    assert.deepEqual(context.browse, {
      defaults: { maxResults: 50 },
      limits: { maxResults: 200 }
    });
  });

  it('says which AZURE_* variables are set, never their values', () => {
    const env = {
      AZURE_TENANT_ID: 'tenant-guid',
      AZURE_CLIENT_ID: '  ',
      AZURE_CLIENT_SECRET: 's3'
    };
    const flags = entraEnvironmentOf(env);
    assert.deepEqual(flags, {
      tenantId: { variable: 'AZURE_TENANT_ID', set: true },
      clientId: { variable: 'AZURE_CLIENT_ID', set: false },
      clientSecret: { variable: 'AZURE_CLIENT_SECRET', set: true }
    });
    const context = JSON.stringify(peopleDirectoryEditorContext(PLATFORM, env));
    assert.ok(!context.includes('tenant-guid'));
    assert.ok(!context.includes('s3'));
  });

  it('is served behind adminAuth', async () => {
    const routes = [];
    registerAdminPeopleDirectoryEditorRoutes({
      get: (path, ...handlers) => routes.push({ path, handlers })
    });
    assert.equal(routes.length, 1);
    assert.match(routes[0].path, /\/api\/admin\/integrations\/people-directories\/editor-context$/);
    assert.equal(routes[0].handlers[0], adminAuth);

    const getPlatform = configCache.getPlatform;
    configCache.getPlatform = () => PLATFORM;
    try {
      let body;
      routes[0].handlers[1]({}, { json: data => (body = data) });
      assert.equal(body.ldapProviders[0].name, 'corp-ad');
      assert.ok(body.entraEnvironment.tenantId);
    } finally {
      configCache.getPlatform = getPlatform;
    }
  });
});

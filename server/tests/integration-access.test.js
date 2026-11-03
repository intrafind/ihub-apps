// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who may use an installed integration (#3093): `groups.json` →
 * `permissions.integrations` (`*`, installation ids, definition ids, type
 * keys), resolved with inheritance like `apps`, exposed on the enhanced user
 * and checked by `userMayUse` — and, through it, by the cloud storage
 * listing and routes.
 *
 * Run: node --test server/tests/integration-access.test.js
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import {
  enhanceUserWithPermissions,
  getPermissionsForUser,
  resolveGroupInheritance
} from '../utils/authorization.js';
import {
  ALL_INTEGRATIONS,
  integrationGrantKeys,
  integrationPermissionsOf,
  mayUseIntegration
} from '../services/integrations/integrationAccess.js';
import { userMayUse } from '../services/integrations/integrationTools.js';
import { publishDefinitionTypes } from '../services/integrations/integrationTypes.js';
import {
  cloudStorageStatus,
  listCloudStorageProvidersFor,
  mayUseCloudStorageProvider
} from '../services/integrations/cloudStorageConfig.js';
import { requireCloudStorageGrant } from '../routes/integrations/cloudStorageAccess.js';

const LDAP = 'com.intrafind/ldap-directory';
const ENTRA = 'com.intrafind/entra-directory';
const WEB = 'com.intrafind/brave-search';

const x500 = { id: 'x500bund', definition: LDAP };
const corp = { id: 'corp', definition: LDAP };
const entra = { id: 'entra', definition: ENTRA };
const brave = { id: 'brave', definition: WEB };
const jira = { id: 'jira', definition: 'com.intrafind/jira' };

/** groups.json as an admin writes it: admins → users → authenticated → anonymous. */
const RAW_GROUPS = {
  groups: {
    admins: {
      id: 'admins',
      name: 'Admins',
      inherits: ['users'],
      permissions: { apps: ['*'], integrations: ['jira'], adminAccess: true }
    },
    users: {
      id: 'users',
      name: 'Users',
      inherits: ['authenticated'],
      permissions: { apps: ['*'], integrations: [LDAP] }
    },
    authenticated: {
      id: 'authenticated',
      name: 'Authenticated',
      inherits: ['anonymous'],
      permissions: { apps: ['*'], integrations: ['type:web-search'] }
    },
    anonymous: {
      id: 'anonymous',
      name: 'Anonymous',
      permissions: { apps: ['chat'], integrations: ['ihub'] }
    },
    everything: { id: 'everything', name: 'All', permissions: { integrations: ['*'] } },
    directories: {
      id: 'directories',
      name: 'Directories',
      permissions: { integrations: ['type:people-directory'] }
    },
    legacy: { id: 'legacy', name: 'No integrations field', permissions: { apps: ['*'] } }
  }
};

function useGroups(raw = RAW_GROUPS) {
  configCache.setCacheEntry('config/groups.json', resolveGroupInheritance(structuredClone(raw)));
}

beforeEach(() => {
  configCache.setCacheEntry('config/platform.json', { anonymousAuth: { enabled: true } });
  useGroups();
  publishDefinitionTypes([
    { definition: { id: LDAP, type: 'people-directory' } },
    { definition: { id: ENTRA, type: 'people-directory' } },
    { definition: { id: WEB, type: 'web-search' } }
  ]);
});

after(() => {
  publishDefinitionTypes([]);
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
  configCache.cache?.clear?.();
});

describe('permissions.integrations on the groups', () => {
  it('is merged from inherited groups like apps', () => {
    const resolved = resolveGroupInheritance(structuredClone(RAW_GROUPS));
    assert.deepEqual(resolved.groups.admins.permissions.integrations.sort(), [
      LDAP,
      'ihub',
      'jira',
      'type:web-search'
    ]);
    assert.deepEqual(resolved.groups.authenticated.permissions.integrations.sort(), [
      'ihub',
      'type:web-search'
    ]);
    assert.deepEqual(resolved.groups.anonymous.permissions.integrations, ['ihub']);
  });

  it('is resolved per user as a Set, `*` collapsing the rest', () => {
    const users = getPermissionsForUser(['users']);
    assert.ok(users.integrations instanceof Set);
    assert.deepEqual([...users.integrations].sort(), [LDAP, 'ihub', 'type:web-search']);
    const all = getPermissionsForUser(['users', 'everything']);
    assert.ok(all.integrations.has(ALL_INTEGRATIONS));
    assert.equal(getPermissionsForUser(['legacy']).integrations.size, 0);
  });

  it('is exposed on the enhanced user, anonymous principal included', () => {
    const user = enhanceUserWithPermissions(
      { id: 'u', groups: ['users'] },
      {},
      configCache.getPlatform()
    );
    assert.deepEqual([...user.permissions.integrations].sort(), [LDAP, 'ihub', 'type:web-search']);
    const anonymous = enhanceUserWithPermissions(null, {}, configCache.getPlatform());
    assert.deepEqual([...anonymous.permissions.integrations], ['ihub']);
  });

  it("keeps the owner's grant for a delegated token, which has no integration allow-list", () => {
    for (const authMode of ['oauth_authorization_code', 'oauth_personal_key']) {
      const user = enhanceUserWithPermissions(
        { id: 'u', groups: ['users'], authMode, clientAllowedApps: ['chat'] },
        {},
        configCache.getPlatform()
      );
      assert.deepEqual([...user.permissions.apps], ['chat'], authMode);
      assert.deepEqual(
        [...user.permissions.integrations].sort(),
        [LDAP, 'ihub', 'type:web-search'],
        authMode
      );
    }
  });

  it('lets a machine OAuth client use what its allowed apps bind', () => {
    const client = enhanceUserWithPermissions(
      { id: 'client', groups: ['oauth_clients'], isOAuthClient: true, allowedApps: ['chat'] },
      {},
      configCache.getPlatform()
    );
    assert.deepEqual([...client.permissions.integrations], ['*']);
    assert.deepEqual([...client.permissions.apps], ['chat']);
  });
});

describe('userMayUse', () => {
  const enhanced = groups =>
    enhanceUserWithPermissions({ id: 'u', groups }, {}, configCache.getPlatform());

  it('lists the keys that grant an installation, most specific first', () => {
    assert.deepEqual(integrationGrantKeys(x500), ['x500bund', LDAP, 'type:people-directory']);
    assert.deepEqual(integrationGrantKeys(jira), ['jira', 'com.intrafind/jira']);
    assert.deepEqual(integrationGrantKeys(null), []);
  });

  it('grants by "*", installation id, definition id and type key', () => {
    // `*`
    assert.equal(userMayUse(jira, enhanced(['everything'])), true);
    // installation id (admins: `jira`)
    assert.equal(userMayUse(jira, enhanced(['admins'])), true);
    assert.equal(userMayUse(jira, enhanced(['users'])), false);
    // definition id (users: every LDAP directory, not Entra)
    assert.equal(userMayUse(x500, enhanced(['users'])), true);
    assert.equal(userMayUse(corp, enhanced(['users'])), true);
    assert.equal(userMayUse(entra, enhanced(['users'])), false);
    // type key (directories: every people directory; authenticated: web search)
    assert.equal(userMayUse(entra, enhanced(['directories'])), true);
    assert.equal(userMayUse(x500, enhanced(['directories'])), true);
    assert.equal(userMayUse(brave, enhanced(['directories'])), false);
    assert.equal(userMayUse(brave, enhanced(['authenticated'])), true);
  });

  it('grants nothing to a group without the field, or an installation without an id', () => {
    assert.equal(userMayUse(brave, enhanced(['legacy'])), false);
    assert.equal(userMayUse({ definition: WEB }, enhanced(['everything'])), false);
    assert.equal(mayUseIntegration(null, enhanced(['everything'])), false);
  });

  it('does not match a type key once the definition has no type', () => {
    publishDefinitionTypes([]);
    assert.equal(userMayUse(entra, enhanced(['directories'])), false);
    // An id or definition grant does not depend on the type.
    assert.equal(userMayUse(x500, enhanced(['users'])), true);
  });

  it('resolves a user without resolved permissions from its groups, inherited ones included', () => {
    // Raw groups in the cache: inheritance is resolved through `inherits` here.
    configCache.setCacheEntry('config/groups.json', structuredClone(RAW_GROUPS));
    assert.equal(userMayUse(jira, { id: 'u', groups: ['admins'] }), true);
    assert.equal(userMayUse(brave, { id: 'u', groups: ['admins'] }), true);
    assert.equal(userMayUse(brave, { id: 'u', groups: ['anonymous'] }), false);
    // A Set restored from JSON reads `{}`: resolved from the groups again.
    assert.equal(
      userMayUse(x500, { id: 'u', groups: ['users'], permissions: { integrations: {} } }),
      true
    );
    // An array (a user serialized by hand) is read as it is.
    assert.equal(
      userMayUse(jira, { id: 'u', groups: [], permissions: { integrations: ['jira'] } }),
      true
    );
  });

  it('never allows everything to an unresolved principal, whatever it claims', () => {
    const claims = { id: 'c', groups: ['oauth_clients'], isOAuthClient: true };
    assert.equal(integrationPermissionsOf(claims).size, 0);
    assert.equal(userMayUse(brave, claims), false);
  });

  it('treats no user as the anonymous principal', () => {
    assert.equal(userMayUse({ id: 'ihub', definition: 'com.intrafind/ihub' }, undefined), true);
    assert.equal(userMayUse(brave, null), false);
  });

  it('grants nothing when the groups cannot be read', () => {
    const getGroups = configCache.getGroups;
    configCache.getGroups = () => {
      throw new Error('groups.json is unreadable');
    };
    try {
      assert.equal(userMayUse(brave, { id: 'u', groups: ['everything'] }), false);
    } finally {
      configCache.getGroups = getGroups;
    }
  });
});

describe('storage providers', () => {
  const STORAGE_GROUPS = {
    groups: {
      users: { id: 'users', name: 'Users', permissions: { integrations: ['office365'] } },
      storage: { id: 'storage', name: 'Storage', permissions: { integrations: ['type:storage'] } },
      branch: { id: 'branch', name: 'Branch', permissions: { integrations: ['nextcloud-branch'] } },
      nextcloud: {
        id: 'nextcloud',
        name: 'Nextcloud',
        permissions: { integrations: ['com.intrafind/nextcloud'] }
      },
      none: { id: 'none', name: 'None', permissions: { integrations: [] } },
      anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { integrations: [] } }
    }
  };
  // Several installations per provider; the installation id is the provider id.
  const installed = [
    {
      id: 'office365',
      definition: 'com.intrafind/office365',
      enabled: true,
      values: { clientId: 'c', tenantId: 't' }
    },
    {
      id: 'nextcloud-main',
      definition: 'com.intrafind/nextcloud',
      enabled: true,
      values: { serverUrl: 'https://cloud.example' }
    },
    {
      id: 'nextcloud-branch',
      definition: 'com.intrafind/nextcloud',
      enabled: true,
      values: { serverUrl: 'https://branch.example' }
    }
  ];

  beforeEach(() => {
    useGroups(STORAGE_GROUPS);
    publishDefinitionTypes([
      { definition: { id: 'com.intrafind/office365', type: 'storage' } },
      { definition: { id: 'com.intrafind/nextcloud', type: 'storage' } }
    ]);
    configCache.setCacheEntry('config/integrations.json', { installed });
  });

  const as = groups =>
    enhanceUserWithPermissions({ id: 'u', groups }, {}, configCache.getPlatform());

  it('lists in /api/auth/status only the installations the groups grant', () => {
    assert.deepEqual(
      cloudStorageStatus(as(['users'])).providers.map(p => p.id),
      ['office365']
    );
    assert.deepEqual(
      cloudStorageStatus(as(['storage'])).providers.map(p => p.id),
      ['office365', 'nextcloud-main', 'nextcloud-branch']
    );
    assert.deepEqual(
      cloudStorageStatus(as(['branch'])).providers.map(p => p.id),
      ['nextcloud-branch']
    );
    assert.deepEqual(
      cloudStorageStatus(as(['nextcloud'])).providers.map(p => p.id),
      ['nextcloud-main', 'nextcloud-branch']
    );
    const none = cloudStorageStatus(as(['none']));
    assert.deepEqual(none, { enabled: false, providers: [] });
    assert.deepEqual(cloudStorageStatus(undefined).providers, []);
    assert.deepEqual(
      listCloudStorageProvidersFor(as(['storage'])).map(p => p.installationId),
      ['office365', 'nextcloud-main', 'nextcloud-branch']
    );
  });

  it('checks a provider named by its installation id against that installation', () => {
    assert.equal(mayUseCloudStorageProvider(as(['users']), 'office365', 'office365'), true);
    assert.equal(mayUseCloudStorageProvider(as(['users']), 'nextcloud-main', 'nextcloud'), false);
    assert.equal(mayUseCloudStorageProvider(as(['storage']), 'nextcloud-main', 'nextcloud'), true);
    assert.equal(mayUseCloudStorageProvider(as(['branch']), 'nextcloud-main', 'nextcloud'), false);
    assert.equal(mayUseCloudStorageProvider(as(['branch']), 'nextcloud-branch', 'nextcloud'), true);
    assert.equal(mayUseCloudStorageProvider(as(['storage']), 'missing', 'nextcloud'), false);
  });

  it('needs an installation on the storage routes, and refuses one the groups do not grant', () => {
    const run = (type, req) => {
      let status = null;
      let body = null;
      let passed = false;
      const res = {
        status(code) {
          status = code;
          return this;
        },
        json(payload) {
          body = payload;
          return this;
        }
      };
      requireCloudStorageGrant(type)(req, res, () => {
        passed = true;
      });
      return { status, body, passed };
    };
    const member = as(['branch']);
    const refused = run('nextcloud', {
      path: '/items',
      query: { providerId: 'nextcloud-main' },
      user: member
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'INTEGRATION_NOT_GRANTED');
    assert.equal(refused.passed, false);
    // No installation named: 400; an unknown one, or one of another provider: 404.
    const unnamed = run('nextcloud', { path: '/items', query: {}, user: member });
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.body.code, 'STORAGE_PROVIDER_REQUIRED');
    assert.equal(run('nextcloud', { path: '/sources', query: {}, user: member }).status, 400);
    for (const req of [
      { path: '/items', query: { providerId: 'gone' } },
      { path: '/download', query: { providerId: 'office365' } }
    ]) {
      const result = run('nextcloud', { ...req, user: member });
      assert.equal(result.status, 404, JSON.stringify(req));
      assert.equal(result.body.code, 'STORAGE_PROVIDER_NOT_FOUND');
    }
    // Granted, and the callback (id in the path), pass. Connecting, the status
    // and disconnecting are the one connect flow (`/api/integrations/:id/…`,
    // see user-integrations-routes.test.js).
    for (const req of [
      { path: '/items', query: { providerId: 'nextcloud-branch' }, type: 'nextcloud' },
      { path: '/nextcloud-main/callback', query: { code: 'x', state: 'y' }, type: 'nextcloud' }
    ]) {
      assert.equal(run(req.type, { ...req, user: member }).passed, true, JSON.stringify(req));
    }
  });
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V206: storage providers become several installations per provider whose id
 * is the provider id; the parked providers are installed, the tenant id
 * credentials are cleaned up, and apps bind `type:storage` instead of the
 * `upload.cloudStorageUpload` switch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  description,
  isUsableId,
  fallbackId,
  instanceFrom,
  renameToProviderIds,
  renamedGrants,
  migrateApp,
  trimChars,
  v061IdOf,
  STORAGE_TYPE_BINDING
} from '../migrations/V206__storage_provider_installations.js';
import {
  cloudStorageCallbackPath,
  providerFromInstance
} from '../services/integrations/cloudStorageConfig.js';

/** Encryption stand-in: `ENC[<plain>]`; `ENC[broken]` cannot be decrypted. */
const crypto = {
  encrypt: value => `ENC[${value}]`,
  decrypt: value => {
    if (value === 'ENC[broken]') throw new Error('bad tag');
    return value.slice(4, -1);
  }
};

function makeCtx(files) {
  const logs = [];
  const warnings = [];
  let writes = 0;
  let deletes = 0;
  return {
    logs,
    warnings,
    files,
    get writes() {
      return writes;
    },
    get deletes() {
      return deletes;
    },
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes += 1;
      files[rel] = structuredClone(data);
    },
    deleteFile: async rel => {
      deletes += 1;
      delete files[rel];
    },
    listFiles: async (dir, pattern) => {
      const suffix = pattern === '*.json' ? '.json' : '';
      return Object.keys(files)
        .filter(rel => rel.startsWith(`${dir}/`) && !rel.slice(dir.length + 1).includes('/'))
        .map(rel => rel.slice(dir.length + 1))
        .filter(name => name.endsWith(suffix));
    },
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

function storage(id, definition, values = {}, extra = {}) {
  return {
    id,
    definition,
    definitionVersion: '1.0.0',
    enabled: true,
    values: { clientId: 'cid', clientSecretRef: 'secret-ref', ...values },
    auth: { mode: 'oauth-user' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    ...extra
  };
}

const O365 = 'com.intrafind/office365';
const GDRIVE = 'com.intrafind/google-drive';
const NEXTCLOUD = 'com.intrafind/nextcloud';

function integrationsFile(installed) {
  return { installed, security: { blockPrivateIps: true, allowedHosts: [] } };
}

function groupsFile() {
  return {
    groups: {
      users: { id: 'users', permissions: { apps: ['*'], integrations: ['*'] } },
      finance: {
        id: 'finance',
        permissions: { integrations: ['office365', 'nextcloud', 'websearch', 'type:storage'] }
      },
      anonymous: { id: 'anonymous', permissions: { integrations: ['websearch'] } }
    }
  };
}

function app(id, extra = {}) {
  return {
    id,
    name: { en: id },
    upload: { enabled: true, fileUpload: { enabled: true } },
    ...extra
  };
}

/** The files after V200 on an installation with three providers, a second Nextcloud parked. */
function afterV200() {
  return {
    'config/integrations.json': integrationsFile([
      storage('office365', O365, { tenantId: 'tenant-1', providerId: 'o365-corp' }),
      storage('googledrive', GDRIVE),
      storage('nextcloud', NEXTCLOUD, {
        serverUrl: 'https://cloud.example.com',
        providerId: 'nextcloud-main'
      }),
      { id: 'websearch', definition: 'com.intrafind/web-search', enabled: true, values: {} }
    ]),
    'config/groups.json': groupsFile(),
    'config/cloudStorage.unmigrated.json': {
      enabled: true,
      providers: [
        {
          id: 'nextcloud-branch',
          type: 'nextcloud',
          displayName: 'Branch office',
          enabled: true,
          serverUrl: 'https://branch.example.com',
          clientId: 'branch-client',
          clientSecretRef: 'cloudstorage_nextcloud-branch'
        }
      ]
    },
    'config/credentials.json': {
      credentials: {
        'secret-ref': { id: 'secret-ref', type: 'secret', value: 'ENC[s]' },
        cloudstorage_o365_tenant: {
          id: 'cloudstorage_o365_tenant',
          type: 'secret',
          name: 'Office365 Tenant (o365-corp)',
          value: 'ENC[tenant-1]'
        },
        'cloudstorage_nextcloud-branch': {
          id: 'cloudstorage_nextcloud-branch',
          type: 'secret',
          value: 'ENC[branch-secret]'
        }
      }
    },
    'apps/file-analysis.json': app('file-analysis', {
      upload: { enabled: true, cloudStorageUpload: { enabled: true } }
    }),
    'apps/chat.json': app('chat', {
      upload: { enabled: true, cloudStorageUpload: { enabled: false } }
    }),
    'apps/bound.json': app('bound', { integrations: { office365: { required: false } } }),
    'apps/plain.json': app('plain')
  };
}

const installedOf = files => files['config/integrations.json'].installed;
const byId = (files, id) => installedOf(files).find(i => i.id === id);

describe('V206 storage provider installations', () => {
  it('declares its version and description', () => {
    assert.equal(version, '206');
    assert.equal(description, 'storage_provider_installations');
  });

  it('runs when an integrations file, the parked providers or an app exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(
      await precondition(makeCtx({ 'config/integrations.json': integrationsFile([]) })),
      true
    );
    assert.equal(await precondition(makeCtx({ 'config/cloudStorage.unmigrated.json': {} })), true);
    assert.equal(await precondition(makeCtx({ 'apps/a.json': app('a') })), true);
  });

  describe('ids', () => {
    it('accepts a safe free id and refuses taken, reserved and invalid ones', () => {
      const taken = new Set(['nextcloud']);
      assert.equal(isUsableId('nextcloud-hq', taken), true);
      assert.equal(isUsableId('nextcloud', taken), false);
      assert.equal(isUsableId('ifinder', taken), false);
      assert.equal(isUsableId('Jira', taken), false);
      assert.equal(isUsableId('workflow_x', taken), false);
      assert.equal(isUsableId('a__b', taken), false);
      assert.equal(isUsableId('has space', taken), false);
      assert.equal(isUsableId('x'.repeat(65), taken), false);
      assert.equal(isUsableId(undefined, taken), false);
    });

    it('falls back to <type>-<provider id>, numbered until free', () => {
      assert.equal(fallbackId('nextcloud', 'ifinder', new Set()), 'nextcloud-ifinder');
      assert.equal(
        fallbackId('nextcloud', 'ifinder', new Set(['nextcloud-ifinder'])),
        'nextcloud-ifinder-2'
      );
      assert.equal(fallbackId('office365', 'a__b c', new Set()), 'office365-a_b-c');
      assert.equal(fallbackId('googledrive', '', new Set()), 'googledrive');
      assert.ok(fallbackId('nextcloud', 'y'.repeat(100), new Set()).length <= 64);
    });
  });

  describe('rename to the provider id', () => {
    it('renames, drops providerId, and keeps the callback path and token key of the provider', () => {
      const installed = [
        storage('office365', O365, { tenantId: 't', providerId: 'o365-corp' }),
        storage('googledrive', GDRIVE, { providerId: 'googledrive' })
      ];
      const ctx = makeCtx({});
      const { renames, changed } = renameToProviderIds(installed, ctx);
      assert.equal(changed, true);
      assert.deepEqual([...renames], [['office365', 'o365-corp']]);
      assert.equal(installed[0].id, 'o365-corp');
      assert.equal(installed[0].values.providerId, undefined);
      assert.equal(installed[1].id, 'googledrive');
      assert.equal(installed[1].values.providerId, undefined);
      // What users and the provider see stays the same.
      const provider = providerFromInstance(installed[0]);
      assert.equal(provider.id, 'o365-corp');
      assert.equal(
        cloudStorageCallbackPath(provider.type, provider.id),
        '/api/integrations/office365/o365-corp/callback'
      );
    });

    it('keeps the id with a warning when the provider id is taken, and on a clash of two providers', () => {
      const installed = [
        storage('office365', O365, { providerId: 'main' }),
        storage('nextcloud', NEXTCLOUD, { providerId: 'main' }),
        storage('googledrive', GDRIVE, { providerId: 'jira' }),
        { id: 'other', definition: 'com.example/other', values: { providerId: 'x' } }
      ];
      const ctx = makeCtx({});
      const { renames } = renameToProviderIds(installed, ctx);
      assert.deepEqual([...renames], [['office365', 'main']]);
      assert.deepEqual(
        installed.map(i => i.id),
        ['main', 'nextcloud', 'googledrive', 'other']
      );
      assert.equal(ctx.warnings.length, 2);
      assert.match(ctx.warnings[0], /"nextcloud" keeps its id.*"main".*connect again/);
      assert.match(ctx.warnings[1], /"googledrive" keeps its id.*"jira"/);
      // Another definition's providerId-like value is none of our business.
      assert.equal(installed[3].values.providerId, 'x');
    });

    it('renames group grants without duplicates', () => {
      const renames = new Map([['office365', 'o365-corp']]);
      assert.deepEqual(renamedGrants(['office365', 'o365-corp', 'websearch'], renames), [
        'o365-corp',
        'websearch'
      ]);
      assert.equal(renamedGrants(['*'], renames), null);
      assert.equal(renamedGrants(undefined, renames), null);
    });
  });

  describe('apps', () => {
    it('binds type:storage as optional for the switch, removes it either way, renames bindings', () => {
      const renames = new Map([['office365', 'o365-corp']]);
      const on = app('a', { upload: { enabled: true, cloudStorageUpload: { enabled: true } } });
      assert.deepEqual(migrateApp(on, renames), [
        'upload.cloudStorageUpload → integrations["type:storage"]'
      ]);
      assert.deepEqual(on.integrations, { [STORAGE_TYPE_BINDING]: { required: false } });
      assert.equal(Object.hasOwn(on.upload, 'cloudStorageUpload'), false);

      const off = app('b', { upload: { enabled: true, cloudStorageUpload: { enabled: false } } });
      migrateApp(off, renames);
      assert.equal(off.integrations, undefined);
      assert.equal(Object.hasOwn(off.upload, 'cloudStorageUpload'), false);

      const kept = app('c', {
        upload: { cloudStorageUpload: { enabled: true } },
        integrations: { 'type:storage': { required: true }, office365: {} }
      });
      migrateApp(kept, renames);
      assert.deepEqual(kept.integrations, { 'type:storage': { required: true }, 'o365-corp': {} });

      assert.deepEqual(migrateApp(app('d'), renames), []);
    });
  });

  it('migrates a whole installation', async () => {
    const files = afterV200();
    const ctx = makeCtx(files);
    await up(ctx, { crypto });

    // Renamed to the provider ids, providerId gone, the parked Nextcloud installed.
    assert.deepEqual(
      installedOf(files).map(i => i.id),
      ['o365-corp', 'googledrive', 'nextcloud-main', 'websearch', 'nextcloud-branch']
    );
    for (const instance of installedOf(files)) {
      assert.equal(instance.values?.providerId, undefined);
    }
    const branch = byId(files, 'nextcloud-branch');
    assert.equal(branch.definition, NEXTCLOUD);
    assert.equal(branch.enabled, true);
    assert.deepEqual(branch.label, { en: 'Branch office' });
    assert.deepEqual(branch.values, {
      clientId: 'branch-client',
      clientSecretRef: 'cloudstorage_nextcloud-branch',
      serverUrl: 'https://branch.example.com'
    });
    assert.equal(branch.auth.mode, 'oauth-user');
    assert.equal('config/cloudStorage.unmigrated.json' in files, false);

    // Two Nextcloud servers side by side, each with its own callback.
    const providers = installedOf(files).map(providerFromInstance).filter(Boolean);
    assert.deepEqual(
      providers.filter(p => p.type === 'nextcloud').map(p => [p.id, p.serverUrl]),
      [
        ['nextcloud-main', 'https://cloud.example.com'],
        ['nextcloud-branch', 'https://branch.example.com']
      ]
    );

    // References follow the rename.
    assert.deepEqual(files['config/groups.json'].groups.finance.permissions.integrations, [
      'o365-corp',
      'nextcloud-main',
      'websearch',
      'type:storage'
    ]);
    assert.deepEqual(files['config/groups.json'].groups.users.permissions.integrations, ['*']);
    assert.deepEqual(files['apps/bound.json'].integrations, { 'o365-corp': { required: false } });

    // The switch became the binding.
    assert.deepEqual(files['apps/file-analysis.json'].integrations, {
      'type:storage': { required: false }
    });
    assert.equal(
      Object.hasOwn(files['apps/file-analysis.json'].upload, 'cloudStorageUpload'),
      false
    );
    assert.equal(files['apps/chat.json'].integrations, undefined);
    assert.equal(Object.hasOwn(files['apps/chat.json'].upload, 'cloudStorageUpload'), false);
    assert.deepEqual(files['apps/plain.json'], app('plain'));

    // The V061 tenant credential is gone; the others stay.
    assert.deepEqual(Object.keys(files['config/credentials.json'].credentials).sort(), [
      'cloudstorage_nextcloud-branch',
      'secret-ref'
    ]);
    assert.equal(ctx.warnings.length, 0);

    // Idempotent: nothing left to do.
    const again = makeCtx(files);
    await up(again, { crypto });
    assert.equal(again.writes, 0);
    assert.equal(again.deletes, 0);
  });

  it('installs parked providers with their secrets and a fallback id, keeping unknown types', async () => {
    const files = {
      'config/integrations.json': integrationsFile([storage('office365', O365, { tenantId: 't' })]),
      'config/cloudStorage.unmigrated.json': {
        enabled: false,
        providers: [
          {
            id: 'office365',
            type: 'office365',
            displayName: 'Second tenant',
            enabled: true,
            clientId: 'c2',
            clientSecretRef: 'sec2',
            tenantIdRef: 'tenant-two',
            sources: { teams: false }
          },
          {
            id: 'gdrive-2',
            type: 'googledrive',
            name: 'gdrive-2',
            enabled: true,
            clientId: 'g2',
            clientSecret: 'plain-google-secret',
            sources: { sharedWithMe: false }
          },
          { id: 'box', type: 'box', enabled: true }
        ]
      },
      'config/credentials.json': {
        credentials: {
          'tenant-two': { id: 'tenant-two', type: 'secret', value: 'ENC[tenant-2]' },
          sec2: { id: 'sec2', type: 'secret', value: 'ENC[x]' }
        }
      }
    };
    const ctx = makeCtx(files);
    await up(ctx, { crypto });

    const second = byId(files, 'office365-office365');
    assert.equal(second.definition, O365);
    // The former block was switched off: the provider comes in disabled.
    assert.equal(second.enabled, false);
    assert.deepEqual(second.values, {
      clientId: 'c2',
      clientSecretRef: 'sec2',
      tenantId: 'tenant-2',
      sourceTeams: false
    });
    assert.match(
      ctx.warnings.join('\n'),
      /"office365" \(office365\) installed as "office365-office365"/
    );

    const google = byId(files, 'gdrive-2');
    assert.equal(google.values.clientSecretRef, 'integration-gdrive-2-clientSecretRef');
    assert.equal(google.values.sourceSharedWithMe, false);
    assert.deepEqual(
      files['config/credentials.json'].credentials['integration-gdrive-2-clientSecretRef'],
      {
        id: 'integration-gdrive-2-clientSecretRef',
        type: 'secret',
        name: 'gdrive-2: client secret',
        description: 'Managed by the installed integration "gdrive-2"',
        value: 'ENC[plain-google-secret]'
      }
    );

    // The unknown type stays parked; the tenant credential it named is gone.
    assert.deepEqual(files['config/cloudStorage.unmigrated.json'], {
      enabled: false,
      providers: [{ id: 'box', type: 'box', enabled: true }]
    });
    assert.match(ctx.warnings.join('\n'), /unknown type "box"/);
    assert.equal('tenant-two' in files['config/credentials.json'].credentials, false);
    assert.equal('sec2' in files['config/credentials.json'].credentials, true);
  });

  it('removes tenant id credentials only when nothing names them', async () => {
    const files = {
      'config/integrations.json': integrationsFile([
        storage('office365', O365, { tenantId: 'tenant-1' }),
        storage('mcp-x', 'com.intrafind/mcp-server', { tokenRef: 'cloudstorage_old_tenant_2' })
      ]),
      'config/credentials.json': {
        credentials: {
          cloudstorage_old_tenant: {
            id: 'cloudstorage_old_tenant',
            type: 'secret',
            value: 'ENC[t]'
          },
          cloudstorage_old_tenant_2: {
            id: 'cloudstorage_old_tenant_2',
            type: 'secret',
            value: 'ENC[t]'
          },
          'o365-tenant': {
            id: 'o365-tenant',
            type: 'secret',
            name: 'Our tenant',
            value: 'ENC[tenant-1]'
          },
          'tenant-other': { id: 'tenant-other', type: 'secret', value: 'ENC[another]' },
          'api-key': { id: 'api-key', type: 'secret', name: 'API', value: 'ENC[tenant-1]' }
        }
      },
      'tools/x.json': { id: 'x', credentialRef: 'o365-tenant-unrelated' }
    };
    const ctx = makeCtx(files);
    await up(ctx, { crypto });
    assert.deepEqual(Object.keys(files['config/credentials.json'].credentials).sort(), [
      'api-key',
      'cloudstorage_old_tenant_2',
      'tenant-other'
    ]);
    assert.match(ctx.warnings.join('\n'), /"cloudstorage_old_tenant_2".*still referenced; kept/);
  });

  it('restores a tenant id V200 could not decrypt, then removes its credential', async () => {
    const files = {
      'config/integrations.json': integrationsFile([
        storage('office365', O365, { providerId: 'o365-corp' }),
        storage('o365-eu', O365, {}),
        storage('o365-x', O365, {})
      ]),
      'config/credentials.json': {
        credentials: {
          'cloudstorage_o365-corp_tenant': {
            id: 'cloudstorage_o365-corp_tenant',
            type: 'secret',
            name: 'Office365 Tenant (o365-corp)',
            value: 'ENC[tenant-corp]'
          },
          'cloudstorage_o365-eu_tenant_2': {
            id: 'cloudstorage_o365-eu_tenant_2',
            type: 'secret',
            value: 'ENC[broken]'
          }
        }
      }
    };
    const ctx = makeCtx(files);
    await up(ctx, { crypto });
    assert.equal(byId(files, 'o365-corp').values.tenantId, 'tenant-corp');
    assert.equal(byId(files, 'o365-eu').values.tenantId, undefined);
    assert.match(ctx.logs.join('\n'), /"o365-corp": tenant id restored from credential/);
    const warnings = ctx.warnings.join('\n');
    assert.match(
      warnings,
      /"o365-eu" has no tenant id and the credential "cloudstorage_o365-eu_tenant_2" could not be read/
    );
    assert.match(warnings, /"o365-x" has no tenant id; enter it/);
    // The restored one is gone; the unreadable one may be the only copy and stays.
    assert.deepEqual(Object.keys(files['config/credentials.json'].credentials), [
      'cloudstorage_o365-eu_tenant_2'
    ]);
    assert.match(warnings, /"cloudstorage_o365-eu_tenant_2".*could not be read; kept/);
  });

  it('turns a parked provider into the installation the generic code reads', () => {
    const instance = instanceFrom(
      {
        id: 'nc',
        type: 'nextcloud',
        serverUrl: ' https://x.example.com ',
        clientId: 'c',
        clientSecretRef: 'r',
        redirectUri: 'https://ihub.example.com/ihub/api/integrations/nextcloud/nc/callback'
      },
      'nc'
    );
    assert.equal(instance.values.serverUrl, 'https://x.example.com');
    const provider = providerFromInstance(instance);
    assert.equal(provider.id, 'nc');
    assert.equal(provider.redirectUri, instance.values.redirectUri);
    assert.equal(instanceFrom({ id: 'x', type: 'dropbox' }, 'x'), null);
  });

  it('does nothing without files', async () => {
    const files = {};
    const ctx = makeCtx(files);
    await up(ctx, { crypto });
    assert.equal(ctx.writes, 0);
    assert.deepEqual(files, {});
  });

  it('migrates the legacy config/apps.json array', async () => {
    const files = {
      'config/apps.json': [
        app('legacy', { upload: { enabled: true, cloudStorageUpload: { enabled: true } } }),
        app('other')
      ]
    };
    await up(makeCtx(files), { crypto });
    assert.deepEqual(files['config/apps.json'][0].integrations, {
      'type:storage': { required: false }
    });
    assert.deepEqual(files['config/apps.json'][1], app('other'));
  });
});

describe('V206 id cleanup without regex backtracking', () => {
  it('trims only leading and trailing characters of the set', () => {
    assert.equal(trimChars('', '-._'), '');
    assert.equal(trimChars('---', '-._'), '');
    assert.equal(trimChars('-._a_b.-', '-._'), 'a_b');
    assert.equal(trimChars('a--b', '-._'), 'a--b');
    assert.equal(trimChars('_-a-_', '_'), '-a-');
    assert.equal(trimChars('a', '_'), 'a');
  });

  it('cleans a provider id for the fallback id as the former regexes did', () => {
    assert.equal(fallbackId('office365', '--x--', new Set()), 'office365-x');
    assert.equal(fallbackId('office365', '...', new Set()), 'office365');
    assert.equal(fallbackId('office365', ' a ', new Set()), 'office365-a');
    assert.equal(fallbackId('office365', 'a..b', new Set()), 'office365-a..b');
    assert.equal(fallbackId('office365', '__a__', new Set()), 'office365-a');
  });

  it("derives V061's credential id as V061 did", () => {
    assert.equal(v061IdOf('__a b__'), 'a_b');
    assert.equal(v061IdOf('-a-'), '-a-');
    assert.equal(v061IdOf('___'), 'default');
    assert.equal(v061IdOf(''), 'default');
    assert.equal(v061IdOf(undefined), 'default');
    assert.equal(v061IdOf('x'.repeat(70)), 'x'.repeat(60));
  });

  it('stays linear on a long inner run (the former regexes took seconds)', () => {
    const started = performance.now();
    const dashes = `a${'-'.repeat(100_000)}b`;
    const underscores = `a${'_'.repeat(100_000)}b`;
    assert.equal(fallbackId('office365', dashes, new Set()), `office365-a${'-'.repeat(45)}`);
    assert.equal(v061IdOf(underscores), `a${'_'.repeat(59)}`);
    assert.ok(performance.now() - started < 1000);
  });
});

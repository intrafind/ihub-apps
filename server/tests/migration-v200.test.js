// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V200: `platform.cloudStorage` providers become the three cloud storage installations. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  instanceFrom,
  secretsOf,
  chooseProviders
} from '../migrations/V200__cloud_storage_installed_integrations.js';
import { providerFromInstance } from '../services/integrations/cloudStorageConfig.js';

function makeCtx(files) {
  const logs = [];
  const warnings = [];
  return {
    logs,
    warnings,
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = structuredClone(data);
    },
    deleteFile: async rel => {
      delete files[rel];
    },
    listFiles: async () => [],
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

const crypto = { encrypt: v => `enc(${v})`, decrypt: v => v.replace(/^enc\((.*)\)$/, '$1') };

const O365 = {
  id: 'office365-main',
  name: 'office365-main',
  displayName: 'Company SharePoint',
  type: 'office365',
  enabled: true,
  tenantIdRef: 'cloudstorage_office365-main_tenant',
  clientId: 'client-o',
  clientSecretRef: 'cloudstorage_office365-main',
  siteUrl: 'https://company.sharepoint.com',
  sources: { personalDrive: true, followedSites: false, teams: true }
};
const GDRIVE = {
  id: 'googledrive',
  name: 'googledrive',
  displayName: 'Google Drive',
  type: 'googledrive',
  enabled: false,
  clientId: 'client-g',
  clientSecretRef: 'cloudstorage_googledrive',
  redirectUri: 'https://ihub.example/api/integrations/googledrive/googledrive/callback',
  sources: { myDrive: true, sharedDrives: true, sharedWithMe: false }
};
const NEXTCLOUD = {
  id: 'nextcloud-main',
  name: 'nextcloud-main',
  displayName: 'Company Nextcloud',
  type: 'nextcloud',
  enabled: true,
  serverUrl: 'https://nextcloud.example.com',
  clientId: 'client-n',
  clientSecret: 'plain-secret'
};

describe('V200 cloud storage → installed integrations', () => {
  it('declares its version', () => assert.equal(version, '200'));

  it('turns a provider into its singleton installation, keeping the provider id', () => {
    const o365 = instanceFrom(O365, true);
    assert.equal(o365.id, 'office365');
    assert.equal(o365.definition, 'com.intrafind/office365');
    assert.equal(o365.enabled, true);
    assert.equal(o365.auth.mode, 'oauth-user');
    assert.deepEqual(o365.label, { en: 'Company SharePoint' });
    assert.deepEqual(o365.values, {
      clientId: 'client-o',
      clientSecretRef: 'cloudstorage_office365-main',
      providerId: 'office365-main',
      siteUrl: 'https://company.sharepoint.com',
      sourceFollowedSites: false
    });
    // A provider whose id is the installation id needs no providerId value.
    const gdrive = instanceFrom(GDRIVE, true);
    assert.equal(gdrive.values.providerId, undefined);
    assert.equal(gdrive.values.sourceSharedWithMe, false);
    assert.equal(gdrive.enabled, false);
    // The block's switch gates every provider.
    assert.equal(instanceFrom(O365, false).enabled, false);
    assert.equal(instanceFrom({ id: 'x', type: 'dropbox' }), null);
  });

  it('reads back as the provider the services expect', () => {
    const provider = providerFromInstance({
      ...instanceFrom(NEXTCLOUD),
      values: { ...instanceFrom(NEXTCLOUD).values, clientSecretRef: 'ref' }
    });
    assert.equal(provider.id, 'nextcloud-main');
    assert.equal(provider.type, 'nextcloud');
    assert.equal(provider.serverUrl, 'https://nextcloud.example.com');
    assert.equal(provider.displayName, 'Company Nextcloud');
    const o365 = providerFromInstance({
      ...instanceFrom(O365),
      values: { ...instanceFrom(O365).values, tenantId: 't' }
    });
    assert.deepEqual(o365.sources, { personalDrive: true, followedSites: false, teams: true });
    assert.equal(o365.tenantId, 't');
  });

  it('finds plain-text secrets and picks one provider per type', () => {
    assert.deepEqual(secretsOf(NEXTCLOUD), [{ field: 'clientSecretRef', value: 'plain-secret' }]);
    assert.deepEqual(secretsOf(O365), []);
    const second = { ...O365, id: 'office365-2', enabled: true };
    const { chosen, skipped } = chooseProviders([{ ...O365, enabled: false }, second, GDRIVE]);
    assert.equal(chosen.get('office365').id, 'office365-2', 'the first enabled one wins');
    assert.equal(chosen.get('googledrive').id, 'googledrive', 'else the first');
    assert.deepEqual(
      skipped.map(p => p.id),
      ['office365-main']
    );
  });

  it('moves the providers, decrypts the tenant id, stores a plain secret and removes the block', async () => {
    const ctx = makeCtx({
      'config/platform.json': {
        features: { integrations: true },
        cloudStorage: { enabled: true, providers: [O365, GDRIVE, NEXTCLOUD] }
      },
      'config/integrations.json': { installed: [], security: {} },
      'config/credentials.json': {
        credentials: {
          'cloudstorage_office365-main_tenant': {
            id: 'cloudstorage_office365-main_tenant',
            type: 'secret',
            value: 'enc(tenant-1)'
          }
        }
      }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx, { crypto });
    const { installed } = ctx.files['config/integrations.json'];
    assert.deepEqual(
      installed.map(i => i.id),
      ['office365', 'googledrive', 'nextcloud']
    );
    assert.equal(installed[0].values.tenantId, 'tenant-1');
    assert.equal(installed[0].enabled, true);
    assert.equal(installed[1].enabled, false);
    assert.equal(installed[2].values.clientSecretRef, 'integration-nextcloud-clientSecretRef');
    assert.equal(installed[2].values.providerId, 'nextcloud-main');
    assert.ok(installed[2].installedAt);
    const credential =
      ctx.files['config/credentials.json'].credentials['integration-nextcloud-clientSecretRef'];
    assert.equal(credential.value, 'enc(plain-secret)');
    assert.equal(JSON.stringify(installed).includes('plain-secret'), false);
    assert.equal('cloudStorage' in ctx.files['config/platform.json'], false);
    assert.deepEqual(ctx.files['config/platform.json'].features, { integrations: true });
    assert.equal('config/cloudStorage.unmigrated.json' in ctx.files, false);
    assert.equal(ctx.warnings.length, 0);
  });

  it('keeps a second provider of a type in a side file, and leaves an existing installation alone', async () => {
    const ctx = makeCtx({
      'config/platform.json': {
        cloudStorage: {
          enabled: true,
          providers: [O365, { ...O365, id: 'office365-eu' }, NEXTCLOUD]
        }
      },
      'config/integrations.json': {
        installed: [{ id: 'nextcloud', definition: 'com.intrafind/nextcloud', values: {} }],
        security: {}
      }
    });
    await up(ctx, { crypto });
    const { installed } = ctx.files['config/integrations.json'];
    assert.deepEqual(
      installed.map(i => i.id),
      ['nextcloud', 'office365']
    );
    assert.deepEqual(installed[0], {
      id: 'nextcloud',
      definition: 'com.intrafind/nextcloud',
      values: {}
    });
    const side = ctx.files['config/cloudStorage.unmigrated.json'];
    assert.deepEqual(
      side.providers.map(p => p.id),
      ['office365-eu', 'nextcloud-main']
    );
    assert.equal(ctx.warnings.filter(w => /not migrated/.test(w)).length, 1);
    // The tenant credential is missing: said, not fatal.
    assert.ok(ctx.warnings.some(w => /tenant id credential/.test(w)));
    assert.equal(installed[1].values.tenantId, undefined);
  });

  it('does nothing without the block, and only once', async () => {
    const ctx = makeCtx({ 'config/platform.json': { features: {} } });
    await up(ctx, { crypto });
    assert.equal('config/integrations.json' in ctx.files, false);
    const once = makeCtx({
      'config/platform.json': { cloudStorage: { enabled: true, providers: [GDRIVE] } }
    });
    await up(once, { crypto });
    await up(once, { crypto });
    assert.equal(once.files['config/integrations.json'].installed.length, 1);
    assert.equal(await precondition(makeCtx({})), false);
  });
});

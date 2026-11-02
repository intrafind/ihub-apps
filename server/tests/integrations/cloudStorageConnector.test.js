// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The storage providers as installations of `com.intrafind/office365`,
 * `com.intrafind/google-drive` and `com.intrafind/nextcloud`, several per
 * provider: the provider shape the services and the client read, the
 * installation id as the provider id (callback URLs, stored connections), the
 * base-path-aware redirect URI, the status with its connected users per
 * installation, and the retired `platform.cloudStorage` block.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import configCache from '../../configCache.js';
import tokenStorage from '../../services/TokenStorageService.js';
import { runWithContext } from '../../utils/requestContext.js';
import {
  cloudStorageCallbackPath,
  cloudStorageStatus,
  findCloudStorageProvider,
  isCloudStorageProviderConfigured,
  listCloudStorageConnections,
  listCloudStorageInstallations,
  listCloudStorageProviders,
  providerFromInstance,
  resolveCloudStorageRedirectUri
} from '../../services/integrations/cloudStorageConfig.js';
import {
  office365Connector,
  nextcloudConnector,
  resetCloudStorageConnectionCounts
} from '../../services/integrations/protocols/native/connectors/cloudStorage/index.js';
import { platformConfigSchema } from '../../validators/platformConfigSchema.js';

const INSTALLED = [
  {
    id: 'office365-main',
    definition: 'com.intrafind/office365',
    enabled: true,
    label: { en: 'Company SharePoint', de: 'Firmen-SharePoint' },
    values: {
      tenantId: 'tenant-1',
      clientId: 'client-o',
      clientSecretRef: 'missing-credential',
      sourceTeams: false
    },
    auth: { mode: 'oauth-user' }
  },
  {
    id: 'googledrive',
    definition: 'com.intrafind/google-drive',
    enabled: false,
    values: { clientId: 'client-g', clientSecretRef: 'g' },
    auth: { mode: 'oauth-user' }
  },
  {
    id: 'nextcloud',
    definition: 'com.intrafind/nextcloud',
    enabled: true,
    label: { en: 'Head office' },
    values: {
      serverUrl: 'https://nextcloud.example.com/',
      clientId: 'client-n',
      clientSecretRef: 'n'
    },
    auth: { mode: 'oauth-user' }
  },
  {
    id: 'nextcloud-branch',
    definition: 'com.intrafind/nextcloud',
    enabled: true,
    label: { en: 'Branch office' },
    values: {
      serverUrl: 'https://branch.example.com',
      clientId: 'client-b',
      clientSecretRef: 'b',
      redirectUri:
        'https://ihub.example.com/ihub/api/integrations/nextcloud/nextcloud-branch/callback'
    },
    auth: { mode: 'oauth-user' }
  },
  // Another definition does not count, whatever its id.
  { id: 'other', definition: 'mcp/drawio', enabled: true, values: {} }
];

/** A user whose groups grant every integration. */
const ALL_GRANTED = { id: 'admin', permissions: { integrations: new Set(['*']) } };

/** A request as Express hands it over, behind a proxy. */
function request(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { protocol: 'http', get: name => lower[name.toLowerCase()] };
}

let tokenDir;
let originalBasePath;

before(async () => {
  configCache.setCacheEntry('config/integrations.json', {
    installed: INSTALLED,
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
  tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-cloud-tokens-'));
  originalBasePath = tokenStorage.storageBasePath;
  tokenStorage.storageBasePath = tokenDir;
  await fs.mkdir(path.join(tokenDir, 'office365'), { recursive: true });
  await fs.mkdir(path.join(tokenDir, 'nextcloud'), { recursive: true });
  const token = JSON.stringify({ createdAt: '2026-01-01T00:00:00Z', expiresAt: null });
  await fs.writeFile(path.join(tokenDir, 'office365', 'erin__office365-main.json'), token);
  await fs.writeFile(path.join(tokenDir, 'office365', 'frank__office365-main.json'), token);
  // A connection of another installation of the same provider.
  await fs.writeFile(path.join(tokenDir, 'office365', 'gus__office365-eu.json'), token);
  // Two Nextcloud servers, each with its own users.
  await fs.writeFile(path.join(tokenDir, 'nextcloud', 'erin__nextcloud.json'), token);
  await fs.writeFile(path.join(tokenDir, 'nextcloud', 'hana__nextcloud-branch.json'), token);
  await fs.writeFile(path.join(tokenDir, 'nextcloud', 'ivan__nextcloud-branch.json'), token);
});

after(async () => {
  tokenStorage.storageBasePath = originalBasePath;
  await fs.rm(tokenDir, { recursive: true, force: true });
  resetCloudStorageConnectionCounts();
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
});

describe('storage providers as installations', () => {
  it('reads every installation in the provider shape, its id being the provider id', () => {
    const providers = listCloudStorageProviders();
    assert.deepEqual(
      providers.map(p => `${p.type}:${p.id}:${p.enabled}`),
      [
        'office365:office365-main:true',
        'googledrive:googledrive:false',
        'nextcloud:nextcloud:true',
        'nextcloud:nextcloud-branch:true'
      ]
    );
    assert.deepEqual(
      listCloudStorageInstallations('nextcloud').map(i => i.id),
      ['nextcloud', 'nextcloud-branch']
    );
    const o365 = findCloudStorageProvider('office365-main', 'office365');
    assert.equal(o365.displayName, 'Company SharePoint');
    assert.equal(o365.definition, 'com.intrafind/office365');
    assert.equal(o365.tenantId, 'tenant-1');
    assert.equal(o365.clientSecretRef, 'missing-credential');
    assert.deepEqual(o365.sources, { personalDrive: true, followedSites: true, teams: false });
    assert.equal(findCloudStorageProvider('nextcloud', 'office365'), null, 'the type is checked');
    assert.equal(findCloudStorageProvider('other'), null, 'another definition is no provider');
    assert.equal(providerFromInstance({ id: 'x', definition: 'mcp/drawio' }), null);
  });

  it('keeps two Nextcloud servers side by side', () => {
    const head = findCloudStorageProvider('nextcloud', 'nextcloud');
    const branch = findCloudStorageProvider('nextcloud-branch', 'nextcloud');
    assert.equal(head.serverUrl, 'https://nextcloud.example.com/');
    assert.equal(branch.serverUrl, 'https://branch.example.com');
    assert.equal(head.displayName, 'Head office');
    assert.equal(branch.displayName, 'Branch office');
    assert.notEqual(
      cloudStorageCallbackPath('nextcloud', head.id),
      cloudStorageCallbackPath('nextcloud', branch.id)
    );
  });

  it('answers the client the way platform.cloudStorage did, with the definition, without secrets', () => {
    const status = cloudStorageStatus(ALL_GRANTED);
    assert.equal(status.enabled, true);
    assert.deepEqual(status.providers[0], {
      id: 'office365-main',
      name: 'office365-main',
      displayName: 'Company SharePoint',
      type: 'office365',
      definition: 'com.intrafind/office365',
      enabled: true
    });
    assert.equal(status.providers.length, 4);
    assert.equal(JSON.stringify(status).includes('client'), false);
    assert.equal(
      isCloudStorageProviderConfigured(findCloudStorageProvider('office365-main')),
      true
    );
    assert.equal(
      isCloudStorageProviderConfigured(findCloudStorageProvider('googledrive')),
      false,
      'disabled'
    );
    assert.equal(isCloudStorageProviderConfigured(findCloudStorageProvider('nextcloud')), true);
    assert.equal(isCloudStorageProviderConfigured(null), false);
  });

  it('lists only the installations the user’s groups grant', () => {
    const branchOnly = { id: 'hana', permissions: { integrations: new Set(['nextcloud-branch']) } };
    assert.deepEqual(
      cloudStorageStatus(branchOnly).providers.map(p => p.id),
      ['nextcloud-branch']
    );
    const allNextcloud = {
      id: 'ivan',
      permissions: { integrations: new Set(['com.intrafind/nextcloud']) }
    };
    assert.deepEqual(
      cloudStorageStatus(allNextcloud).providers.map(p => p.id),
      ['nextcloud', 'nextcloud-branch']
    );
    const none = { id: 'x', permissions: { integrations: new Set() } };
    assert.deepEqual(cloudStorageStatus(none), { enabled: false, providers: [] });
  });

  it('derives the redirect URI from the request with the base path, unless one is configured', () => {
    const req = request({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'ihub.example.com' });
    const head = findCloudStorageProvider('nextcloud');
    assert.equal(
      resolveCloudStorageRedirectUri(req, head),
      'https://ihub.example.com/api/integrations/nextcloud/nextcloud/callback'
    );
    runWithContext({ basePathPrefix: '/ihub' }, () => {
      assert.equal(
        resolveCloudStorageRedirectUri(req, head),
        'https://ihub.example.com/ihub/api/integrations/nextcloud/nextcloud/callback'
      );
    });
    const branch = findCloudStorageProvider('nextcloud-branch');
    assert.equal(resolveCloudStorageRedirectUri(null, branch), branch.redirectUri);
    assert.throws(() => resolveCloudStorageRedirectUri(request(), head), /no host/);
    assert.throws(() => resolveCloudStorageRedirectUri(null, head), /no host/);
  });

  it('lists the users connected to each installation', async () => {
    const o365 = await listCloudStorageConnections('office365', 'office365-main');
    assert.deepEqual(
      o365.map(c => c.userId),
      ['erin', 'frank']
    );
    assert.equal(o365[0].createdAt, '2026-01-01T00:00:00Z');
    assert.deepEqual(
      (await listCloudStorageConnections('nextcloud', 'nextcloud')).map(c => c.userId),
      ['erin']
    );
    assert.deepEqual(
      (await listCloudStorageConnections('nextcloud', 'nextcloud-branch')).map(c => c.userId),
      ['hana', 'ivan']
    );
    assert.deepEqual(await listCloudStorageConnections('googledrive', 'googledrive'), []);
    assert.deepEqual(await listCloudStorageConnections('nextcloud'), [], 'an id is needed');
    const viaConnector = await office365Connector.listConnections(INSTALLED[0]);
    assert.equal(viaConnector.length, 2);
    const status = office365Connector.status(INSTALLED[0]);
    assert.equal(status.perUser, true);
    assert.equal(status.connected, true);
    assert.equal(status.userConnections, 2);
    // Counted per installation, not per provider type.
    await nextcloudConnector.listConnections(INSTALLED[3]);
    assert.equal(nextcloudConnector.status(INSTALLED[3]).userConnections, 2);
    await nextcloudConnector.listConnections(INSTALLED[2]);
    assert.equal(nextcloudConnector.status(INSTALLED[2]).userConnections, 1);
    assert.equal(nextcloudConnector.status(INSTALLED[2]).connected, true);
  });

  it('fails the test on a missing client secret before reaching the network', async () => {
    const steps = await office365Connector.test({
      instance: INSTALLED[0],
      values: INSTALLED[0].values,
      user: { id: 'erin' },
      req: request({ Host: 'ihub.example.com' })
    });
    assert.equal(steps[0].id, 'client');
    assert.equal(steps[0].status, 'fail');
    assert.match(steps[0].message, /missing-credential/);
    assert.equal(
      steps.some(step => step.id === 'reachability'),
      false
    );
    const connections = steps.find(step => step.id === 'connections');
    assert.match(connections.message, /2 user\(s\) connected, including you/);
    const redirect = steps.find(step => step.id === 'redirect');
    assert.match(
      redirect.message,
      /http:\/\/ihub\.example\.com\/api\/integrations\/office365\/office365-main\/callback/
    );
  });

  it('checks a configured redirect URI against the installation’s callback path', async () => {
    const values = { ...INSTALLED[3].values };
    const ok = await nextcloudConnector.test({ instance: INSTALLED[3], values, req: null });
    assert.equal(ok.find(step => step.id === 'redirect').status, 'ok');
    const wrong = await nextcloudConnector.test({
      instance: INSTALLED[2],
      values: { ...INSTALLED[2].values, redirectUri: values.redirectUri, clientSecretRef: '' },
      req: null
    });
    const redirect = wrong.find(step => step.id === 'redirect');
    assert.equal(redirect.status, 'warn');
    assert.match(
      redirect.message,
      /should end in \/api\/integrations\/nextcloud\/nextcloud\/callback/
    );
  });

  it('is gone from platform.json', () => {
    assert.equal(
      platformConfigSchema.safeParse({ cloudStorage: { enabled: true } }).success,
      false
    );
    assert.equal(platformConfigSchema.safeParse({}).success, true);
  });
});

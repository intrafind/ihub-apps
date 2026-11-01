// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cloud storage providers as the installations `office365`,
 * `googledrive` and `nextcloud`: the provider shape the services and the
 * client read, the provider id that keeps callback URLs and stored
 * connections valid, the installation status with its connected users, and
 * the retired `platform.cloudStorage` block.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import configCache from '../../configCache.js';
import tokenStorage from '../../services/TokenStorageService.js';
import {
  cloudStorageStatus,
  findCloudStorageProvider,
  isCloudStorageProviderConfigured,
  listCloudStorageConnections,
  listCloudStorageProviders,
  providerFromInstance
} from '../../services/integrations/cloudStorageConfig.js';
import {
  office365Connector,
  nextcloudConnector,
  resetCloudStorageConnectionCounts
} from '../../services/integrations/protocols/native/connectors/cloudStorage/index.js';
import { platformConfigSchema } from '../../validators/platformConfigSchema.js';

const INSTALLED = [
  {
    id: 'office365',
    definition: 'com.intrafind/office365',
    enabled: true,
    label: { en: 'Company SharePoint', de: 'Firmen-SharePoint' },
    values: {
      providerId: 'office365-main',
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
    values: {
      serverUrl: 'https://nextcloud.example.com/',
      clientId: 'client-n',
      clientSecretRef: 'n'
    },
    auth: { mode: 'oauth-user' }
  },
  // Another definition under a provider's id does not count.
  { id: 'other', definition: 'mcp/drawio', enabled: true, values: {} }
];

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
  // A connection of another provider id of the same type, and the legacy single slot.
  await fs.writeFile(path.join(tokenDir, 'office365', 'gus__office365-eu.json'), token);
  await fs.writeFile(path.join(tokenDir, 'nextcloud', 'erin.json'), token);
});

after(async () => {
  tokenStorage.storageBasePath = originalBasePath;
  await fs.rm(tokenDir, { recursive: true, force: true });
  resetCloudStorageConnectionCounts();
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
});

describe('cloud storage installations as providers', () => {
  it('reads each installation in the provider shape, with its provider id', () => {
    const providers = listCloudStorageProviders();
    assert.deepEqual(
      providers.map(p => `${p.type}:${p.id}:${p.enabled}`),
      ['office365:office365-main:true', 'googledrive:googledrive:false', 'nextcloud:nextcloud:true']
    );
    const o365 = findCloudStorageProvider('office365-main', 'office365');
    assert.equal(o365.displayName, 'Company SharePoint');
    assert.equal(o365.tenantId, 'tenant-1');
    assert.equal(o365.clientSecretRef, 'missing-credential');
    assert.deepEqual(o365.sources, { personalDrive: true, followedSites: true, teams: false });
    assert.equal(
      findCloudStorageProvider('office365', 'office365'),
      null,
      'the installation id is not the provider id here'
    );
    assert.equal(findCloudStorageProvider('nextcloud', 'office365'), null, 'the type is checked');
    assert.equal(findCloudStorageProvider('nextcloud').serverUrl, 'https://nextcloud.example.com/');
    assert.equal(providerFromInstance({ id: 'x', definition: 'mcp/drawio' }), null);
  });

  it('answers the client the way platform.cloudStorage did, without secrets', () => {
    const status = cloudStorageStatus();
    assert.equal(status.enabled, true);
    assert.deepEqual(status.providers[0], {
      id: 'office365-main',
      name: 'office365-main',
      displayName: 'Company SharePoint',
      type: 'office365',
      enabled: true
    });
    assert.equal(JSON.stringify(status).includes('client'), false);
    assert.equal(isCloudStorageProviderConfigured('office365'), true);
    assert.equal(isCloudStorageProviderConfigured('googledrive'), false, 'disabled');
    assert.equal(isCloudStorageProviderConfigured('nextcloud'), true);
  });

  it('lists the users connected to the installation’s provider id, legacy slot included', async () => {
    const o365 = await listCloudStorageConnections('office365');
    assert.deepEqual(
      o365.map(c => c.userId),
      ['erin', 'frank']
    );
    assert.equal(o365[0].createdAt, '2026-01-01T00:00:00Z');
    const nextcloud = await listCloudStorageConnections('nextcloud');
    assert.deepEqual(
      nextcloud.map(c => c.userId),
      ['erin']
    );
    assert.deepEqual(await listCloudStorageConnections('googledrive'), []);
    const viaConnector = await office365Connector.listConnections(INSTALLED[0]);
    assert.equal(viaConnector.length, 2);
    const status = office365Connector.status(INSTALLED[0]);
    assert.equal(status.perUser, true);
    assert.equal(status.connected, true);
    assert.equal(status.userConnections, 2);
    assert.equal(nextcloudConnector.status(INSTALLED[2]).connected, true);
  });

  it('fails the test on a missing client secret before reaching the network', async () => {
    const steps = await office365Connector.test({
      instance: INSTALLED[0],
      values: INSTALLED[0].values,
      user: { id: 'erin' },
      req: null
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
    assert.match(redirect.message, /\/api\/integrations\/office365\/office365-main\/callback/);
  });

  it('is gone from platform.json', () => {
    assert.equal(
      platformConfigSchema.safeParse({ cloudStorage: { enabled: true } }).success,
      false
    );
    assert.equal(platformConfigSchema.safeParse({}).success, true);
  });
});

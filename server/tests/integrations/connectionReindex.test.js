// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one-time re-index of the token tree into the connection index
 * (services/integrations/auth/connectionReindex.js): after the upgrade every
 * user with a stored Jira, Office 365, Google Drive, Nextcloud or per-user MCP
 * token is still connected without consenting again — including a legacy,
 * unscoped cloud storage file. No token file is moved or rewritten.
 *
 * Fixture: token files written exactly as the stacks wrote them before this
 * release (camelCase payloads for Jira and cloud storage, the MCP payload with
 * its endpoint binding under a hashed storage id).
 *
 * Run: node --test server/tests/integrations/connectionReindex.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tokenStorage from '../../services/TokenStorageService.js';
import configCache from '../../configCache.js';
import { FilesystemDocumentStore } from '../../storage/providers/filesystem/FilesystemDocumentStore.js';
import mcpClientManager from '../../services/mcp/McpClientManager.js';
import { McpOAuthClientStore } from '../../services/mcp/mcpOAuthClientStore.js';
import { McpToolCatalogStore } from '../../services/mcp/mcpToolCatalogStore.js';
import { tokenBindingFor, readUserTokensFor } from '../../services/mcp/mcpUserTokens.js';
import { tokenStorageIdFor } from '../../services/integrations/auth/tokenSecrets.js';
import {
  IntegrationConnectionService,
  connectionIdFor
} from '../../services/integrations/auth/IntegrationConnectionService.js';
import { OAuthFlowStore } from '../../services/integrations/auth/oauthFlowStore.js';
import {
  REINDEX_MARKER_KEY,
  REINDEX_MARKER_NAMESPACE,
  reindexIntegrationConnections
} from '../../services/integrations/auth/connectionReindex.js';
import { scratchDocuments } from '../helpers/testStorage.js';

const scratch = await scratchDocuments();

const tmp = mkdtempSync(path.join(os.tmpdir(), 'connection-reindex-'));
const tokenDir = path.join(tmp, 'integrations');
const dataDir = path.join(tmp, 'data');
const saved = {
  base: tokenStorage.storageBasePath,
  key: tokenStorage.encryptionKey,
  getIntegrations: configCache.getIntegrations
};

const MCP_SERVER = {
  id: 'okta',
  name: 'Okta MCP',
  transport: { type: 'streamableHttp', url: 'https://okta-mcp.example.com/mcp' },
  auth: { type: 'oauthUser' }
};

const installed = [
  {
    id: 'jira',
    definition: 'com.intrafind/jira',
    enabled: true,
    values: { clientId: 'jira-client', clientSecretRef: 'jira-secret' }
  },
  {
    id: 'o365-main',
    definition: 'com.intrafind/office365',
    enabled: true,
    values: { tenantId: 't1', clientId: 'o365-client', clientSecretRef: 's' }
  },
  {
    id: 'nextcloud',
    definition: 'com.intrafind/nextcloud',
    enabled: true,
    values: { serverUrl: 'https://nc.example.com', clientId: 'nc', clientSecretRef: 's' }
  },
  {
    id: 'gdrive-a',
    definition: 'com.intrafind/google-drive',
    enabled: true,
    values: { clientId: 'g', clientSecretRef: 's' }
  },
  {
    id: 'gdrive-b',
    definition: 'com.intrafind/google-drive',
    enabled: true,
    values: { clientId: 'g2', clientSecretRef: 's' }
  }
];

const future = 3600;
const camel = extra => ({
  accessToken: 'at',
  refreshToken: 'rt',
  expiresIn: future,
  scope: 'read write',
  ...extra
});
const OIDC_USER = 'auth0|erin';

/** Every file of the token tree with its content, to prove nothing moved or changed. */
function snapshot() {
  const out = {};
  for (const service of readdirSync(tokenDir)) {
    for (const file of readdirSync(path.join(tokenDir, service))) {
      out[`${service}/${file}`] = readFileSync(path.join(tokenDir, service, file), 'utf8');
    }
  }
  return out;
}

let documents;
let service;
let locks;

before(async () => {
  tokenStorage.storageBasePath = tokenDir;
  tokenStorage.encryptionKey = 'f'.repeat(64);
  configCache.getIntegrations = () => ({ data: { installed } });

  // Jira: one slot per user.
  await tokenStorage.storeUserTokens('alice', 'jira', camel());
  // Office 365: scoped file.
  await tokenStorage.storeUserTokens(
    'bob',
    'office365',
    camel({ providerId: 'o365-main' }),
    'o365-main'
  );
  // Nextcloud: a legacy, unscoped file without providerId, one installation of the service.
  await tokenStorage.storeUserTokens('carol', 'nextcloud', camel({ nextcloudUserId: 'carol-nc' }));
  // Google Drive: a legacy file while there are two installations → skipped and logged.
  await tokenStorage.storeUserTokens('dave', 'googledrive', camel());
  // Per-user MCP: hashed storage id for an OIDC subject, bound to the endpoint.
  await mcpClientManager.shutdown();
  mcpClientManager.clientStore = new McpOAuthClientStore({ documents: scratch.documents });
  mcpClientManager.catalogStore = new McpToolCatalogStore({ documents: scratch.documents });
  await mcpClientManager.initialize({ servers: [MCP_SERVER] });
  await tokenStorage.storeUserTokens(
    tokenStorageIdFor(OIDC_USER),
    'mcp',
    {
      access_token: 'mcp-at',
      token_type: 'bearer',
      refresh_token: 'mcp-rt',
      expiresIn: future,
      scope: 'openid',
      binding: {
        ...tokenBindingFor(MCP_SERVER, {
          authorizationServerUrl: 'https://okta-mcp.example.com/',
          clientId: 'dcr-client'
        })
      },
      userId: OIDC_USER,
      serverId: 'okta',
      obtainedAt: new Date().toISOString()
    },
    'okta'
  );
  // A file nobody can read any more (another key): skipped, never deleted.
  mkdirSync(path.join(tokenDir, 'office365'), { recursive: true });
  writeFileSync(path.join(tokenDir, 'office365', 'zoe__o365-main.json'), '{"broken": true}');

  documents = new FilesystemDocumentStore({ baseDir: dataDir });
  locks = {
    calls: [],
    async withLock(name, fn) {
      this.calls.push(name);
      return fn({ name, token: 1, isCurrent: async () => true });
    }
  };
  service = new IntegrationConnectionService({
    documents,
    flowStore: new OAuthFlowStore({ documents: scratch.documents }),
    audit: () => {}
  });
});

after(async () => {
  await mcpClientManager.shutdown();
  tokenStorage.storageBasePath = saved.base;
  tokenStorage.encryptionKey = saved.key;
  configCache.getIntegrations = saved.getIntegrations;
  rmSync(tmp, { recursive: true, force: true });
});

describe('re-index of the token tree', () => {
  it('indexes every stack, keeps every user connected and moves nothing', async () => {
    const before = snapshot();
    const result = await reindexIntegrationConnections({ documents, locks, service });
    assert.equal(result.ran, true);
    assert.equal(result.indexed, 4, JSON.stringify(result));
    assert.equal(result.skipped, 2, 'the ambiguous legacy file and the unreadable one');
    assert.deepEqual(locks.calls, ['runtime-import:integration-connections']);
    assert.deepEqual(snapshot(), before, 'no token file was moved, re-encrypted or deleted');

    const expectations = [
      ['jira', 'alice', 'tokenstore:jira/alice', 'https://auth.atlassian.com'],
      [
        'o365-main',
        'bob',
        'tokenstore:office365/bob__o365-main',
        'https://login.microsoftonline.com/t1/v2.0'
      ],
      ['nextcloud', 'carol', 'tokenstore:nextcloud/carol', 'https://nc.example.com'],
      [
        'okta',
        OIDC_USER,
        `tokenstore:mcp/${tokenStorageIdFor(OIDC_USER)}__okta`,
        'https://okta-mcp.example.com/'
      ]
    ];
    for (const [integration, userId, secretRef, issuer] of expectations) {
      const record = await service.getConnection(
        connectionIdFor(integration, { type: 'user', id: userId })
      );
      assert.ok(record, `${integration}/${userId} indexed`);
      assert.equal(record.status, 'active');
      assert.equal(record.secretRef, secretRef);
      assert.equal(record.issuer, issuer);
      assert.deepEqual(record.principal, { type: 'user', id: userId });
      const resolved = await service.resolve({ type: 'user', id: userId }, integration);
      assert.equal(resolved.ok, true, `${integration}/${userId} still connected`);
    }

    // The tokens are used where they always were, no reconnect.
    assert.equal(
      (await service.getUserTokens({ installationId: 'jira', userId: 'alice' })).accessToken,
      'at'
    );
    assert.equal(
      (await service.getUserTokens({ installationId: 'nextcloud', userId: 'carol' }))
        .nextcloudUserId,
      'carol-nc',
      'the legacy unscoped Nextcloud file is still read'
    );
    assert.equal((await readUserTokensFor(OIDC_USER, MCP_SERVER)).access_token, 'mcp-at');
    const record = await service.getConnection(
      connectionIdFor('o365-main', { type: 'user', id: 'bob' })
    );
    assert.deepEqual(record.scopesGranted, ['read', 'write']);
  });

  it('runs once (marker) and is idempotent when forced', async () => {
    const marker = await documents.get(REINDEX_MARKER_NAMESPACE, REINDEX_MARKER_KEY);
    assert.ok(marker.data.completedAt);
    assert.equal(marker.data.indexed, 4);

    const again = await reindexIntegrationConnections({ documents, locks, service });
    assert.equal(again.ran, false);
    assert.equal(again.reason, 'already-indexed');

    // A record changed by live use since is never overwritten by the re-index.
    const id = connectionIdFor('jira', { type: 'user', id: 'alice' });
    await service.updateConnection(id, { lastUsedAt: '2026-11-02T10:00:00.000Z' });
    const forced = await reindexIntegrationConnections({ documents, locks, service, force: true });
    assert.equal(forced.indexed, 0);
    assert.equal(forced.existing, 4);
    assert.equal((await service.getConnection(id)).lastUsedAt, '2026-11-02T10:00:00.000Z');
  });

  it('skips while another worker holds the lock', async () => {
    const busy = {
      async withLock() {
        const error = new Error('busy');
        error.code = 'LOCK_TIMEOUT';
        throw error;
      }
    };
    const other = new FilesystemDocumentStore({ baseDir: path.join(tmp, 'other-data') });
    const result = await reindexIntegrationConnections({
      documents: other,
      locks: busy,
      service
    });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'in-progress');
  });
});

describe('re-index at startup', () => {
  it('runs after the worker is serving, not on the path to listen', () => {
    const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    const reindex = source.indexOf('await reindexIntegrationConnections()');
    assert.ok(reindex > 0, 'server.js runs the re-index');
    assert.ok(
      reindex > source.indexOf('server.listen(PORT'),
      'the re-index must not delay binding the port'
    );
  });
});

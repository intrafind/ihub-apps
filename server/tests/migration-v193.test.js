// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V193: MCP servers move from mcpServers.json into the installed
 * integrations; apps bind them instead of listing the server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  description,
  instanceFrom,
  migrateApp,
  authModeOf,
  loadShippedMcpDefinitions
} from '../migrations/V193__mcp_servers_installed_integrations.js';

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
        .filter(rel => rel.startsWith(`${dir}/`) && rel.endsWith(pattern.replace('*', '')))
        .map(rel => rel.slice(dir.length + 1)),
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const SHIPPED = [
  {
    id: 'mcp/drawio',
    url: 'https://mcp.draw.io/mcp',
    transportType: 'streamableHttp',
    authModes: ['none']
  },
  {
    id: 'mcp/github',
    url: 'https://api.githubcopilot.com/mcp/',
    transportType: 'streamableHttp',
    authModes: ['service-account']
  }
];

const drawio = {
  id: 'drawio',
  name: { en: 'draw.io', de: 'draw.io' },
  enabled: false,
  transport: { type: 'streamableHttp', url: 'https://mcp.draw.io/mcp' },
  auth: { type: 'none' },
  allowedTools: ['*'],
  timeoutMs: 60000,
  apps: { enabled: true }
};

describe('V193 mcp servers → installed integrations', () => {
  it('declares its version', () => {
    assert.equal(version, '193');
    assert.equal(description, 'mcp_servers_installed_integrations');
  });

  it('maps auth blocks to sign-in modes', () => {
    assert.equal(authModeOf({ type: 'none' }), 'none');
    assert.equal(authModeOf({ type: 'bearer', tokenRef: 'x' }), 'service-account');
    assert.equal(authModeOf({ type: 'header', headerName: 'X', valueRef: 'x' }), 'service-account');
    assert.equal(authModeOf({ type: 'oauth', tokenUrl: 'u' }), 'oauth-client');
    assert.equal(authModeOf({ type: 'oauthUser' }), 'oauth-user');
    assert.equal(authModeOf(undefined), 'none');
  });

  it('installs a shipped definition when the endpoint matches', () => {
    const inst = instanceFrom(drawio, SHIPPED);
    assert.equal(inst.definition, 'mcp/drawio');
    assert.equal(inst.enabled, false);
    assert.deepEqual(inst.values, {});
    assert.equal(inst.timeoutMs, 60000);
    assert.deepEqual(inst.actions.enabled, ['*']);
    assert.deepEqual(inst.label, { en: 'draw.io', de: 'draw.io' });
  });

  it('falls back to the generic definition when the sign-in mode does not fit the shipped one', () => {
    const inst = instanceFrom(
      {
        id: 'gh',
        transport: { type: 'streamableHttp', url: 'https://api.githubcopilot.com/mcp/' },
        auth: { type: 'oauthUser', scopes: ['repo'], clientId: 'c1', clientSecretRef: 'gh-secret' }
      },
      SHIPPED
    );
    assert.equal(inst.definition, 'com.intrafind/mcp-server');
    assert.equal(inst.auth.mode, 'oauth-user');
    assert.equal(inst.auth.credentialRef, 'gh-secret');
    assert.deepEqual(inst.values.oauthScopes, ['repo']);
    assert.equal(inst.values.oauthClientId, 'c1');
    assert.equal(inst.values.url, 'https://api.githubcopilot.com/mcp/');
  });

  it('keeps the credential references and header details of a service account', () => {
    const inst = instanceFrom(
      {
        id: 'wix',
        name: 'Wix',
        transport: {
          type: 'streamableHttp',
          url: 'https://mcp.wix.com/mcp',
          headers: { 'wix-account-id': '123' }
        },
        auth: { type: 'header', headerName: 'Authorization', valuePrefix: '', valueRef: 'wix-key' },
        allowedTools: ['sites_list', 'sites_get'],
        toolPrefix: 'wx_'
      },
      SHIPPED
    );
    assert.equal(inst.definition, 'com.intrafind/mcp-server');
    assert.equal(inst.auth.mode, 'service-account');
    assert.equal(inst.auth.credentialRef, 'wix-key');
    assert.equal(inst.values.authKind, 'header');
    assert.equal(inst.values.headerName, 'Authorization');
    assert.deepEqual(inst.values.headers, ['wix-account-id: 123']);
    assert.deepEqual(inst.actions.enabled, ['sites_list', 'sites_get']);
    assert.equal(inst.values.toolPrefix, 'wx_');
    assert.deepEqual(inst.label, { en: 'Wix' });
  });

  it('carries a local process over with command, args, env and tuning', () => {
    const inst = instanceFrom(
      {
        id: 'local',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'some-server'],
          env: { API_URL: 'http://x' },
          cwd: '/srv'
        },
        auth: { type: 'basic', username: 'bob', passwordRef: 'pw' },
        timeoutMs: 200000,
        apps: { enabled: false },
        reconnect: { enabled: true, maxRetries: 2, initialDelayMs: 1000 }
      },
      SHIPPED
    );
    assert.equal(inst.values.transport, 'stdio');
    assert.equal(inst.values.command, 'npx');
    assert.deepEqual(inst.values.args, ['-y', 'some-server']);
    assert.deepEqual(inst.values.env, ['API_URL=http://x']);
    assert.equal(inst.values.cwd, '/srv');
    assert.equal(inst.values.authKind, 'basic');
    assert.equal(inst.values.username, 'bob');
    assert.equal(inst.auth.credentialRef, 'pw');
    assert.equal(inst.values.timeoutMs, 200000);
    assert.equal(inst.values.appsEnabled, false);
    assert.equal(inst.values.reconnectMaxRetries, 2);
    assert.equal(inst.values.reconnectInitialDelayMs, undefined);
  });

  it('rewrites app tool references to bindings', () => {
    const servers = [{ id: 'drawio' }, { id: 'wix', toolPrefix: 'wx_' }];
    const whole = migrateApp({ id: 'a', tools: ['drawio', 'braveSearch'] }, servers);
    assert.equal(whole.changed, true);
    assert.deepEqual(whole.app.tools, ['braveSearch']);
    assert.deepEqual(whole.app.integrations, { drawio: {} });

    const narrowed = migrateApp(
      { id: 'b', tools: ['wx_sites_list', 'drawio__create_diagram'], integrations: { wix: {} } },
      servers
    );
    assert.deepEqual(narrowed.app.integrations, {
      wix: { actions: ['sites_list'] },
      drawio: { actions: ['create_diagram'] }
    });
    assert.equal(narrowed.app.tools, undefined);

    const untouched = migrateApp({ id: 'c', tools: ['braveSearch'] }, servers);
    assert.equal(untouched.changed, false);
  });

  it('moves the servers, merges security, rewrites apps and removes the file', async () => {
    const ctx = makeCtx({
      'config/mcpServers.json': {
        servers: [
          drawio,
          { id: 'gh', transport: { type: 'streamableHttp', url: 'https://x/mcp' } }
        ],
        security: { blockPrivateIps: false, allowedHosts: ['mcp.internal'] }
      },
      'config/integrations.json': {
        installed: [{ id: 'ifinder', definition: 'com.intrafind/ifinder', values: {} }],
        security: { blockPrivateIps: true, allowedHosts: ['portal.internal'] }
      },
      'apps/diagrams.json': { id: 'diagrams', tools: ['drawio'] },
      'apps/chat.json': { id: 'chat', tools: ['braveSearch'] }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx, { shippedDefinitions: SHIPPED });
    const integrations = ctx.files['config/integrations.json'];
    assert.deepEqual(
      integrations.installed.map(i => i.id),
      ['ifinder', 'drawio', 'gh']
    );
    assert.equal(integrations.installed[1].definition, 'mcp/drawio');
    assert.equal(integrations.installed[2].definition, 'com.intrafind/mcp-server');
    assert.ok(integrations.installed[1].installedAt);
    assert.deepEqual(integrations.security, {
      blockPrivateIps: false,
      allowedHosts: ['portal.internal', 'mcp.internal']
    });
    assert.deepEqual(ctx.files['apps/diagrams.json'].integrations, { drawio: {} });
    assert.equal(ctx.files['apps/diagrams.json'].tools, undefined);
    assert.deepEqual(ctx.files['apps/chat.json'], { id: 'chat', tools: ['braveSearch'] });
    assert.equal('config/mcpServers.json' in ctx.files, false);
  });

  it('is idempotent and leaves existing installations alone', async () => {
    const ctx = makeCtx({
      'config/mcpServers.json': { servers: [drawio] },
      'config/integrations.json': {
        installed: [{ id: 'drawio', definition: 'mcp/drawio', values: {}, enabled: true }]
      }
    });
    await up(ctx, { shippedDefinitions: SHIPPED });
    assert.equal(ctx.files['config/integrations.json'].installed.length, 1);
    assert.equal(ctx.files['config/integrations.json'].installed[0].enabled, true);
    assert.equal('config/mcpServers.json' in ctx.files, false);
  });

  it('still rewrites apps when the server file is already gone', async () => {
    const ctx = makeCtx({
      'config/integrations.json': {
        installed: [{ id: 'drawio', definition: 'mcp/drawio', values: {} }]
      },
      'apps/diagrams.json': { id: 'diagrams', tools: ['drawio'] }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx, { shippedDefinitions: SHIPPED });
    assert.deepEqual(ctx.files['apps/diagrams.json'].integrations, { drawio: {} });
  });

  it('reads the shipped MCP definitions, each with a fixed remote endpoint', () => {
    const shipped = loadShippedMcpDefinitions();
    assert.ok(shipped.length >= 40);
    assert.ok(shipped.find(d => d.id === 'mcp/drawio')?.url === 'https://mcp.draw.io/mcp');
    const generic = shipped.find(d => d.id === 'com.intrafind/mcp-server');
    assert.equal(generic.url, null);
    for (const def of shipped) {
      if (def.id === 'com.intrafind/mcp-server') continue;
      assert.equal(def.transportType, 'streamableHttp', def.id);
      assert.match(def.url, /^https:\/\//, def.id);
    }
  });
});

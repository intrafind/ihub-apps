// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V193: MCP servers move from mcpServers.json into the installed
 * integrations; apps bind them instead of listing the server.
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
  instanceFrom,
  shippedMatchFor,
  migrateApp,
  authModeOf,
  loadShippedMcpDefinitions
} from '../migrations/V193__mcp_servers_installed_integrations.js';
import { effectiveValues } from '../services/integrations/definitions/installedValues.js';
import { serverConfigFor } from '../services/integrations/protocols/mcp/serverConfig.js';
import { validateIntegrationDefinition } from '../validators/integrationDefinitionSchema.js';
import { mcpServerConfigSchema } from '../validators/mcpServerConfigSchema.js';
import { registrationFingerprint } from '../services/mcp/mcpOAuthClientStore.js';

/** The shipped generic MCP definition, validated like the registry loads it. */
function genericDefinition() {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'defaults',
    'integration-definitions',
    'com.intrafind__mcp-server',
    'integration.json'
  );
  const result = validateIntegrationDefinition(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(result.success, true, JSON.stringify(result.errors));
  return result.data;
}

/** What the manager read from `mcpServers.json` → what it reads from the installation. */
function migratedServerConfig(server, shipped = SHIPPED) {
  const definition = genericDefinition();
  const instance = instanceFrom(server, shipped);
  assert.equal(instance.definition, 'com.intrafind/mcp-server');
  const projected = serverConfigFor({
    definition,
    instance,
    values: effectiveValues(definition, instance)
  });
  assert.equal(projected.ok, true, JSON.stringify(projected.issues));
  return { before: mcpServerConfigSchema.parse(server), after: projected.config };
}

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

  it('installs the generic definition when the server has a custom tool prefix, keeping the prefix', () => {
    const reasons = [];
    const inst = instanceFrom({ ...drawio, id: 'diagrams', toolPrefix: 'dia_' }, SHIPPED, {
      onFallback: reason => reasons.push(reason)
    });
    // Only the generic definition declares `toolPrefix`; installed as
    // `mcp/drawio` the prefix would be dropped on the first edit and the tool
    // ids would change from `dia_create_diagram` to `diagrams__create_diagram`.
    assert.equal(inst.definition, 'com.intrafind/mcp-server');
    assert.equal(inst.values.toolPrefix, 'dia_');
    assert.equal(inst.values.url, 'https://mcp.draw.io/mcp');
    assert.equal(inst.values.transport, 'streamableHttp');
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /toolPrefix "dia_"/);
    assert.match(reasons[0], /mcp\/drawio/);
  });

  it('matches a shipped definition when the prefix is empty or the default <id>__', () => {
    for (const toolPrefix of [undefined, '', '  ', 'drawio__']) {
      const reasons = [];
      const inst = instanceFrom({ ...drawio, toolPrefix }, SHIPPED, {
        onFallback: reason => reasons.push(reason)
      });
      assert.equal(inst.definition, 'mcp/drawio', String(toolPrefix));
      assert.equal(inst.values.toolPrefix, undefined, String(toolPrefix));
      assert.deepEqual(reasons, []);
    }
    const { match, fallbackReason } = shippedMatchFor(
      { ...drawio, auth: { type: 'bearer', tokenRef: 't' } },
      SHIPPED
    );
    assert.equal(match, null);
    assert.match(fallbackReason, /sign-in mode "service-account"/);
    // An endpoint no shipped definition has is the plain generic case: no fallback to report.
    assert.deepEqual(
      shippedMatchFor(
        { id: 'x', transport: { type: 'streamableHttp', url: 'https://x/mcp' } },
        SHIPPED
      ),
      { match: null, fallbackReason: null }
    );
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

  it('logs which servers fell back to the generic definition and why', async () => {
    const ctx = makeCtx({
      'config/mcpServers.json': {
        servers: [drawio, { ...drawio, id: 'dia', toolPrefix: 'dia_' }]
      }
    });
    await up(ctx, { shippedDefinitions: SHIPPED });
    const installed = ctx.files['config/integrations.json'].installed;
    assert.equal(installed.find(i => i.id === 'drawio').definition, 'mcp/drawio');
    assert.equal(installed.find(i => i.id === 'dia').definition, 'com.intrafind/mcp-server');
    const fallback = ctx.logs.filter(line => line.includes('installs the generic definition'));
    assert.equal(fallback.length, 1);
    assert.match(fallback[0], /"dia".*custom toolPrefix "dia_"/);
  });

  it('yields the server config it replaced, trailing slashes of the URLs included', () => {
    // The MCP endpoint and the OAuth issuer are used verbatim; per-user tokens
    // and iHub's client registrations are bound to a fingerprint of them, so a
    // stripped slash would disconnect every user after the upgrade.
    const { before, after } = migratedServerConfig({
      id: 'acme',
      name: 'Acme MCP',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.acme.example/mcp/',
        headers: { 'X-Tenant': 'acme' }
      },
      auth: {
        type: 'oauthUser',
        scopes: ['openid', 'mcp'],
        clientId: 'ihub',
        authorizationServer: 'https://login.acme.example/realms/acme/'
      }
    });
    assert.equal(after.transport.url, 'https://mcp.acme.example/mcp/');
    assert.equal(after.auth.authorizationServer, 'https://login.acme.example/realms/acme/');
    assert.deepEqual(after.transport, before.transport);
    assert.deepEqual(after.auth, before.auth);
    assert.equal(registrationFingerprint(after), registrationFingerprint(before));

    const client = migratedServerConfig({
      id: 'cc',
      name: 'Acme client credentials',
      transport: { type: 'sse', url: 'https://mcp.acme.example/sse/' },
      auth: {
        type: 'oauth',
        tokenUrl: 'https://login.acme.example/oauth/token/',
        clientId: 'svc',
        clientSecretRef: 'cc-secret'
      }
    });
    assert.equal(client.after.transport.url, 'https://mcp.acme.example/sse/');
    assert.equal(client.after.auth.tokenUrl, 'https://login.acme.example/oauth/token/');
    assert.deepEqual(client.after.auth, client.before.auth);
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

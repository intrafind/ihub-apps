// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V193 — MCP servers become installed integrations
 *
 * Every server of `config/mcpServers.json` becomes an installation in
 * `config/integrations.json`, under the same id, so its tool ids
 * (`<id>__<tool>`), group grants, per-user tokens and OAuth client
 * registrations (bound to transport, URL and auth block) stay valid:
 *
 * - a server whose endpoint is one of the shipped MCP definitions (the former
 *   built-in catalog, draw.io, Excalidraw) installs that definition;
 * - any other server installs the generic `com.intrafind/mcp-server`
 *   definition with the transport, auth and tuning settings as install values;
 * - `auth` maps to the sign-in mode: bearer, basic and header → service
 *   account (credential reference kept), oauth → OAuth client, oauthUser →
 *   per-user OAuth; `allowedTools` → `actions.enabled`;
 * - `security` (private IPs, allowed hosts) merges into the integrations file.
 *
 * Apps bind the installations instead of listing the server (`tools:
 * ["drawio"]` → `integrations.drawio`), and a tool reference by prefixed id
 * (`drawio__create_diagram`) becomes a binding narrowed to that action.
 *
 * `config/mcpServers.json` is removed; nothing reads it any more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const version = '193';
export const description = 'mcp_servers_installed_integrations';

const MCP_FILE = 'config/mcpServers.json';
const INTEGRATIONS_FILE = 'config/integrations.json';
const GENERIC_DEFINITION = 'com.intrafind/mcp-server';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_INSTANCE_TIMEOUT_MS = 120000;
const DEFAULT_RECONNECT = {
  enabled: true,
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  growthFactor: 1.5
};

export async function precondition(ctx) {
  if (await ctx.fileExists(MCP_FILE)) return true;
  const apps = await ctx.listFiles('apps', '*.json');
  return apps.length > 0;
}

/**
 * The shipped MCP definitions with a fixed endpoint, read from
 * `server/defaults/integration-definitions`.
 * @returns {Array<{ id: string, url: string|null, transportType: string|null, authModes: string[] }>}
 */
export function loadShippedMcpDefinitions() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'defaults',
    'integration-definitions'
  );
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    try {
      const def = JSON.parse(fs.readFileSync(path.join(root, dir, 'integration.json'), 'utf8'));
      if (def?.protocol?.type !== 'mcp') continue;
      out.push({
        id: def.id,
        url: def.protocol.transport?.url || null,
        transportType: def.protocol.transport?.type || null,
        authModes: def.auth?.modes || []
      });
    } catch {
      // Not a definition folder.
    }
  }
  return out;
}

function nonEmpty(value) {
  return value !== undefined && value !== null && value !== '';
}

function put(values, key, value) {
  if (nonEmpty(value)) values[key] = value;
}

function toLines(record, separator) {
  return Object.entries(record || {}).map(([key, value]) => `${key}${separator}${value}`);
}

function localizedOf(value) {
  if (!nonEmpty(value)) return undefined;
  return typeof value === 'string' ? { en: value } : value;
}

function normalizeUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '').toLowerCase() : '';
}

/** The sign-in mode of an `mcpServers.json` auth block. */
export function authModeOf(auth) {
  switch (auth?.type) {
    case 'bearer':
    case 'basic':
    case 'header':
      return 'service-account';
    case 'oauth':
      return 'oauth-client';
    case 'oauthUser':
      return 'oauth-user';
    default:
      return 'none';
  }
}

function credentialRefOf(auth) {
  return (
    auth?.tokenRef || auth?.passwordRef || auth?.valueRef || auth?.clientSecretRef || undefined
  );
}

/** The installation an `mcpServers.json` server becomes. */
export function instanceFrom(server, shipped = []) {
  const transport = server.transport || {};
  const auth = server.auth || { type: 'none' };
  const mode = authModeOf(auth);
  const url = normalizeUrl(transport.url);
  const match =
    url &&
    shipped.find(
      def =>
        def.url &&
        normalizeUrl(def.url) === url &&
        (!def.transportType || def.transportType === transport.type) &&
        def.authModes.includes(mode)
    );
  const generic = !match;
  const values = {};

  if (generic) {
    put(values, 'transport', transport.type);
    if (transport.type === 'stdio') {
      put(values, 'command', transport.command);
      if (Array.isArray(transport.args) && transport.args.length) values.args = transport.args;
      const env = toLines(transport.env, '=');
      if (env.length) values.env = env;
      put(values, 'cwd', transport.cwd);
    } else {
      put(values, 'url', transport.url);
    }
  }
  const headers = toLines(transport.headers, ': ');
  if (headers.length && transport.type !== 'stdio') values.headers = headers;

  if (mode === 'service-account' && generic) {
    const kind = auth.type;
    put(values, 'authKind', kind);
    if (kind === 'basic') put(values, 'username', auth.username);
    if (kind === 'header') {
      put(values, 'headerName', auth.headerName);
      put(values, 'valuePrefix', auth.valuePrefix);
    }
  } else if (mode === 'service-account' && auth.type === 'basic') {
    put(values, 'username', auth.username);
  }
  if (mode === 'oauth-client') {
    put(values, 'oauthTokenUrl', auth.tokenUrl);
    put(values, 'oauthClientId', auth.clientId);
    put(values, 'oauthScope', auth.scope);
  }
  if (mode === 'oauth-user') {
    if (Array.isArray(auth.scopes) && auth.scopes.length) values.oauthScopes = auth.scopes;
    put(values, 'oauthClientId', auth.clientId);
    put(values, 'oauthAuthorizationServer', auth.authorizationServer);
  }

  const prefix = typeof server.toolPrefix === 'string' ? server.toolPrefix.trim() : '';
  put(values, 'toolPrefix', prefix || undefined);

  const instance = {
    id: server.id,
    definition: match ? match.id : GENERIC_DEFINITION,
    enabled: server.enabled !== false,
    values,
    auth: { mode },
    actions: {
      enabled:
        Array.isArray(server.allowedTools) && !server.allowedTools.includes('*')
          ? server.allowedTools
          : ['*'],
      disabled: [],
      overrides: {}
    },
    allowedGroups: []
  };
  const label = localizedOf(server.name);
  if (label) instance.label = label;
  const desc = localizedOf(server.description);
  if (desc) instance.description = desc;
  const credentialRef = credentialRefOf(auth);
  if (mode !== 'none' && credentialRef) instance.auth.credentialRef = credentialRef;

  const timeout = Number(server.timeoutMs);
  if (Number.isFinite(timeout) && timeout !== DEFAULT_TIMEOUT_MS) {
    if (generic) values.timeoutMs = timeout;
    else instance.timeoutMs = Math.min(timeout, MAX_INSTANCE_TIMEOUT_MS);
  }
  if (generic) {
    if (server.apps?.enabled === false) values.appsEnabled = false;
    const reconnect = server.reconnect || {};
    const keys = {
      enabled: 'reconnectEnabled',
      maxRetries: 'reconnectMaxRetries',
      initialDelayMs: 'reconnectInitialDelayMs',
      maxDelayMs: 'reconnectMaxDelayMs',
      growthFactor: 'reconnectGrowthFactor'
    };
    for (const [key, valueKey] of Object.entries(keys)) {
      if (reconnect[key] !== undefined && reconnect[key] !== DEFAULT_RECONNECT[key]) {
        values[valueKey] = reconnect[key];
      }
    }
  }
  return instance;
}

/**
 * Rewrite an app's tool references to bindings. Returns the app and whether
 * it changed.
 * @param {object} app
 * @param {Array<{ id: string, toolPrefix?: string }>} servers
 */
export function migrateApp(app, servers) {
  if (!Array.isArray(app?.tools) || app.tools.length === 0) return { app, changed: false };
  const byId = new Map(servers.map(server => [server.id, server]));
  const prefixes = servers.map(server => ({
    server,
    prefix: (typeof server.toolPrefix === 'string' && server.toolPrefix.trim()) || `${server.id}__`
  }));
  const bindings = { ...(app.integrations || {}) };
  const actionsFor = new Map();
  const kept = [];
  let changed = false;
  for (const ref of app.tools) {
    if (typeof ref !== 'string') {
      kept.push(ref);
      continue;
    }
    if (byId.has(ref)) {
      bindings[ref] = { ...(bindings[ref] || {}) };
      delete bindings[ref].actions;
      actionsFor.set(ref, null);
      changed = true;
      continue;
    }
    const match = prefixes.find(
      ({ prefix }) => ref.startsWith(prefix) && ref.length > prefix.length
    );
    if (match) {
      const id = match.server.id;
      if (!actionsFor.has(id)) actionsFor.set(id, []);
      const list = actionsFor.get(id);
      if (list) list.push(ref.slice(match.prefix.length));
      bindings[id] = { ...(bindings[id] || {}) };
      changed = true;
      continue;
    }
    kept.push(ref);
  }
  if (!changed) return { app, changed: false };
  for (const [id, actions] of actionsFor) {
    if (actions === null) delete bindings[id].actions;
    else bindings[id].actions = [...new Set([...(bindings[id].actions || []), ...actions])];
  }
  const next = { ...app, tools: kept, integrations: bindings };
  if (next.tools.length === 0) delete next.tools;
  return { app: next, changed: true };
}

export async function up(ctx, { shippedDefinitions } = {}) {
  const shipped = shippedDefinitions || loadShippedMcpDefinitions();
  const hadFile = await ctx.fileExists(MCP_FILE);
  const mcp = hadFile ? (await ctx.readJson(MCP_FILE)) || {} : {};
  const servers = Array.isArray(mcp.servers) ? mcp.servers.filter(s => s && s.id) : [];

  const integrations = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(integrations.installed)) integrations.installed = [];
  if (!integrations.security) {
    integrations.security = { blockPrivateIps: true, allowedHosts: [] };
  }

  let migrated = 0;
  for (const server of servers) {
    if (integrations.installed.some(inst => inst.id === server.id)) {
      ctx.log(`MCP server "${server.id}" is already an installed integration; left as is`);
      continue;
    }
    const instance = instanceFrom(server, shipped);
    const now = new Date().toISOString();
    instance.installedAt = now;
    instance.updatedAt = now;
    integrations.installed.push(instance);
    migrated += 1;
    ctx.log(`MCP server "${server.id}" → installed integration (${instance.definition})`);
  }

  if (mcp.security) {
    integrations.security.blockPrivateIps =
      integrations.security.blockPrivateIps !== false && mcp.security.blockPrivateIps !== false;
    integrations.security.allowedHosts = [
      ...new Set([
        ...(integrations.security.allowedHosts || []),
        ...(mcp.security.allowedHosts || [])
      ])
    ];
  }

  if (hadFile || migrated > 0) await ctx.writeJson(INTEGRATIONS_FILE, integrations);

  // Apps reference the installations by binding, not by tool reference.
  const refs = servers.map(server => ({ id: server.id, toolPrefix: server.toolPrefix }));
  // Installations that already existed (a re-run, or a hand-made install) count too.
  for (const inst of integrations.installed) {
    if (!refs.some(ref => ref.id === inst.id)) {
      refs.push({ id: inst.id, toolPrefix: inst.values?.toolPrefix });
    }
  }
  if (refs.length) {
    for (const file of await ctx.listFiles('apps', '*.json')) {
      const rel = `apps/${file}`;
      const app = await ctx.readJson(rel);
      if (!app) continue;
      const { app: next, changed } = migrateApp(app, refs);
      if (changed) {
        await ctx.writeJson(rel, next);
        ctx.log(`${rel}: MCP server references → integrations binding`);
      }
    }
  }

  if (hadFile) {
    await ctx.deleteFile(MCP_FILE);
    ctx.log(`${MCP_FILE} removed: MCP servers are installed integrations now`);
  }
}

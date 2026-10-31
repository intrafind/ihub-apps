// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An installed MCP integration as the `McpClientManager` reads it: the server
 * config `mcpServers.json` used to hold. The definition fixes what it knows
 * (a catalog entry fixes the endpoint); the install values supply the rest
 * under conventional keys, which the shipped "MCP server" definition declares
 * as fields:
 *
 *   transport, url, headers ("Name: value" per line), command, args, env
 *   ("KEY=value" per line), cwd, toolPrefix, timeoutMs, appsEnabled,
 *   reconnectEnabled, reconnectMaxRetries, reconnectInitialDelayMs,
 *   reconnectMaxDelayMs, reconnectGrowthFactor;
 *   authKind (bearer | basic | header), username, headerName, valuePrefix;
 *   oauthTokenUrl, oauthClientId, oauthScope (client credentials);
 *   oauthScopes, oauthClientId, oauthAuthorizationServer (per-user OAuth).
 *
 * The shape matters beyond the connection: per-user tokens and iHub's OAuth
 * client registrations are bound to a fingerprint of transport type, URL and
 * the auth block, so a migrated installation yields exactly the server config
 * it replaced.
 */
import { mcpServerConfigSchema } from '../../../../validators/mcpServerConfigSchema.js';
import { fillTemplate } from '../../definitions/valuePaths.js';

/** `["Name: value", …]` → `{ Name: value }`; malformed lines are skipped. */
export function parseHeaderLines(lines) {
  const out = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const idx = String(line).indexOf(':');
    if (idx <= 0) continue;
    const name = String(line).slice(0, idx).trim();
    const value = String(line)
      .slice(idx + 1)
      .trim();
    if (name) out[name] = value;
  }
  return out;
}

/** `["KEY=value", …]` → `{ KEY: value }`. */
export function parseEnvLines(lines) {
  const out = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const idx = String(line).indexOf('=');
    if (idx <= 0) continue;
    const key = String(line).slice(0, idx).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = String(line).slice(idx + 1);
  }
  return out;
}

/** The inverse of {@link parseHeaderLines} / {@link parseEnvLines}, for migrations and editors. */
export function toLines(record, separator) {
  return Object.entries(record || {}).map(([key, value]) => `${key}${separator}${value}`);
}

function templated(record, values) {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    out[fillTemplate(key, values)] = fillTemplate(value, values);
  }
  return out;
}

function defined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== '')
  );
}

function transportFor(protocol, values) {
  const fixed = protocol.transport || {};
  const type = fixed.type || values.transport || 'streamableHttp';
  if (type === 'stdio') {
    return defined({
      type,
      command: fixed.command ? fillTemplate(fixed.command, values) : values.command,
      args: fixed.args ? fixed.args.map(arg => fillTemplate(arg, values)) : values.args || [],
      env: { ...templated(fixed.env, values), ...parseEnvLines(values.env) },
      cwd: fixed.cwd ? fillTemplate(fixed.cwd, values) : values.cwd
    });
  }
  const url = fixed.url ? fillTemplate(fixed.url, values) : values.url;
  if (type === 'websocket') return defined({ type, url });
  const headers = { ...templated(fixed.headers, values), ...parseHeaderLines(values.headers) };
  return defined({ type, url, headers: Object.keys(headers).length ? headers : undefined });
}

function authFor(definition, instance, values) {
  const mode = instance.auth?.mode || 'none';
  const credentialRef = instance.auth?.credentialRef;
  if (mode === 'service-account') {
    const account = definition.auth.serviceAccount || {};
    const kind = values.authKind || account.kind || 'bearer';
    if (kind === 'basic') {
      return { type: 'basic', username: values.username, passwordRef: credentialRef };
    }
    if (kind === 'header') {
      return defined({
        type: 'header',
        headerName: values.headerName || fillTemplate(account.header, values),
        valuePrefix: values.valuePrefix ?? account.valuePrefix,
        valueRef: credentialRef
      });
    }
    return { type: 'bearer', tokenRef: credentialRef };
  }
  if (mode === 'oauth-client') {
    return defined({
      type: 'oauth',
      tokenUrl: values.oauthTokenUrl,
      clientId: values.oauthClientId,
      clientSecretRef: credentialRef,
      scope: values.oauthScope
    });
  }
  if (mode === 'oauth-user') {
    const scopes = Array.isArray(values.oauthScopes) ? values.oauthScopes : undefined;
    return defined({
      type: 'oauthUser',
      scopes: scopes && scopes.length ? scopes : undefined,
      clientId: values.oauthClientId,
      clientSecretRef: credentialRef,
      authorizationServer: values.oauthAuthorizationServer
    });
  }
  return { type: 'none' };
}

function reconnectFor(protocol, values) {
  const fixed = protocol.reconnect || {};
  const out = defined({
    enabled: fixed.enabled ?? values.reconnectEnabled,
    maxRetries: fixed.maxRetries ?? values.reconnectMaxRetries,
    initialDelayMs: fixed.initialDelayMs ?? values.reconnectInitialDelayMs,
    maxDelayMs: fixed.maxDelayMs ?? values.reconnectMaxDelayMs,
    growthFactor: fixed.growthFactor ?? values.reconnectGrowthFactor
  });
  return Object.keys(out).length ? out : undefined;
}

/**
 * The raw (unvalidated) server config of an installation.
 * @param {object} params
 * @param {object} params.definition
 * @param {object} params.instance
 * @param {Record<string, unknown>} params.values - effective install values
 * @returns {object}
 */
export function rawServerConfigFor({ definition, instance, values }) {
  const protocol = definition.protocol;
  const policy = instance.actions || {};
  const enabled = policy.enabled || ['*'];
  return defined({
    id: instance.id,
    name: instance.label || definition.name,
    description: instance.description || definition.description,
    enabled: instance.enabled !== false,
    transport: transportFor(protocol, values),
    auth: authFor(definition, instance, values),
    toolPrefix: protocol.toolPrefix ?? values.toolPrefix,
    allowedTools: enabled.includes('*') ? ['*'] : enabled,
    deniedTools: policy.disabled || [],
    timeoutMs: instance.timeoutMs ?? protocol.timeoutMs ?? values.timeoutMs,
    apps: { enabled: protocol.apps?.enabled ?? values.appsEnabled ?? true },
    reconnect: reconnectFor(protocol, values)
  });
}

/**
 * The validated server config of an installation.
 * @param {object} params - see {@link rawServerConfigFor}
 * @returns {{ ok: true, config: object } | { ok: false, issues: Array }}
 */
export function serverConfigFor(params) {
  const parsed = mcpServerConfigSchema.safeParse(rawServerConfigFor(params));
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  return { ok: true, config: parsed.data };
}

/**
 * The `McpClientManager` config (`{ servers, security }`) of every installed
 * MCP integration. An installation whose config does not validate is left out
 * and reported, never let through half-formed.
 *
 * @param {Array<{ definition: object, instance: object, values: object }>} resolved
 * @param {{ blockPrivateIps: boolean, allowedHosts: string[] }} security
 * @returns {{ servers: object[], security: object, invalid: Array<{ id: string, issues: Array }> }}
 */
export function mcpServersFromInstallations(resolved, security) {
  const servers = [];
  const invalid = [];
  for (const entry of resolved) {
    if (entry.definition?.protocol?.type !== 'mcp') continue;
    const result = serverConfigFor(entry);
    if (result.ok) servers.push(result.config);
    else invalid.push({ id: entry.instance.id, issues: result.issues });
  }
  return {
    servers,
    security: security || { blockPrivateIps: true, allowedHosts: [] },
    invalid
  };
}

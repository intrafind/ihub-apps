// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `mcp` protocol: an installed integration whose actions are the tools an
 * MCP server lists. The adapter is a thin layer over `McpClientManager`, which
 * keeps every connection, the per-user OAuth stack, the MCP Apps views and the
 * shared tool catalog exactly as before; the manager is now fed from the
 * installations (`serverConfig.js`) instead of `mcpServers.json`.
 *
 * The tools keep their ids (`<prefix><tool>`, default `<instanceId>__<tool>`)
 * and their `_mcp` marker, so the chat, the connect card and the gateway read
 * them as before; `_integration` is added so the app binding, the groups of
 * the installation and the action policy apply like to any other integration.
 */
import mcpClientManager from '../../../mcp/McpClientManager.js';
import { isUserOAuthServer, revokeUserConnection } from '../../../mcp/mcpOAuthService.js';
import { listServerConnections } from '../../../mcp/mcpUserTokens.js';
import { actionEnabled, testResult } from '../common.js';
import { effectiveValues, instanceLabel } from '../../definitions/installedValues.js';
import { serverConfigFor } from './serverConfig.js';

/** The actions are not in the definition; they are asked from the server. */
export const dynamicActions = true;

/** Sign-in modes the manager can run. */
export const supportedAuthModes = ['none', 'service-account', 'oauth-client', 'oauth-user'];

/** Side effect from MCP tool annotations (2025-03-26). */
export function sideEffectOf(annotations) {
  if (!annotations || typeof annotations !== 'object') return 'unknown';
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.destructiveHint === true) return 'destructive';
  if (annotations.destructiveHint === false || annotations.readOnlyHint === false) return 'write';
  return 'unknown';
}

function prefixOf(config) {
  return config.toolPrefix?.trim() || `${config.id}__`;
}

function configOf(resolved) {
  const result = serverConfigFor(resolved);
  if (!result.ok) {
    const details = result.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(
      `Integration ${resolved.instance.id}: invalid MCP server settings (${details})`
    );
  }
  return result.config;
}

/**
 * The server's tools as actions, including the ones the installation has
 * switched off (the editor lists them all). Nothing is connected for a
 * per-user server: its shared catalog is read.
 */
export async function discoverActions({ definition, instance, language = 'en' }) {
  const config = configOf({ definition, instance, values: effectiveValues(definition, instance) });
  const prefix = prefixOf(config);
  const raw = await mcpClientManager.rawToolsOfServer(instance.id);
  return raw.map(tool => {
    const enabled = actionEnabled(instance, { name: tool.name, enabledByDefault: true });
    return {
      name: tool.name,
      toolId: `${prefix}${tool.name}`,
      title: tool.title || tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      sideEffect: sideEffectOf(tool.annotations),
      dataFlow: 'external',
      enabledByDefault: true,
      enabled,
      requirementsMet: true,
      needsToken: isUserOAuthServer(config),
      available: enabled,
      guidance: '',
      examples: [],
      language
    };
  });
}

/**
 * The model-facing tools of an installation: the manager's `_mcp` tools with
 * the `_integration` marker added.
 */
export async function discoverTools(resolved, language = 'en') {
  const { instance, definition } = resolved;
  const tools = await mcpClientManager.toolsOfServer(instance.id);
  const label = instanceLabel(definition, instance, language);
  return tools.map(tool => ({
    ...tool,
    type: 'integration',
    _integration: {
      instanceId: instance.id,
      instanceLabel: label,
      action: tool._mcp?.originalName || tool.name,
      definition: definition.id
    }
  }));
}

/** Run one tool on the calling user's behalf; iHub's context keys stay with the manager. */
export async function run({ context }) {
  const toolId = context?.tool?.id;
  if (!toolId) throw new Error('MCP action call without a tool id');
  return mcpClientManager.callTool(toolId, context.params || {}, {
    onRawResult: context.options?.onMcpAppResult
  });
}

/**
 * Probe the installation (saved or a draft): settings valid, connection,
 * `tools/list`. A per-user server the acting admin has not connected answers
 * with the connect link instead of a failure.
 */
export async function test({ definition, instance, user, resolveSecret }) {
  const started = Date.now();
  const steps = [];
  const push = (id, label, status, message, extra = {}) =>
    steps.push({ id, label, status, message, ...extra });

  const projected = serverConfigFor({
    definition,
    instance,
    values: effectiveValues(definition, instance)
  });
  if (!projected.ok) {
    push(
      'settings',
      'Server settings',
      'fail',
      projected.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
    return testResult(steps, started);
  }
  const config = projected.config;
  push('settings', 'Server settings', 'ok', `${config.transport.type}: ${describe(config)}`);

  let probe;
  try {
    probe = await mcpClientManager.testConfig(config, user, { resolveSecret });
  } catch (error) {
    push('connect', 'Connection', 'fail', error.message, {
      details: error.details ? { issues: error.details } : undefined
    });
    return testResult(steps, started);
  }
  if (probe.status === 'auth_required') {
    push(
      'connect',
      'Connection',
      'warn',
      probe.reason === 'unsaved_changes'
        ? 'Save the installation first, then connect your own account to test it.'
        : 'This server signs every user in. Connect your own account to test it and load its tools.',
      { details: { connectUrl: probe.connectUrl } }
    );
    return { ...testResult(steps, started), connectUrl: probe.connectUrl, actions: [] };
  }
  const connected = probe.status?.connected !== false;
  push(
    'connect',
    'Connection',
    connected ? 'ok' : 'fail',
    connected ? 'Connected' : probe.status?.lastError || 'Not connected'
  );
  const catalog = Array.isArray(probe.catalog) ? probe.catalog : probe.tools || [];
  push('tools', 'Tools', catalog.length ? 'ok' : 'warn', `${catalog.length} tools listed`);
  const prefix = prefixOf(config);
  return {
    ...testResult(steps, started, {
      actionCount: catalog.length,
      successMessage: `Connected, ${catalog.length} tools listed`
    }),
    actions: catalog.map(tool => ({
      name: tool.originalName || tool.name,
      toolId: `${prefix}${tool.originalName || tool.name}`,
      title: tool.originalName || tool.name,
      description: tool.description || '',
      sideEffect: 'unknown',
      enabledByDefault: true,
      enabled: tool.allowed !== false,
      available: tool.allowed !== false
    }))
  };
}

function describe(config) {
  if (config.transport.type === 'stdio') {
    return [config.transport.command, ...(config.transport.args || [])].join(' ');
  }
  return config.transport.url;
}

/** Connection health of an installation, for the admin list. */
export function status(instance) {
  const entry = mcpClientManager.status().find(s => s.id === instance.id);
  if (!entry) return null;
  return {
    connected: entry.connected,
    unhealthy: entry.unhealthy,
    lastError: entry.lastError || null,
    toolCount: entry.toolCount,
    userConnections: entry.userConnections,
    perUser: entry.authType === 'oauthUser'
  };
}

/** The users who connected their own account to a per-user server. */
export async function listConnections(instance) {
  const conn = mcpClientManager.getConnection(instance.id);
  if (!conn || !isUserOAuthServer(conn.config)) return [];
  const connections = await listServerConnections(instance.id, conn.config);
  return connections.map(({ storageId: _storageId, ...c }) => c);
}

/** Disconnect one user: revoke at the authorization server when possible, delete the tokens. */
export async function disconnectUser(instance, userId) {
  const conn = mcpClientManager.getConnection(instance.id);
  if (!conn || !isUserOAuthServer(conn.config)) return { removed: false, unknownServer: true };
  const result = await revokeUserConnection({
    serverConfig: conn.config,
    userId,
    security: mcpClientManager.security,
    clientStore: mcpClientManager.clientRegistrations()
  });
  await mcpClientManager.evictUserConnection(instance.id, userId);
  return result;
}

/** Forget iHub's OAuth client registration at the server's authorization server. */
export async function resetRegistration(instance) {
  const conn = mcpClientManager.getConnection(instance.id);
  if (!conn || !isUserOAuthServer(conn.config)) return false;
  await mcpClientManager.resetClientRegistration(instance.id);
  return true;
}

/** The manager is re-initialized from the installations by the reload hook; nothing is cached here. */
export function invalidate() {}

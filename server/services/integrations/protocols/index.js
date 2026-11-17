// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Adapter contract (04-architecture §2): one module per `protocol.type` that
 * turns a definition plus an installation into model-callable actions.
 *
 * Every adapter exports:
 *
 *   discoverActions({ definition, instance, document, language })
 *     → Promise<Array<{ name, title, description, parameters, sideEffect,
 *                        dataFlow, enabledByDefault, available, operationId? }>>
 *   run({ definition, instance, document, action, args, context })
 *     → Promise<unknown> the result the model sees (sources already attached
 *       where the definition declares them)
 *   test({ definition, instance, document, language })
 *     → Promise<{ success, message, summary, steps[] }>
 *   listScopes({ definition, instance, document, language })
 *     → Promise<Array<{ id, name, isDefault? }>> when the definition declares scopes
 *
 * Optional exports: `dynamicActions` (the actions come from the system, not
 * the definition), `supportedAuthModes`, `discoverTools(resolved, language)`
 * (ready-made tool objects instead of `discoverActions` → `toolFromAction`),
 * `status(instance)`, `listConnections` / `disconnectUser` /
 * `resetRegistration` (per-user sign-in), `invalidate(instanceId)` (drop
 * what is cached for one installation), `onChanged({ definitionIds? })`
 * (definitions were reloaded: re-derive whatever the adapter keeps from them,
 * see {@link notifyDefinitionsChanged}).
 *
 * `openapi`, `native`, `script`, `mcp`, `a2a` and `http` have adapters; the
 * other protocol types validate but cannot be installed.
 */

import * as openapi from './openapi/OpenApiAdapter.js';
import * as native from './native/NativeAdapter.js';
import * as mcp from './mcp/McpAdapter.js';
import * as a2a from './a2a/A2aAdapter.js';
import * as http from './http/HttpAdapter.js';
import logger from '../../../utils/logger.js';

// `script` is the native adapter with the connector loaded from the folder.
const adapters = { openapi, native, mcp, a2a, http, script: native };

/**
 * Tell every adapter that definitions changed: a definition was (re-)installed
 * from a registry on this worker (`ContentInstaller`), or another worker
 * announced one and the registry was reloaded (`server.js`). The reload hook
 * for `integrations.json` does not cover this: a definition update changes no
 * installation. A failing adapter is logged; the others are still told.
 *
 * @param {{ definitionIds?: string[] }} [context] - the changed definitions, when known
 */
export async function notifyDefinitionsChanged(context = {}) {
  const told = new Set();
  for (const [type, adapter] of Object.entries(adapters)) {
    // `native` and `script` are one module: told once.
    if (typeof adapter.onChanged !== 'function' || told.has(adapter)) continue;
    told.add(adapter);
    try {
      await adapter.onChanged(context);
    } catch (error) {
      logger.warn('Protocol adapter could not follow a definition change', {
        component: 'IntegrationProtocols',
        protocol: type,
        error: error.message
      });
    }
  }
}

/**
 * @param {string} protocolType
 * @returns {object|null}
 */
export function getProtocolAdapter(protocolType) {
  return adapters[protocolType] || null;
}

/** Sign-in modes the OpenAPI and other adapters without a list can run themselves. */
const DEFAULT_SUPPORTED_AUTH_MODES = ['none', 'service-account'];

/**
 * The sign-in modes an installation of `definition` can use in this release,
 * as the install form offers them:
 *
 * - the adapter's `supportedAuthModes`, when it lists them (MCP, A2A, HTTP);
 * - every mode the definition declares for a `native` or `script` connector,
 *   which runs its own sign-in (Jira and the storage providers sign each user
 *   in with OAuth) — the install check accepts all of them too;
 * - otherwise `none` and `service-account`, the modes the OpenAPI runner applies.
 *
 * @param {Object} definition - A validated integration definition
 * @returns {string[]}
 */
export function supportedAuthModesOf(definition) {
  const adapter = getProtocolAdapter(definition?.protocol?.type);
  if (Array.isArray(adapter?.supportedAuthModes)) return adapter.supportedAuthModes;
  if (adapter && adapter === native) return [...(definition.auth?.modes || [])];
  return DEFAULT_SUPPORTED_AUTH_MODES;
}

/** Protocol types an adapter exists for. */
export function supportedProtocols() {
  return Object.keys(adapters);
}

export default { getProtocolAdapter, supportedProtocols, notifyDefinitionsChanged };

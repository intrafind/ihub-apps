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
 * `resetRegistration` (per-user sign-in), `invalidate(instanceId)`.
 *
 * `openapi`, `native` and `mcp` have adapters; the other protocol types
 * validate but cannot be installed.
 */

import * as openapi from './openapi/OpenApiAdapter.js';
import * as native from './native/NativeAdapter.js';
import * as mcp from './mcp/McpAdapter.js';

const adapters = { openapi, native, mcp };

/**
 * @param {string} protocolType
 * @returns {object|null}
 */
export function getProtocolAdapter(protocolType) {
  return adapters[protocolType] || null;
}

/** Protocol types an adapter exists for. */
export function supportedProtocols() {
  return Object.keys(adapters);
}

export default { getProtocolAdapter, supportedProtocols };

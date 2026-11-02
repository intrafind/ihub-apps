// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a marketplace registry may deliver as an integration, and the facts
 * the marketplace shows about one.
 *
 * Both work on the raw `integration.json` a registry serves (before or
 * without full validation), so the catalog can screen its integration items
 * when it is loaded and the browse grid can show the facts without
 * installing anything. The install path validates the definition fully and
 * applies {@link registryProtocolRefusal} again (`IntegrationRegistry`).
 *
 * @module services/integrations/definitions/registryItems
 */

import { SIDE_EFFECTS } from '../../../validators/integrationDefinitionSchema.js';

/** Where an integration runs, as a definition may declare it (`runs`). */
const RUNS_VALUES = new Set(['cloud', 'on-prem', 'local']);

/** Protocols whose actions the system lists at runtime (MCP `tools/list`, A2A skills). */
const DYNAMIC_ACTION_PROTOCOLS = new Set(['mcp', 'a2a']);

/** Upper bound of the actions kept in a catalog item's facts. */
const MAX_FACT_ACTIONS = 200;

/** The reason a registry's MCP definition without a fixed remote transport is refused. */
export const REGISTRY_STDIO_REFUSAL =
  'An MCP integration from a registry needs a fixed remote transport (stdio is not allowed)';

/**
 * Whether a registry may deliver this definition. A registry may only
 * publish MCP servers with a fixed remote transport: a local process
 * (`stdio`, or a transport left to the install form, which could be stdio)
 * is the admin's own decision, taken in the generic "MCP server" definition
 * that ships with iHub. Every other protocol passes here (`script` is gated
 * by the registry's trust for code, at install).
 *
 * @param {object} definition - The definition (raw or validated)
 * @returns {string|null} Why the definition is refused, or null when it may be offered
 *
 * @example
 * registryProtocolRefusal({ protocol: { type: 'mcp', transport: { type: 'stdio' } } });
 * // → 'An MCP integration from a registry needs a fixed remote transport (stdio is not allowed)'
 */
export function registryProtocolRefusal(definition) {
  const protocol = definition?.protocol;
  if (protocol?.type !== 'mcp') return null;
  const transport = protocol.transport?.type;
  if (!transport || transport === 'stdio') return REGISTRY_STDIO_REFUSAL;
  return null;
}

/**
 * The overall effect of a definition's actions: `read` when every action
 * only reads, `read-write` as soon as one writes or deletes, `unknown` when
 * there are no declared actions or one of them does not say (and none
 * writes).
 *
 * @param {Array<{ sideEffect: string }>} actions - Normalised actions
 * @returns {'read'|'read-write'|'unknown'}
 */
function overallEffect(actions) {
  if (actions.some(a => a.sideEffect === 'write' || a.sideEffect === 'destructive')) {
    return 'read-write';
  }
  if (actions.length > 0 && actions.every(a => a.sideEffect === 'read')) return 'read';
  return 'unknown';
}

/**
 * The four fixed facts the marketplace shows for an integration item, plus
 * its declared actions for the detail view. Derived from the raw
 * definition; anything malformed is left out rather than failing.
 *
 * - `authModes`: the sign-in modes the definition offers (`auth.modes`)
 * - `effect`: `read`, `read-write` or `unknown` (from the actions' `sideEffect`)
 * - `runs`: `cloud`, `on-prem`, `local`, or null when the definition does not say
 * - `actionCount`: the number of declared actions; null when the system
 *   lists its own actions at runtime (MCP, A2A)
 * - `actions`: `{ name, title, sideEffect }` per declared action
 * - `protocol`: the protocol type
 *
 * @param {object} definition - The raw `integration.json`
 * @returns {{ protocol: string|null, authModes: string[], effect: string, runs: string|null,
 *   actionCount: number|null, actions: Array<{ name: string, title: (object|string|null), sideEffect: string }> }}
 *
 * @example
 * definitionFacts({ protocol: { type: 'openapi' }, auth: { modes: ['none'] },
 *   actions: [{ name: 'search', sideEffect: 'read' }] });
 * // → { protocol: 'openapi', authModes: ['none'], effect: 'read', runs: null,
 * //     actionCount: 1, actions: [{ name: 'search', title: null, sideEffect: 'read' }] }
 */
export function definitionFacts(definition) {
  const protocol = typeof definition?.protocol?.type === 'string' ? definition.protocol.type : null;
  const modes = definition?.auth?.modes;
  const authModes = Array.isArray(modes) ? modes.filter(m => typeof m === 'string') : [];
  const runs = RUNS_VALUES.has(definition?.runs) ? definition.runs : null;
  const rawActions = Array.isArray(definition?.actions) ? definition.actions : [];
  const actions = rawActions
    .filter(a => a && typeof a === 'object' && typeof a.name === 'string')
    .slice(0, MAX_FACT_ACTIONS)
    .map(a => ({
      name: a.name,
      title:
        typeof a.title === 'string' || (a.title && typeof a.title === 'object') ? a.title : null,
      sideEffect: SIDE_EFFECTS.includes(a.sideEffect) ? a.sideEffect : 'unknown'
    }));
  const dynamic = DYNAMIC_ACTION_PROTOCOLS.has(protocol) && actions.length === 0;
  return {
    protocol,
    authModes,
    effect: overallEffect(actions),
    runs,
    actionCount: dynamic ? null : actions.length,
    actions
  };
}

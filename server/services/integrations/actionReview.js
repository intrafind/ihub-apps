// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * New and changed actions of installed integrations (intrafind/ihub-apps#2916).
 *
 * Discovery results pass through here: the tool loader
 * (`integrationTools.discoverIntegrationTools`, on every request that loads
 * tools) and the admin routes (installation page, approval save, "Mark
 * reviewed"). Each one fingerprints the actions it saw
 * (`utils/actionFingerprint.js`) and hands them to
 * {@link observeActionFingerprints}, which compares them with the
 * fingerprints an admin accepted (`actions.fingerprints` on the installation).
 *
 * ## When `integrations.json` is written
 *
 * Discovery runs on every chat request, so it must not write the file:
 *
 * - **Baseline, once.** An installation with a tool approval setting
 *   (`approval`) but no accepted fingerprints yet gets the current ones as
 *   its baseline — written once, and only from a complete action list (the
 *   admin views, and adapters that list every action; not the MCP/A2A tool
 *   lists of a chat request, which hold only the actions switched on).
 *   Installations without an approval setting get no baseline and no write:
 *   approval is opt-in, and so is this.
 * - **Never on an unchanged or changed discovery.** A difference is not
 *   stored; it is derived on every resolution and reported once per worker
 *   (log warning) per installation, action and fingerprint.
 * - **On an admin review** ("Mark reviewed" for one action or all): the
 *   current fingerprints replace the accepted ones (`markActionsReviewed`).
 *
 * @module services/integrations/actionReview
 */
import logger from '../../utils/logger.js';
import { actionFingerprint, actionReviewState } from '../../utils/actionFingerprint.js';
import { sideEffectFromAnnotations } from '../../utils/toolApproval.js';
import { getProtocolAdapter } from './protocols/index.js';

const COMPONENT = 'ActionReview';

/** Installation ids whose baseline is being written by this worker. */
const baselineInFlight = new Set();

/** `${instanceId}|${action}|${fingerprint}` already reported by this worker. */
const reported = new Set();

/**
 * The side effect the vendor declares for an action: the definition's for a
 * listed action (the admin's override is never part of a fingerprint), else
 * what the adapter derived (MCP annotations, A2A `unknown`).
 *
 * @param {Object} action - a `discoverActions` result
 * @param {Object|null} definition
 * @returns {string|undefined}
 */
function declaredSideEffect(action, definition) {
  const listed = (definition?.actions || []).find(a => a?.name === action.name);
  return listed?.sideEffect || action.sideEffect;
}

/**
 * Fingerprints of the actions an adapter's `discoverActions` returned, by
 * action name. An action that could not be read (`error`: its operation is
 * missing, its connector does not implement it) gets none: its schema is a
 * placeholder, and a placeholder must not become a baseline.
 *
 * @param {Array<Object>} actions - `discoverActions` results
 * @param {Object|null} definition - the installation's definition
 * @returns {Object<string,string>}
 */
export function fingerprintsOfActions(actions, definition) {
  const out = {};
  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action?.name || action.error) continue;
    out[action.name] = actionFingerprint({
      name: action.name,
      sideEffect: declaredSideEffect(action, definition),
      parameters: action.parameters
    });
  }
  return out;
}

/**
 * The fingerprint of a tool an adapter handed over ready-made
 * (`discoverTools`: MCP, A2A). Built from the same inputs as the adapter's
 * `discoverActions`, so both give the same fingerprint for one action.
 *
 * @param {Object} tool - a tool with `_mcp` or `_a2a`
 * @returns {string|null}
 */
export function fingerprintOfTool(tool) {
  if (tool?._mcp) {
    return actionFingerprint({
      name: tool._mcp.originalName || tool.name,
      sideEffect: sideEffectFromAnnotations(tool._mcp.annotations),
      parameters: tool.parameters
    });
  }
  if (tool?._a2a) {
    return actionFingerprint({
      name: tool._a2a.skillId,
      sideEffect: 'unknown',
      parameters: tool.parameters
    });
  }
  return null;
}

/**
 * The current actions of a resolved installation, every one of them
 * (`includeUnavailable`), with their fingerprints. Used by the admin routes.
 * An installation whose definition is missing, incompatible or blocked by a
 * migration lists nothing (its adapter must not run).
 *
 * @param {Object} resolved - `installedIntegrationService.resolve()` result
 * @param {string} [language]
 * @returns {Promise<{actions: Array<Object>, fingerprints: Object<string,string>}>}
 */
export async function currentActionsOf(resolved, language = 'en') {
  if (!resolved?.definition || resolved.incompatible || resolved.blocked) {
    return { actions: [], fingerprints: {} };
  }
  const adapter = getProtocolAdapter(resolved.definition.protocol.type);
  if (!adapter) return { actions: [], fingerprints: {} };
  const actions = await adapter.discoverActions({
    definition: resolved.definition,
    instance: resolved.instance,
    document: resolved.document,
    security: resolved.security,
    language,
    includeUnavailable: true
  });
  return { actions, fingerprints: fingerprintsOfActions(actions, resolved.definition) };
}

/**
 * The review state of each current action (`new`, `changed` or null).
 *
 * @param {Object|null} installation
 * @param {Object<string,string>} fingerprints - current fingerprints by action name
 * @returns {Object<string,'new'|'changed'|null>}
 */
export function reviewStatesOf(installation, fingerprints) {
  const out = {};
  for (const [name, fingerprint] of Object.entries(fingerprints || {})) {
    out[name] = actionReviewState(installation, name, fingerprint);
  }
  return out;
}

/**
 * Compare discovered fingerprints with the accepted ones (see the module docs).
 *
 * @param {string} instanceId
 * @param {Object<string,string>} fingerprints - current fingerprints by action name
 * @param {Object} [options]
 * @param {boolean} [options.complete=true] - the list holds every action (a baseline may be taken from it)
 * @param {Object} [options.service] - the installed integration service (tests)
 * @param {Object} [options.log] - logger (tests)
 * @returns {Promise<{baseline: boolean, pending: Object<string,'new'|'changed'>}>}
 *   whether a baseline was written, and the actions that are new or changed
 */
export async function observeActionFingerprints(instanceId, fingerprints, options = {}) {
  const { complete = true, log = logger } = options;
  const service = options.service || (await import('./InstalledIntegrationService.js')).default;
  const instance = service.get(instanceId);
  const result = { baseline: false, pending: {} };
  if (!instance || !fingerprints || typeof fingerprints !== 'object') return result;

  const hasBaseline = Boolean(
    instance.actions?.fingerprints && typeof instance.actions.fingerprints === 'object'
  );
  if (!hasBaseline) {
    // Opt-in: only an installation with an approval setting is tracked.
    if (!instance.approval || !complete || Object.keys(fingerprints).length === 0) return result;
    if (baselineInFlight.has(instanceId)) return result;
    baselineInFlight.add(instanceId);
    try {
      const written = await service.recordActionBaseline(instanceId, fingerprints);
      result.baseline = Boolean(written);
      if (written) {
        log.info('Took the action fingerprint baseline of an installed integration', {
          component: COMPONENT,
          instanceId,
          actions: Object.keys(fingerprints).length
        });
      }
    } finally {
      baselineInFlight.delete(instanceId);
    }
    return result;
  }

  for (const [name, fingerprint] of Object.entries(fingerprints)) {
    const state = actionReviewState(instance, name, fingerprint);
    if (!state) continue;
    result.pending[name] = state;
    const key = `${instanceId}|${name}|${fingerprint}`;
    if (reported.has(key)) continue;
    reported.add(key);
    log.warn(
      state === 'new'
        ? 'Integration action is new since the last admin review'
        : 'Integration action changed since the last admin review (side effect or input schema)',
      {
        component: COMPONENT,
        instanceId,
        action: name,
        state,
        // Gated (at least `approval.newOrChanged`) only on an installation with an approval setting.
        gated: Boolean(instance.approval)
      }
    );
  }
  return result;
}

/**
 * Observe without waiting and without failing the caller (the tool loader:
 * a failed baseline write must not fail a chat request).
 *
 * @param {string} instanceId
 * @param {Object<string,string>} fingerprints
 * @param {Object} [options] - see {@link observeActionFingerprints}
 */
export function observeInBackground(instanceId, fingerprints, options = {}) {
  observeActionFingerprints(instanceId, fingerprints, options).catch(error => {
    logger.warn('Could not compare the action fingerprints of an installed integration', {
      component: COMPONENT,
      instanceId,
      error: error.message
    });
  });
}

/** Test hook: forget what this worker reported and which baselines are in flight. */
export function _resetActionReview() {
  reported.clear();
  baselineInFlight.clear();
}

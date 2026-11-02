// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool approval of an installation as the Overview edits it (#2945):
 * `{ default?: mode, actions?: { <action name>: mode } }`, keyed by the
 * action's own name (an MCP tool's name, never the prefixed tool id).
 *
 * @module features/admin/components/integrations/installationApproval
 */
import { compareCodeUnits, isApprovalMode } from '../../../../../../shared/toolApproval.js';

/**
 * A clean copy: only known modes, actions sorted by name.
 *
 * @param {Object|null|undefined} approval - `instance.approval`
 * @returns {{default?: string, actions: Object<string,string>}}
 */
export function normalizeApproval(approval) {
  const out = { actions: {} };
  if (isApprovalMode(approval?.default)) out.default = approval.default;
  const actions = approval?.actions && typeof approval.actions === 'object' ? approval.actions : {};
  // Code-unit order: only needs to be stable, so a draft compares equal to
  // what is stored whatever order the keys came in.
  for (const name of Object.keys(actions).sort(compareCodeUnits)) {
    if (isApprovalMode(actions[name])) out.actions[name] = actions[name];
  }
  return out;
}

/**
 * The draft with one action's mode set, or removed (`undefined`: inherit the
 * installation's default).
 *
 * @param {{default?: string, actions: Object}} draft
 * @param {string} name - the action's own name
 * @param {string|undefined} mode
 * @returns {{default?: string, actions: Object}}
 */
export function withActionMode(draft, name, mode) {
  const actions = { ...(draft?.actions || {}) };
  if (isApprovalMode(mode)) actions[name] = mode;
  else delete actions[name];
  return normalizeApproval({ ...draft, actions });
}

/**
 * The draft with the installation default set or removed.
 *
 * @param {{default?: string, actions: Object}} draft
 * @param {string|undefined} mode
 * @returns {{default?: string, actions: Object}}
 */
export function withDefaultMode(draft, mode) {
  return normalizeApproval({ ...draft, default: isApprovalMode(mode) ? mode : undefined });
}

/**
 * The body for `PUT …/installed/:id/approval`: null when nothing is set.
 *
 * @param {{default?: string, actions: Object}} draft
 * @returns {{default?: string, actions?: Object}|null}
 */
export function approvalPayload(draft) {
  const clean = normalizeApproval(draft);
  const out = {};
  if (clean.default) out.default = clean.default;
  if (Object.keys(clean.actions).length) out.actions = clean.actions;
  return Object.keys(out).length ? out : null;
}

/**
 * Whether the draft differs from what is stored.
 *
 * @param {Object|null|undefined} stored - `instance.approval`
 * @param {Object} draft
 * @returns {boolean}
 */
export function approvalChanged(stored, draft) {
  return (
    JSON.stringify(approvalPayload(normalizeApproval(stored))) !==
    JSON.stringify(approvalPayload(draft))
  );
}

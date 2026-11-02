// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool approval of an installation as the Overview edits it (#2945,
 * #2916): `{ default?: mode, actions?: { <action name>: mode },
 * newOrChanged?: mode }`, keyed by the action's own name (an MCP tool's name,
 * never the prefixed tool id). `newOrChanged` is the mode a new or changed
 * action resolves to at least until an admin reviews it (absent: `always`).
 *
 * @module features/admin/components/integrations/installationApproval
 */
import { isApprovalMode } from '../../../../../../shared/toolApproval.js';

/**
 * A clean copy: only known modes, actions sorted by name.
 *
 * @param {Object|null|undefined} approval - `instance.approval`
 * @returns {{default?: string, actions: Object<string,string>, newOrChanged?: string}}
 */
export function normalizeApproval(approval) {
  const out = { actions: {} };
  if (isApprovalMode(approval?.default)) out.default = approval.default;
  if (isApprovalMode(approval?.newOrChanged)) out.newOrChanged = approval.newOrChanged;
  const actions = approval?.actions && typeof approval.actions === 'object' ? approval.actions : {};
  for (const name of Object.keys(actions).sort()) {
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
 * The draft with the mode for new or changed actions set, or removed
 * (`undefined`: the default, `always`).
 *
 * @param {{default?: string, actions: Object, newOrChanged?: string}} draft
 * @param {string|undefined} mode
 * @returns {{default?: string, actions: Object, newOrChanged?: string}}
 */
export function withNewOrChangedMode(draft, mode) {
  return normalizeApproval({ ...draft, newOrChanged: isApprovalMode(mode) ? mode : undefined });
}

/**
 * The body for `PUT …/installed/:id/approval`: null when nothing is set.
 *
 * @param {{default?: string, actions: Object}} draft
 * @returns {{default?: string, actions?: Object, newOrChanged?: string}|null}
 */
export function approvalPayload(draft) {
  const clean = normalizeApproval(draft);
  const out = {};
  if (clean.default) out.default = clean.default;
  if (Object.keys(clean.actions).length) out.actions = clean.actions;
  if (clean.newOrChanged) out.newOrChanged = clean.newOrChanged;
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

/**
 * The actions of an installation that are new or changed since the last admin
 * review (#2916), by the `review` state the installation detail returns per
 * action.
 *
 * @param {Array<{name: string, review?: string|null}>} actions - `GET …/installed/:id` → `actions`
 * @returns {string[]} the action names, in list order
 */
export function actionsPendingReview(actions) {
  return (Array.isArray(actions) ? actions : [])
    .filter(action => action?.review === 'new' || action?.review === 'changed')
    .map(action => action.name);
}

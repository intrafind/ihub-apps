// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool approval vocabulary, shared by the server (resolver, seam) and the
 * client (approval card, admin selects).
 *
 * A tool call the model decides to make can need a person's approval before
 * it runs (intrafind/ihub-apps#2945). Every tool resolves to one of three
 * modes:
 *
 * - `never`  — the call runs without asking (the default: nothing changes
 *              on upgrade until an admin configures a mode).
 * - `writes` — ask unless the call only reads. A side effect of `write`,
 *              `destructive` or `unknown` is asked for, and so is a `read`
 *              that only a remote server's own annotation claims.
 * - `always` — ask for every call, reads included (an external read can carry
 *              internal information out).
 *
 * Several places can set a mode (platform default, tool or installation,
 * action, app). The strictest one wins, so an app can only tighten what an
 * admin configured.
 *
 * @module shared/toolApproval
 */

/** Approval modes, loosest first. */
export const APPROVAL_MODES = Object.freeze(['never', 'writes', 'always']);

/** What a tool call does to the system it talks to. */
export const SIDE_EFFECTS = Object.freeze(['read', 'write', 'destructive', 'unknown']);

/** Where the data of a tool call goes: iHub's own systems, or outside. */
export const DATA_FLOWS = Object.freeze(['internal', 'external']);

/** What a person may answer on an approval card. */
export const APPROVAL_DECISIONS = Object.freeze(['approve', 'reject']);

/** The grants a person can give with an approval ("allow for this chat"). */
export const APPROVAL_GRANTS = Object.freeze(['chat']);

/**
 * Error codes the model receives as a tool result when a gated call did not
 * run. The model can carry on with them instead of the turn failing.
 */
export const APPROVAL_ERROR_CODES = Object.freeze({
  /** The person rejected the call. */
  USER_REJECTED: 'USER_REJECTED',
  /** Nobody answered before the approval expired. */
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  /** No person can approve in this context (API, app-as-tool, MCP gateway, workflow node). */
  APPROVAL_REQUIRED_NO_USER: 'APPROVAL_REQUIRED_NO_USER'
});

/**
 * Where a resolved side effect came from. Only `annotation` is untrusted: it
 * is what a remote server says about its own tool, and it can say anything.
 */
export const SIDE_EFFECT_SOURCES = Object.freeze([
  'admin',
  'tool',
  'definition',
  'annotation',
  'default'
]);

/**
 * Code-unit order of two strings, for orders that only need to be the same
 * everywhere (keys of a canonical form), never for lists people read. Unlike
 * `localeCompare` it does not depend on the runtime's locale.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether a value is a known approval mode.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isApprovalMode(value) {
  return typeof value === 'string' && APPROVAL_MODES.includes(value);
}

/**
 * Rank of a mode (`never` 0, `writes` 1, `always` 2); -1 for anything else.
 *
 * @param {unknown} mode
 * @returns {number}
 */
export function modeRank(mode) {
  return isApprovalMode(mode) ? APPROVAL_MODES.indexOf(mode) : -1;
}

/**
 * The stricter of two modes. An unknown value never wins.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {string|null} the stricter known mode, or null when neither is one
 * @example stricterMode('writes', 'never') // 'writes'
 */
export function stricterMode(a, b) {
  const ra = modeRank(a);
  const rb = modeRank(b);
  if (ra < 0 && rb < 0) return null;
  return ra >= rb ? a : b;
}

/**
 * Whether a call with this resolved policy needs a person's approval.
 *
 * `writes` asks for everything that is not a trusted `read`: a `read` that
 * only an MCP annotation claims (`sideEffectSource: 'annotation'`) is asked
 * for too, so a server that labels a write as read-only cannot slip past.
 *
 * @param {{approval?: string, sideEffect?: string, sideEffectSource?: string}|null} policy
 * @returns {boolean}
 * @example needsApproval({ approval: 'writes', sideEffect: 'read', sideEffectSource: 'definition' }) // false
 */
export function needsApproval(policy) {
  if (!policy) return false;
  if (policy.approval === 'always') return true;
  if (policy.approval !== 'writes') return false;
  return policy.sideEffect !== 'read' || policy.sideEffectSource === 'annotation';
}

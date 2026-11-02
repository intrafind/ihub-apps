// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who an execution acts as, kept with it so a resume after a person's answer
 * continues as the execution's own principal — never as the person who
 * answered.
 *
 * An approver (a tool approval of an agent node, #2945) or anyone who answers
 * a `human` node or an `ask_user` question is recorded as the answer's `by`.
 * Their identity must not become the execution's: the nodes after the answer
 * would otherwise call tools with the answerer's groups and per-user OAuth
 * tokens.
 *
 * The snapshot is taken when the execution starts (`WorkflowEngine.start`,
 * `state.data._workflow.actor`) and, for a parked tool approval, again with
 * the paused loop. It holds no secrets: ids, names, groups, auth mode — the
 * same snapshot a scheduled task keeps of its owner (`ownerPrincipal.js`).
 *
 * @module services/workflow/executionActor
 */
import configCache from '../../configCache.js';
import { buildAgentPrincipal } from '../../utils/authorization.js';
import { ownerSnapshot, resolveOwnerPrincipal } from '../scheduler/tasks/ownerPrincipal.js';

/**
 * The snapshot of the principal an execution runs as.
 *
 * @param {Object|null} user - the execution's user (`options.user`, `context.user`)
 * @returns {Object|null} `{ kind: 'agent', profileId, triggeredBy }` or
 *   `{ kind: 'user', …ownerSnapshot }`; null without a user
 */
export function actorSnapshot(user) {
  if (!user || typeof user !== 'object' || !user.id) return null;
  if (user.isAgent === true && typeof user.profileId === 'string' && user.profileId) {
    return { kind: 'agent', profileId: user.profileId, triggeredBy: user.triggeredBy || null };
  }
  // No users.json lookup here: the resume reads the record (a local account's
  // current groups, and whether it still exists) when it rebuilds the principal.
  return { kind: 'user', ...ownerSnapshot(user, null, { lookupUser: () => ({ found: false }) }) };
}

/**
 * Rebuild the principal a snapshot stands for.
 *
 * @param {Object|null} snapshot - see {@link actorSnapshot}
 * @returns {{ok: true, user: Object}|{ok: false, code: string, message: string}}
 */
export function resolveExecutionActor(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, code: 'ACTOR_UNKNOWN', message: 'The execution has no recorded principal' };
  }
  if (snapshot.kind === 'agent') {
    const { data: profiles = [] } = configCache.getAgentProfiles?.(true) || {};
    const profile = profiles.find(p => p.id === snapshot.profileId);
    if (!profile) {
      return {
        ok: false,
        code: 'AGENT_PROFILE_MISSING',
        message: `Agent profile ${snapshot.profileId} no longer exists`
      };
    }
    return { ok: true, user: buildAgentPrincipal(profile, snapshot.triggeredBy || null) };
  }
  const { kind: _kind, ...owner } = snapshot;
  const resolved = resolveOwnerPrincipal({ owner });
  return resolved.ok
    ? { ok: true, user: resolved.user }
    : { ok: false, code: resolved.code, message: resolved.message };
}

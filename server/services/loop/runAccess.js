/**
 * Run access — who may read or act on a run (concept §5.4).
 *
 * The recorded principal (in the current identity mode) owns a run; admins
 * see every run; an anonymous run is readable by whoever presents its random
 * id. Workflow executions and agent runs the ledger does not know (persistence
 * off, or a run restored from a checkpoint before it was re-registered) are
 * authorized against the execution registry: the launching principal or, for
 * agent runs, the human who triggered the run.
 *
 * Shared by the run routes and by every other route that writes to a run's
 * ledger on behalf of a request (chat feedback), so the same check guards
 * every entry.
 *
 * @module services/loop/runAccess
 */
import runLog from './RunLog.js';
import { resolvePrincipal, isAnonymousUser } from './runIdentity.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { getExecutionRegistry } from '../workflow/ExecutionRegistry.js';

export function isAdminUser(user) {
  if (!user) return false;
  if (user.permissions?.adminAccess === true) return true;
  const groups = Array.isArray(user.groups) ? user.groups : [];
  return groups.includes('admin') || groups.includes('admins');
}

/**
 * Authorize against the execution registry (workflow / agent executions).
 * @returns {{ok:boolean, meta:Object}|null} null when the registry cannot decide
 */
export function authorizeExecution(executionId, user) {
  if (!executionId || isAnonymousUser(user)) return null;
  const execution = getExecutionRegistry().get(executionId);
  if (!execution) return null;
  const userId = String(user.id);
  const isAgentRun = typeof execution.userId === 'string' && execution.userId.startsWith('agent:');
  const allowed =
    isAdminUser(user) ||
    execution.userId === userId ||
    (execution.triggeredBy && String(execution.triggeredBy.userId) === userId);
  if (!allowed) return null;
  return {
    ok: true,
    meta: {
      runId: executionId,
      kind: isAgentRun ? 'agent' : 'workflow',
      anonymous: false,
      startedAt: execution.startedAt || null,
      principalId: execution.userId,
      refs: { executionId }
    }
  };
}

/**
 * Authorize against the ledger's start record (memory first, then disk).
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object}>}
 */
export async function authorizeLedgerRun(runId, user) {
  const mem = runLog.getRunMeta(runId);
  let principalId = mem?.principalId ?? null;
  let anonymous = mem?.anonymous ?? null;
  let kind = mem?.kind ?? null;
  let startedAt = mem?.startedAt ?? null;
  let refs = mem?.refs ?? null;
  if (principalId === null) {
    const events = await runLog.readEvents(runId, { limit: 1 });
    const start = events.find(e => e.type === RUN_LOG_EVENTS.RUN_START);
    if (!start) return { ok: false, status: 404 };
    principalId = start.data.principal?.id ?? null;
    anonymous = start.data.principal?.anonymous === true;
    kind = start.data.kind;
    startedAt = start.ts;
    refs = start.data.refs || {};
  }
  const meta = { runId, kind, anonymous, startedAt, principalId, refs: refs || {} };
  if (isAdminUser(user) || anonymous) return { ok: true, meta };
  if (isAnonymousUser(user)) return { ok: false, status: 403 };
  const me = await resolvePrincipal(user, { mode: runLog.identityMode() });
  if (me.id === principalId) return { ok: true, meta };
  return { ok: false, status: 403 };
}

/**
 * Decide whether `user` may access run `runId`: ledger first, then the
 * execution registry.
 *
 * @param {string} runId
 * @param {Object} user - req.user
 * @param {Object} [opts]
 * @param {string} [opts.executionId] - execution to fall back to (default: runId)
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object}>}
 */
export async function authorizeRun(runId, user, { executionId } = {}) {
  const ledger = await authorizeLedgerRun(runId, user);
  if (ledger.ok) return ledger;
  return authorizeExecution(executionId || runId, user) || ledger;
}

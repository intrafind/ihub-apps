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
import { resolvePrincipal, isAnonymousUser, isAdminUser } from './runIdentity.js';
import { getExecutionRegistry } from '../workflow/ExecutionRegistry.js';

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
 * Authorize against the run's start record (memory — local or the owning
 * worker's — first, then disk).
 * @returns {Promise<{ok:boolean, status?:number, meta?:Object}>}
 */
export async function authorizeLedgerRun(runId, user) {
  // Memory first (this worker, then the owning worker over the bus), then the
  // persisted start record.
  const mem = await runLog.resolveRunMeta(runId);
  let principalId = mem?.principalId ?? null;
  let anonymous = mem?.anonymous ?? null;
  let kind = mem?.kind ?? null;
  let startedAt = mem?.startedAt ?? null;
  let refs = mem?.refs ?? null;
  let identityMode = mem?.identityMode ?? null;
  if (principalId === null) {
    // Only the first line of the run file is needed here.
    const start = await runLog.readStart(runId);
    if (!start) return { ok: false, status: 404 };
    principalId = start.data.principal?.id ?? null;
    anonymous = start.data.principal?.anonymous === true;
    identityMode = start.data.principal?.mode ?? null;
    kind = start.data.kind;
    startedAt = start.ts;
    refs = start.data.refs || {};
  }
  const meta = {
    runId,
    kind,
    anonymous,
    startedAt,
    principalId,
    refs: refs || {},
    /** Identity mode the run's principal was recorded in (actor ids on the run use the same). */
    identityMode: identityMode || null
  };
  if (isAdminUser(user) || anonymous) return { ok: true, meta };
  if (isAnonymousUser(user)) return { ok: false, status: 403 };
  // Resolve the caller in the mode the run's principal was recorded in — a run
  // written under `pseudonymized` keeps matching its owner after an admin
  // switches the global mode.
  const me = await resolvePrincipal(user, { mode: identityMode || runLog.identityMode() });
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

/**
 * Decide whether `user` may act on an interaction (answer or cancel it):
 * admins may; the principal recorded on the interaction's `source` (resolved
 * in that source's identity mode, so this works without the ledger and across
 * workers) may; an interaction of an anonymous run is settled by whoever holds
 * its ids, like the run itself; otherwise whoever may access the interaction's
 * run.
 *
 * @param {Object} interaction
 * @param {Object} user - req.user
 * @returns {Promise<boolean>}
 */
export async function authorizeInteraction(interaction, user) {
  if (!interaction || typeof interaction.runId !== 'string') return false;
  if (isAdminUser(user)) return true;
  const source = interaction.source || {};
  if (source.anonymous === true) return true;
  if (source.principalId && !isAnonymousUser(user)) {
    const me = await resolvePrincipal(user, {
      mode: source.identityMode || runLog.identityMode()
    });
    if (me.id === source.principalId) return true;
  }
  const access = await authorizeRun(interaction.runId, user, {
    executionId: source.executionId
  });
  return access.ok === true;
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The audit entry of a call the run service or the tool runner refused: an
 * app a principal may not run, a tool outside the grant of a run.
 *
 * A refusal is written to the audit log (`AuditLogService.logAudit`, action
 * `execute`, result `failure`) with the principal as the actor, so an admin
 * sees who tried what and why it was refused. Writing it never fails the
 * caller: the audit log swallows its own errors.
 *
 * @module services/run/runAudit
 */

import { logAudit } from '../AuditLogService.js';

/** The audit source of a call, by the caller that made it. */
const SOURCE_BY_ORIGIN = Object.freeze({ mcp: 'mcp', a2a: 'api' });

/**
 * Record a refusal in the audit log.
 *
 * @param {Object} params
 * @param {Object|null} params.principal - who asked
 * @param {'app'|'tool'} params.resource
 * @param {string} params.resourceId
 * @param {string} params.code - why it was refused
 * @param {string} [params.origin] - the caller (`chat`, `subagent`, `mcp`, `a2a`)
 * @param {string} [params.runId]
 * @param {string} params.summary
 * @returns {Object|null} the entry, or null when none was written
 */
export function auditRefusal({ principal, resource, resourceId, code, origin, runId, summary }) {
  const actor = principal?.id
    ? {
        id: String(principal.id),
        username: principal.username,
        name: principal.name,
        groups: Array.isArray(principal.groups) ? [...principal.groups] : [],
        authenticated: principal.id !== 'anonymous'
      }
    : { id: 'unknown', username: 'unknown', groups: [], authenticated: false };
  return logAudit({
    action: 'execute',
    resource,
    resourceId: String(resourceId || ''),
    summary,
    result: 'failure',
    source: SOURCE_BY_ORIGIN[origin] || 'web',
    actor,
    details: {
      code,
      ...(origin ? { origin } : {}),
      ...(runId ? { runId: String(runId) } : {})
    }
  });
}

export default auditRefusal;

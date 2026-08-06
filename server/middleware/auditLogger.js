import configCache from '../configCache.js';
import { logAudit } from '../services/AuditLogService.js';
import { getContext } from '../utils/requestContext.js';

/**
 * Global audit middleware — a blanket safety net that records mutating HTTP
 * requests that are not covered by an explicit logAudit() call.
 *
 * Explicit semantic hooks (auth, oauth clients, users, config CRUD, etc.) set
 * `req._auditLogged` via logAudit(); this middleware skips those so we don't
 * write a duplicate, coarser entry for the same request.
 */

const METHOD_ACTION = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete'
};

// Read/streaming/high-volume paths that should never be audited as mutations.
// 'session' (POST /api/session/start) fires on every app load — auditing it
// floods the log with noise. Login/logout have explicit logAudit() hooks.
const EXCLUDED_SEGMENTS = [
  'chat',
  'inference',
  'session',
  'sessions',
  'magic-prompt',
  'short-links',
  'feedback',
  'translations',
  'pages'
];

const SENSITIVE_KEY_RE =
  /pass(word)?|pwd|secret|token|api[-_]?key|client[-_]?secret|credential|priv(ate)?[-_]?key|passphrase|signing|\bpin\b|\botp\b|\bmfa\b|salt|authoriz|cookie|bearer/i;

function getAuditConfig() {
  try {
    const platform = configCache.getPlatform ? configCache.getPlatform() : {};
    return platform?.audit || {};
  } catch {
    return {};
  }
}

/**
 * Derive a coarse { resource, resourceId } from the request path.
 * e.g. /api/admin/apps/my-app -> { resource: 'apps', resourceId: 'my-app' }
 *      /api/integrations/jira  -> { resource: 'integrations', resourceId: 'jira' }
 */
export function deriveResource(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  const segments = path.split('/').filter(Boolean);
  const apiIdx = segments.indexOf('api');
  const rest = apiIdx >= 0 ? segments.slice(apiIdx + 1) : segments;
  if (rest.length === 0) return { resource: 'unknown', resourceId: '' };

  let idx = 0;
  if (rest[0] === 'admin') idx = 1; // skip the 'admin' prefix
  const resource = rest[idx] || 'unknown';
  const resourceId = rest[idx + 1] || '';
  return { resource, resourceId };
}

function isExcluded(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  // Admin mutations are always audit-worthy; never exclude them (otherwise a
  // shared segment like 'pages' would silently skip /api/admin/pages CRUD).
  if (path.includes('/api/admin/')) return false;
  const segments = path.split('/').filter(Boolean);
  return segments.some(s => EXCLUDED_SEGMENTS.includes(s));
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '***REDACTED***' : redact(v);
    }
    return out;
  }
  return value;
}

export function auditLogger() {
  return (req, res, next) => {
    const action = METHOD_ACTION[req.method];
    if (!action) return next();

    const path = req.originalUrl || req.url || '';
    if (!path.includes('/api/')) return next();
    if (isExcluded(req)) return next();

    // Only the safety net for AUTHENTICATED actors. Unauthenticated requests
    // would let anyone flood the audit log with attacker-chosen paths; the
    // security-relevant anonymous events (login attempts) have explicit hooks.
    if (!req.user || req.user.id === 'anonymous') return next();

    // Capture the requestId synchronously while we're still inside the request's
    // async context — the res 'finish' callback may run on a later tick.
    const requestId = getContext()?.requestId;

    res.on('finish', () => {
      try {
        // An explicit logAudit() already covered this request.
        if (req._auditLogged) return;

        const verbosity = getAuditConfig().verbosity || 'metadata';
        const { resource, resourceId } = deriveResource(req);
        const result = res.statusCode < 400 ? 'success' : 'failure';

        let summary = `${req.method} ${path.split('?')[0]} -> ${res.statusCode}`;
        if (
          (verbosity === 'request' || verbosity === 'full') &&
          req.body &&
          typeof req.body === 'object' &&
          Object.keys(req.body).length > 0
        ) {
          try {
            summary += ` body=${JSON.stringify(redact(req.body)).slice(0, 500)}`;
          } catch {
            // ignore body serialization issues
          }
        }

        logAudit({ req, action, resource, resourceId, summary, result, requestId });
      } catch {
        // Never let audit logging affect the response lifecycle.
      }
    });

    next();
  };
}

export default auditLogger;

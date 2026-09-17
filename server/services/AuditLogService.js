import { promises as fs, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getRootDir } from '../pathUtils.js';
import logger from '../utils/logger.js';
import configCache from '../configCache.js';
import { getContext } from '../utils/requestContext.js';
import { anonymizeIp } from '../utils/ipAnonymizer.js';
import { validateAuditEntry } from '../validators/auditEntrySchema.js';
import { createJsonlAppender } from '../utils/jsonlAppender.js';

const AUDIT_LOG_DIR = 'data/audit-log';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 365;
// Fallback window when a caller passes no `from`. Left at 7 days for callers
// that just want "the most recent entries" (the admin overview's activity
// panel). The audit log page always sends an explicit range and defaults it to
// 24 hours itself.
const DEFAULT_QUERY_RANGE_DAYS = 7;
const FLUSH_INTERVAL_MS = 5000;
// Hard cap so a failing disk + high write volume can't exhaust memory. When
// exceeded we drop the oldest entries and emit a single overflow warning.
const MAX_QUEUE = 10000;

// Linear-time email-shape detection. A regex like /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// backtracks polynomially on attacker-supplied login usernames (CodeQL ReDoS),
// so we use string scanning instead.
function isEmailShaped(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (/\s/.test(value)) return false; // single linear test, no backtracking
  const at = value.indexOf('@');
  if (at <= 0) return false; // need a non-empty local part
  if (value.indexOf('@', at + 1) !== -1) return false; // exactly one '@'
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  // dot must be present and neither leading nor trailing in the domain
  return dot > 0 && dot < domain.length - 1;
}

// In-memory write buffer. High-volume middleware writes are batched and
// flushed on an interval (and on shutdown) so we don't hit the disk on every
// request. queryAuditLog() flushes first so reads stay consistent. Entries
// are grouped by date so a flush spanning midnight lands in the correct
// per-day JSONL file.
const appender = createJsonlAppender({
  getFilePath: entry =>
    join(getRootDir(), 'contents', AUDIT_LOG_DIR, `${entry.ts.slice(0, 10)}.jsonl`),
  flushIntervalMs: FLUSH_INTERVAL_MS,
  maxQueueSize: MAX_QUEUE,
  component: 'AuditLogService'
});

function getAuditConfig() {
  try {
    const platform = configCache.getPlatform ? configCache.getPlatform() : {};
    return platform?.audit || {};
  } catch {
    return {};
  }
}

function maskEmail(value) {
  if (isEmailShaped(value)) {
    return value.slice(0, value.indexOf('@'));
  }
  return value;
}

/**
 * Build the actor object for an audit entry. Prefers an explicit actor (used
 * for pre-auth events such as a failed login) and otherwise reads from
 * req.user. Honors audit.includeEmail (default false) by masking email-shaped
 * identifiers.
 */
function buildActor(req, explicitActor) {
  const includeEmail = getAuditConfig().includeEmail === true;
  const src = explicitActor || req?.user || {};
  let id = src.id ?? 'unknown';
  let username = src.username ?? src.name ?? src.id ?? 'unknown';
  // Mask email-shaped identifiers in BOTH id and username so includeEmail:false
  // actually prevents email storage (login actors set id = the attempted email).
  if (!includeEmail) {
    id = maskEmail(id);
    username = maskEmail(username);
  }
  const authenticated =
    typeof src.authenticated === 'boolean'
      ? src.authenticated
      : Boolean(src.id && src.id !== 'anonymous');
  return {
    id,
    username,
    groups: Array.isArray(src.groups) ? src.groups : [],
    authenticated
  };
}

/**
 * Derive the audit source from the request when not provided explicitly.
 */
function deriveSource(req) {
  if (!req) return 'web';
  if (req.user?.isOAuthClient || req.user?.authMethod === 'oauth') return 'api';
  const url = req.originalUrl || req.baseUrl || req.url || '';
  if (url.includes('/api/admin/')) return 'admin';
  return 'web';
}

/**
 * Flush the buffered audit entries to their daily JSONL files.
 *
 * @returns {Promise<number>} number of entries written
 */
export async function flushAuditLog() {
  return appender.flush();
}

/**
 * Log an audit event to the append-only audit log. Entries are buffered and
 * flushed every few seconds (and on shutdown). Each day gets its own JSONL
 * file at contents/data/audit-log/YYYY-MM-DD.jsonl.
 *
 * @param {Object} options
 * @param {Object} [options.req] - Express request object
 * @param {string} options.action - 'create' | 'update' | 'delete' | 'toggle' | 'import' | 'export' | 'login' | 'logout'
 * @param {string} options.resource - Affected resource type (e.g. 'app', 'auth', 'user', 'oauthClient')
 * @param {string} [options.resourceId] - ID of the affected resource
 * @param {string} [options.summary] - Human-readable summary of the action
 * @param {'success'|'failure'} [options.result='success'] - Outcome of the action
 * @param {string} [options.source] - 'web' | 'mcp' | 'api' | 'admin' (derived from req when omitted)
 * @param {Object} [options.actor] - Explicit actor for pre-auth events (e.g. failed login)
 * @param {string} [options.requestId] - Explicit request id (used by the middleware,
 *   whose res 'finish' callback may run outside the request's async context)
 * @returns {Object|null} the buffered entry, or null on failure
 */
export function logAudit({
  req,
  action,
  resource,
  resourceId,
  summary,
  result = 'success',
  source,
  actor,
  requestId
} = {}) {
  try {
    const auditCfg = getAuditConfig();
    const includeEmail = auditCfg.includeEmail === true;
    // resourceId can carry the attempted identifier (e.g. a login id that is an
    // email), so honor the same masking as the actor.
    const safeResourceId = includeEmail ? resourceId || '' : maskEmail(resourceId || '');
    // Honor audit.anonymizeIp:
    //   true / 'mask' -> mask the host bits (/24 IPv4, /48 IPv6)
    //   'drop'        -> omit the `ip` property from the entry entirely
    //   anything else -> store verbatim
    const rawIp = req?.ip;
    const entry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      actor: buildActor(req, actor),
      action,
      resource,
      resourceId: safeResourceId,
      summary: summary || '',
      result,
      source: source || deriveSource(req),
      requestId: requestId || getContext()?.requestId || randomUUID()
    };
    if (auditCfg.anonymizeIp !== 'drop') {
      entry.ip =
        auditCfg.anonymizeIp === true || auditCfg.anonymizeIp === 'mask'
          ? anonymizeIp(rawIp)
          : rawIp;
    }

    const validation = validateAuditEntry(entry);
    if (!validation.success) {
      logger.warn('Audit entry failed validation; writing anyway', {
        component: 'AuditLogService',
        error: validation.error
      });
    }

    appender.append(entry);

    // Mark the request so the global audit middleware doesn't emit a duplicate
    // coarse entry for the same request — explicit calls are authoritative.
    if (req) req._auditLogged = true;

    if (getAuditConfig().winstonMirror === true) {
      logger.info('audit', {
        component: 'audit',
        audit: true,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        result: entry.result,
        source: entry.source,
        actor: { id: entry.actor.id, authenticated: entry.actor.authenticated },
        requestId: entry.requestId
      });
    }

    return entry;
  } catch (error) {
    // Audit logging should never break the request
    logger.error('Failed to record audit log entry', {
      component: 'AuditLogService',
      action,
      resource,
      resourceId,
      error: error.message
    });
    return null;
  }
}

/**
 * Facetable fields. Each is counted over the selected date range so the filter
 * UI can render real option lists with entry counts instead of a hardcoded
 * vocabulary (`resource` in particular is deliberately open-ended — the audit
 * middleware derives resource names from request paths).
 */
const FACET_FIELDS = ['actor', 'resource', 'action', 'result', 'source'];

/** Fields the free-text `q` filter searches, in the order they are checked. */
const SEARCH_FIELDS = ['summary', 'resourceId', 'ip', 'requestId'];

/**
 * Read the facet value of a field from an entry, normalizing the two legacy
 * shapes: entries written before the actor migration carry a plain `admin`
 * string instead of an `actor` object, and `result` was optional (absent meant
 * success).
 */
function facetValue(entry, field) {
  switch (field) {
    case 'actor':
      return entry.actor?.username ?? entry.admin ?? '';
    case 'result':
      return entry.result ?? 'success';
    default:
      return entry[field] ?? '';
  }
}

/**
 * Normalize a filter argument to a Set of values, or null when the filter is
 * not in play. Accepts a single string or an array of strings; empty values are
 * dropped, and an argument that yields nothing is treated as absent.
 */
function toValueSet(value) {
  if (value === undefined || value === null) return null;
  const list = (Array.isArray(value) ? value : [value]).filter(
    v => typeof v === 'string' && v.length > 0
  );
  return list.length > 0 ? new Set(list) : null;
}

/**
 * Build a value matcher from an include set and an exclude set.
 *
 * The rule is "include first, then subtract exclude", with `*` meaning every
 * value in either set:
 *
 *   matches(v) = (include has '*' || include has v) && !(exclude has '*' || exclude has v)
 *
 * An absent include set defaults to `*`, so exclusion alone means "everything
 * but these". Exclusion always wins over inclusion for a value in both sets.
 *
 * @returns {((value: string) => boolean)|null} null when neither set filters
 *   anything, so the caller can skip the check entirely.
 */
function buildValueMatcher(include, exclude) {
  const inc = toValueSet(include);
  const exc = toValueSet(exclude);
  if (!inc && !exc) return null;
  if (exc?.has('*')) return () => false; // the "select none" state
  const includesAll = !inc || inc.has('*');
  if (includesAll && !exc) return null;
  if (includesAll) return value => !exc.has(value);
  if (!exc) return value => inc.has(value);
  return value => inc.has(value) && !exc.has(value);
}

/**
 * Build the free-text matcher for `q`. Case-insensitive substring match over
 * the summary, resource id, IP, request id and actor name. Runs in memory over
 * the entries in the date range — there is no index.
 */
function buildTextMatcher(q) {
  if (typeof q !== 'string') return null;
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  return entry => {
    for (const field of SEARCH_FIELDS) {
      const value = entry[field];
      if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true;
    }
    const actor = facetValue(entry, 'actor');
    return typeof actor === 'string' && actor.toLowerCase().includes(needle);
  };
}

/**
 * Query audit log entries with optional filters and pagination.
 *
 * Every value filter accepts a single string or an array of strings, and has a
 * matching `*Exclude` argument that is subtracted from it. `*` is a wildcard
 * meaning "every value"; see {@link buildValueMatcher} for the exact rule.
 *
 * The whole date range is scanned once: each line is parsed, counted into the
 * facets, matched against the filters, and kept only if it matches.
 *
 * @param {Object} options
 * @param {string} [options.from] - Start date (YYYY-MM-DD), defaults to 7 days ago
 * @param {string} [options.to] - End date (YYYY-MM-DD), defaults to today
 * @param {string|string[]} [options.actor] - Actor usernames to include
 * @param {string|string[]} [options.actorExclude] - Actor usernames to exclude
 * @param {string|string[]} [options.resource] - Resource types to include
 * @param {string|string[]} [options.resourceExclude] - Resource types to exclude
 * @param {string|string[]} [options.action] - Actions to include
 * @param {string|string[]} [options.actionExclude] - Actions to exclude
 * @param {string|string[]} [options.result] - Outcomes to include
 * @param {string|string[]} [options.resultExclude] - Outcomes to exclude
 * @param {string|string[]} [options.source] - Sources to include
 * @param {string|string[]} [options.sourceExclude] - Sources to exclude
 * @param {string} [options.q] - Free-text search over summary/resourceId/ip/requestId/actor
 * @param {boolean} [options.facets=false] - Also return per-field value counts
 * @param {number} [options.limit=50] - Max entries to return
 * @param {number} [options.offset=0] - Number of entries to skip
 * @returns {Promise<{entries: Array, total: number, facets?: Object}>}
 */
export async function queryAuditLog({
  from,
  to,
  actor,
  actorExclude,
  resource,
  resourceExclude,
  action,
  actionExclude,
  result,
  resultExclude,
  source,
  sourceExclude,
  q,
  facets = false,
  limit = 50,
  offset = 0
} = {}) {
  // Flush buffered entries so reads reflect everything logged so far.
  try {
    await appender.flush();
  } catch {
    // A flush failure is logged elsewhere; continue with what's on disk.
  }

  const now = new Date();
  const toDate = to || now.toISOString().slice(0, 10);
  const fromDate =
    from || new Date(now.getTime() - DEFAULT_QUERY_RANGE_DAYS * DAY_MS).toISOString().slice(0, 10);

  const auditDir = join(getRootDir(), 'contents', AUDIT_LOG_DIR);

  const emptyFacets = () => Object.fromEntries(FACET_FIELDS.map(f => [f, []]));

  // Collect all matching JSONL files
  let files;
  try {
    files = await fs.readdir(auditDir);
  } catch {
    return facets ? { entries: [], total: 0, facets: emptyFacets() } : { entries: [], total: 0 };
  }

  const jsonlFiles = files
    .filter(f => f.endsWith('.jsonl'))
    .filter(f => {
      const date = f.replace('.jsonl', '');
      return date >= fromDate && date <= toDate;
    })
    .sort()
    .reverse(); // newest first

  const matchers = {
    actor: buildValueMatcher(actor, actorExclude),
    resource: buildValueMatcher(resource, resourceExclude),
    action: buildValueMatcher(action, actionExclude),
    result: buildValueMatcher(result, resultExclude),
    source: buildValueMatcher(source, sourceExclude)
  };
  // Only the fields that actually filter, so an unfiltered query does no work.
  const activeMatchers = FACET_FIELDS.filter(field => matchers[field]).map(field => [
    field,
    matchers[field]
  ]);
  const matchesText = buildTextMatcher(q);

  // Facet counters are keyed by field, then by value. They are populated from
  // every entry in the date range *before* the value filters are applied, so
  // unticking `login` does not make the `login` checkbox and its count vanish.
  const counters = facets ? new Map(FACET_FIELDS.map(field => [field, new Map()])) : null;

  // Only the newest `offset + limit` matches are kept. `total` is counted
  // separately, so pagination stays exact without ever holding the whole
  // matched set in memory — an unfiltered query over a wide range would
  // otherwise materialize (and sort) the entire range.
  const keepCount = Math.max(0, offset) + Math.max(0, limit);
  const newest = [];
  let total = 0;

  // Sort newest first and drop everything past the window. Called whenever the
  // buffer reaches twice the window, so the amortized cost stays O(n log k).
  // Entries sharing an identical timestamp have no defined order between them,
  // at the window boundary as anywhere else.
  const trimToWindow = () => {
    newest.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    if (newest.length > keepCount) newest.length = keepCount;
  };

  for (const file of jsonlFiles) {
    let reader;
    try {
      reader = createInterface({
        input: createReadStream(join(auditDir, file), 'utf8'),
        crlfDelay: Infinity
      });
    } catch {
      continue; // Skip unreadable files
    }
    try {
      // One pass per file: parse, count facets, filter, keep only matches.
      for await (const line of reader) {
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // Skip malformed lines
        }
        if (!entry || typeof entry !== 'object') continue;

        if (counters) {
          for (const field of FACET_FIELDS) {
            const value = facetValue(entry, field);
            if (!value) continue;
            const byValue = counters.get(field);
            byValue.set(value, (byValue.get(value) ?? 0) + 1);
          }
        }

        let keep = true;
        for (const [field, matcher] of activeMatchers) {
          if (!matcher(facetValue(entry, field))) {
            keep = false;
            break;
          }
        }
        if (keep && matchesText && !matchesText(entry)) keep = false;
        if (keep) {
          total += 1;
          if (keepCount > 0) {
            newest.push(entry);
            if (newest.length >= keepCount * 2) trimToWindow();
          }
        }
      }
    } catch {
      // Skip unreadable files
    } finally {
      reader.close();
    }
  }

  trimToWindow();
  const entries = newest.slice(offset, offset + limit);

  if (!counters) return { entries, total };

  const facetResult = {};
  for (const field of FACET_FIELDS) {
    facetResult[field] = Array.from(counters.get(field), ([value, count]) => ({
      value,
      count
    })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  return { entries, total, facets: facetResult };
}

/**
 * Delete audit log files older than `retentionDays`.
 *
 * A daily JSONL file is considered expired when its date is strictly older
 * than `today − retentionDays`. Pass a non-positive number to disable
 * cleanup. Returns the list of file names that were deleted so the scheduler
 * can log the result.
 *
 * @param {number} retentionDays
 * @returns {Promise<{deleted: string[], retainedFrom: string|null}>}
 */
export async function cleanupAuditLog(retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { deleted: [], retainedFrom: null };
  }

  const auditDir = join(getRootDir(), 'contents', AUDIT_LOG_DIR);
  let files;
  try {
    files = await fs.readdir(auditDir);
  } catch {
    return { deleted: [], retainedFrom: null };
  }

  const cutoffMs = Date.now() - retentionDays * DAY_MS;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);

  const deleted = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const date = file.replace('.jsonl', '');
    // String comparison on YYYY-MM-DD is sound because the format is lexicographic.
    if (date < cutoffDate) {
      try {
        await fs.unlink(join(auditDir, file));
        deleted.push(file);
      } catch (error) {
        logger.warn('Failed to delete audit log file', {
          component: 'AuditLogService',
          file,
          error: error.message
        });
      }
    }
  }

  return { deleted, retainedFrom: cutoffDate };
}

let cleanupInterval = null;
const CLEANUP_INTERVAL_MS = DAY_MS; // run once per day

/**
 * Start the audit-log cleanup scheduler.
 *
 * Reads `retentionDays` from the passed config (falls back to the default).
 * Runs once on startup, then daily. A non-positive `retentionDays` (or
 * `cleanupEnabled: false`) disables cleanup entirely.
 *
 * @param {{ retentionDays?: number, cleanupEnabled?: boolean }} [config]
 */
export function startAuditCleanupScheduler(config = {}) {
  if (cleanupInterval) return;
  const enabled = config.cleanupEnabled !== false;
  const retentionDays = enabled
    ? Number.isFinite(config.retentionDays)
      ? config.retentionDays
      : DEFAULT_RETENTION_DAYS
    : -1;

  const run = () => {
    cleanupAuditLog(retentionDays)
      .then(({ deleted, retainedFrom }) => {
        if (deleted.length > 0) {
          logger.info('Audit log cleanup removed expired files', {
            component: 'AuditLogService',
            removed: deleted.length,
            retainedFrom
          });
        }
      })
      .catch(error =>
        logger.error('Audit log cleanup failed', {
          component: 'AuditLogService',
          error: error.message
        })
      );
  };

  run();
  cleanupInterval = setInterval(run, CLEANUP_INTERVAL_MS);
}

export function stopAuditCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export function getAuditLogRetentionDefault() {
  return DEFAULT_RETENTION_DAYS;
}

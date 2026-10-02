/**
 * Pure helpers for the EU AI Act admin page (`/admin/eu-ai-act`) and the
 * admin compliance banner. No React and no network in here, so everything is
 * unit-testable (`tests/unit/client/eu-ai-act-utils.test.jsx`).
 *
 * The data shapes come from `GET /api/admin/ai-transparency/status` (see
 * `server/services/provenance/ComplianceService.js`).
 *
 * @module features/admin/utils/euAiAct
 */

/** Minimum justification length the server accepts (`reasonSchema`, trimmed). */
export const JUSTIFICATION_MIN_LENGTH = 10;

/** Maximum justification length the server accepts. */
export const JUSTIFICATION_MAX_LENGTH = 2000;

/** Tab ids of the page, in display order. `?tab=<id>` selects one. */
export const EU_AI_ACT_TABS = Object.freeze([
  'overview',
  'models',
  'apps',
  'settings',
  'certificates',
  'detection'
]);

/** The tab shown when `?tab=` is missing or unknown. */
export const DEFAULT_EU_AI_ACT_TAB = 'overview';

/** How many warnings the compact banner lists before "and N more". */
export const BANNER_MAX_WARNINGS = 3;

/**
 * English fallbacks for the checklist labels, keyed by checklist item id.
 * The i18n key is `admin.euAiAct.checklist.<id>`.
 */
export const CHECKLIST_LABEL_FALLBACKS = Object.freeze({
  feature: 'AI transparency features',
  disclosure: 'Interaction disclosure (Art. 50(1))',
  signing: 'Signing certificate',
  imageMarking: 'Image marking',
  exports: 'Server-side exports',
  detection: 'Detection',
  textWatermarking: 'Text watermarking per model',
  signpost: 'Signpost',
  provider: 'Provider details',
  editorial: 'Editorial responsibility (Art. 50(4))',
  termsOfService: 'Terms of service: no removal of markings',
  provenanceRecords: 'Provenance records'
});

/**
 * Resolve the `?tab=` query value to a known tab id.
 *
 * @param {string|null|undefined} value - Raw query parameter value.
 * @returns {string} A member of {@link EU_AI_ACT_TABS}.
 * @example resolveEuAiActTab('models') // 'models'
 * @example resolveEuAiActTab('nope')   // 'overview'
 */
export function resolveEuAiActTab(value) {
  return EU_AI_ACT_TABS.includes(value) ? value : DEFAULT_EU_AI_ACT_TAB;
}

/**
 * Whether a justification is long enough to submit. Mirrors the server, which
 * trims before checking the length.
 *
 * @param {string} text
 * @param {number} [minLength=JUSTIFICATION_MIN_LENGTH]
 * @returns {boolean}
 */
export function isJustificationValid(text, minLength = JUSTIFICATION_MIN_LENGTH) {
  const length = typeof text === 'string' ? text.trim().length : 0;
  return length >= minLength && length <= JUSTIFICATION_MAX_LENGTH;
}

/**
 * Bring the four record shapes the server writes (disclosure opt-out,
 * exemption, model acknowledgement, warning dismissal) into one shape the UI
 * can render.
 *
 * @param {Object|null|undefined} record
 * @returns {{by: string|null, byName: string|null, at: string|null, reason: string|null, type: string|null, installationUrl: string|null, installationId: string|null, ihubVersion: string|null}|null}
 * @example
 * normalizeRecord({ disabledBy: 'u1', disabledAt: '2026-09-28T10:00:00Z', reason: 'Internal tool' })
 * // → { by: 'u1', at: '2026-09-28T10:00:00Z', reason: 'Internal tool', ... }
 */
export function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
        return record[key];
      }
    }
    return null;
  };
  return {
    by: pick('disabledBy', 'declaredBy', 'acknowledgedBy', 'dismissedBy', 'by'),
    byName: pick('disabledByName', 'declaredByName', 'acknowledgedByName', 'dismissedByName'),
    at: pick('disabledAt', 'declaredAt', 'acknowledgedAt', 'dismissedAt', 'at'),
    reason: pick('reason', 'justification'),
    type: pick('type'),
    installationUrl: pick('installationUrl'),
    installationId: pick('installationId'),
    ihubVersion: pick('ihubVersion')
  };
}

/**
 * Format an ISO timestamp for display in the viewer's language.
 *
 * @param {string|null|undefined} iso
 * @param {string} [language] - BCP 47 tag, e.g. `en` or `de`.
 * @returns {string} The formatted date/time, the raw value if it cannot be
 *   parsed, or an empty string for no value.
 */
export function formatDateTime(iso, language) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat(language || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Split the status warnings into the ones still shown in the banner and the
 * ones an admin dismissed for the current state.
 *
 * @param {Object|null|undefined} status - The `/status` response.
 * @returns {{active: Array<Object>, dismissed: Array<Object>}}
 */
export function splitWarnings(status) {
  const warnings = Array.isArray(status?.warnings) ? status.warnings : [];
  return {
    active: warnings.filter(w => !w.dismissal),
    dismissed: warnings.filter(w => Boolean(w.dismissal))
  };
}

/**
 * Find an earlier dismissal of a warning that no longer applies because the
 * situation changed since (different `stateHash`). The warning is back in the
 * banner; the UI tells the admin why.
 *
 * @param {Object} warning - An active warning.
 * @param {Array<Object>|undefined} dismissals - `status.records.dismissals`.
 * @returns {Object|null} The outdated dismissal record, if any.
 */
export function findOutdatedDismissal(warning, dismissals) {
  if (!warning || !Array.isArray(dismissals)) return null;
  return (
    dismissals.find(d => d.warningId === warning.id && d.stateHash !== warning.stateHash) || null
  );
}

/**
 * Count checklist items per status.
 *
 * @param {Array<{status: 'ok'|'warning'|'error'}>|undefined} checklist
 * @returns {{ok: number, warning: number, error: number, total: number}}
 */
export function countChecklist(checklist) {
  const counts = { ok: 0, warning: 0, error: 0, total: 0 };
  for (const item of Array.isArray(checklist) ? checklist : []) {
    if (item.status in counts) counts[item.status] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Whether the models tab should offer "Acknowledge…" for a model: it has a
 * marking gap and no acknowledgement yet.
 *
 * @param {Object} model - A `status.models` row.
 * @returns {boolean}
 */
export function canAcknowledgeModel(model) {
  if (!model || model.acknowledgement) return false;
  const issues = Array.isArray(model.issues) ? model.issues : [];
  return issues.includes('text-unmarked') || issues.includes('image-unmarked');
}

/**
 * Whether a model row should be highlighted as needing attention: enabled
 * and not conforming. An acknowledged unmarked model still counts.
 *
 * @param {Object} model - A `status.models` row.
 * @returns {boolean}
 */
export function modelNeedsAttention(model) {
  return Boolean(model?.enabled && !model?.conforming);
}

/**
 * Split the banner warnings into the ones listed and the rest.
 *
 * @param {Array<Object>|undefined} warnings - `banner.warnings`.
 * @param {number} [max=BANNER_MAX_WARNINGS]
 * @returns {{shown: Array<Object>, hiddenCount: number}}
 */
export function pickBannerWarnings(warnings, max = BANNER_MAX_WARNINGS) {
  const list = Array.isArray(warnings) ? warnings : [];
  // Errors before warnings, keeping the server order within each group.
  const sorted = [
    ...list.filter(w => w.severity === 'error'),
    ...list.filter(w => w.severity !== 'error')
  ];
  return { shown: sorted.slice(0, max), hiddenCount: Math.max(0, sorted.length - max) };
}

/**
 * Whether the signed-in user may see the admin compliance banner. Content
 * admins (no `adminAccess`) and the anonymous principal are excluded: the
 * banner endpoint is full-admin only and always refuses `anonymous`.
 *
 * @param {Object|null|undefined} user - `useAuth().user`
 * @returns {boolean}
 */
export function isComplianceBannerUser(user) {
  if (!user || user.id === 'anonymous') return false;
  return Boolean(user.isAdmin || user.permissions?.adminAccess);
}

/** Filters of the models tab. */
export const MODEL_FILTERS = Object.freeze(['attention', 'nonConforming', 'enabled', 'all']);

/**
 * Filter the model compliance matrix.
 *
 * - `attention`: enabled and non-conforming (the default view)
 * - `nonConforming`: every non-conforming model, enabled or not
 * - `enabled`: every enabled model
 * - `all`: everything
 *
 * @param {Array<Object>|undefined} models - `status.models`
 * @param {string} filter - One of {@link MODEL_FILTERS}.
 * @returns {Array<Object>}
 */
export function filterModels(models, filter) {
  const list = Array.isArray(models) ? models : [];
  switch (filter) {
    case 'attention':
      return list.filter(modelNeedsAttention);
    case 'nonConforming':
      return list.filter(m => !m.conforming);
    case 'enabled':
      return list.filter(m => m.enabled);
    default:
      return list;
  }
}

/** Filters of the apps tab. */
export const APP_FILTERS = Object.freeze(['all', 'records', 'issues']);

/**
 * Filter the apps table.
 *
 * - `records`: apps with a disclosure opt-out or an exemption
 * - `issues`: apps with a reported issue (e.g. temperature 0) or records from
 *   another installation
 * - `all`: everything
 *
 * @param {Array<Object>|undefined} apps - `status.apps`
 * @param {string} filter - One of {@link APP_FILTERS}.
 * @returns {Array<Object>}
 */
export function filterApps(apps, filter) {
  const list = Array.isArray(apps) ? apps : [];
  switch (filter) {
    case 'records':
      return list.filter(a => a.optOut || a.exemption);
    case 'issues':
      return list.filter(a => (a.issues || []).length > 0 || a.foreignRecords);
    default:
      return list;
  }
}

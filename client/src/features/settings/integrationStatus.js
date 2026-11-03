// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How Settings → Integrations shows one entry of `GET /api/integrations`:
 * the status line, the status dot, the one action a row offers, whether it
 * needs attention, and the search / category / status filters.
 *
 * The server decides the state (`connection.mode`, `connection.status`,
 * `connection.reason`, `renewable`, `sharedWith`); this module only maps it
 * to words. Pure: it returns translated text through the `t` it is given and
 * reads no global state, so the page and the tests share it.
 *
 * @module features/settings/integrationStatus
 */

/** Connected access that expires within this time and does not renew itself needs attention. */
export const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** The status filter values. */
export const STATUS_FILTERS = Object.freeze({ ALL: 'all', ATTENTION: 'attention' });

/** Badge tone per side effect (the shared `Badge` mapping for integrations). */
export const EFFECT_TONES = Object.freeze({
  read: 'info',
  write: 'warning',
  destructive: 'danger',
  unknown: 'neutral'
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Milliseconds from `now` until an ISO date, or null when there is no valid date. */
function msUntil(iso, now) {
  const at = Date.parse(iso || '');
  return Number.isFinite(at) ? at - now : null;
}

/**
 * "in 29 days", "in 3 hours", "vor 2 Tagen" — a relative time in the UI language.
 *
 * @param {string} iso
 * @param {string} language
 * @param {number} [now=Date.now()]
 * @returns {string} empty when the date is not valid
 */
export function relativeTime(iso, language, now = Date.now()) {
  const ms = msUntil(iso, now);
  if (ms === null) return '';
  let format;
  try {
    format = new Intl.RelativeTimeFormat(language || 'en', { numeric: 'auto' });
  } catch {
    format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
  const abs = Math.abs(ms);
  if (abs >= DAY) return format.format(Math.round(ms / DAY), 'day');
  if (abs >= HOUR) return format.format(Math.round(ms / HOUR), 'hour');
  return format.format(Math.round(ms / MINUTE), 'minute');
}

/** A date and time in the UI language, or empty. */
export function formatDate(iso, language) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  try {
    return new Date(at).toLocaleString(language || undefined);
  } catch {
    return new Date(at).toLocaleString();
  }
}

/**
 * Whether the connected access ends at `expiresAt` without iHub renewing it
 * (no refresh token held). Unknown renewal (`renewable: null`) is not shown
 * as an expiry: the server could not tell.
 */
export function accessExpires(connection) {
  return (
    connection?.status === 'connected' &&
    connection.renewable === false &&
    msUntil(connection.expiresAt, 0) !== null
  );
}

/**
 * Whether an entry needs the user's (or an admin's) attention: a reconnect,
 * an unavailable integration, or access that ends within
 * {@link EXPIRY_WARNING_MS} without renewing itself.
 *
 * @param {Object} entry
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function needsAttention(entry, now = Date.now()) {
  const connection = entry?.connection || {};
  if (connection.status === 'needs_reconnect' || connection.status === 'unavailable') return true;
  if (!accessExpires(connection)) return false;
  return msUntil(connection.expiresAt, now) <= EXPIRY_WARNING_MS;
}

/**
 * The `StatusDot` status of an entry: working green, not connected a hollow
 * ring, reconnect (or access about to end) amber, unavailable red.
 *
 * @param {Object} entry
 * @param {number} [now=Date.now()]
 * @returns {'ok'|'warn'|'error'|'off'}
 */
export function statusDotOf(entry, now = Date.now()) {
  const status = entry?.connection?.status;
  if (status === 'unavailable') return 'error';
  if (status === 'not_connected') return 'off';
  if (needsAttention(entry, now)) return 'warn';
  return 'ok';
}

/**
 * The action a row offers for a personal sign-in: `connect`, `reconnect`,
 * `disconnect`, or null (nothing for the user to do).
 *
 * @param {Object} entry
 * @returns {'connect'|'reconnect'|'disconnect'|null}
 */
export function primaryActionOf(entry) {
  const connection = entry?.connection || {};
  if (connection.mode !== 'personal') return null;
  switch (connection.status) {
    case 'not_connected':
      return connection.connectable === false ? null : 'connect';
    case 'needs_reconnect':
      return 'reconnect';
    case 'connected':
      return 'disconnect';
    default:
      return null;
  }
}

/** Whether the user holds a connection they can remove (connected or waiting for a reconnect). */
export function canDisconnect(entry) {
  const connection = entry?.connection || {};
  return (
    connection.mode === 'personal' &&
    (connection.status === 'connected' || connection.status === 'needs_reconnect')
  );
}

/** The names of the groups that share an account or key, joined. */
function groupNames(connection) {
  return (Array.isArray(connection?.sharedWith) ? connection.sharedWith : [])
    .map(group => group?.name || group?.id)
    .filter(Boolean)
    .join(', ');
}

/**
 * Why a reconnect is needed, in words.
 * @param {string|null} reason - `expired` or `insufficient_scope`
 * @param {Function} t
 */
function reconnectReason(reason, t) {
  if (reason === 'insufficient_scope') {
    return t(
      'integrations.page.status.reconnectReasons.insufficientScope',
      'a new permission is needed'
    );
  }
  return t(
    'integrations.page.status.reconnectReasons.expired',
    'your sign-in expired or was revoked'
  );
}

/**
 * Why an integration is unavailable and what an admin must do, in words.
 * @param {string|null} reason - see `UNAVAILABLE_REASONS` on the server
 * @param {Function} t
 */
export function unavailableReason(reason, t) {
  switch (reason) {
    case 'credential_rejected':
      return t(
        'integrations.page.status.unavailableReasons.credentialRejected',
        'the shared key was refused or has expired; an administrator must renew it'
      );
    case 'credential_missing':
      return t(
        'integrations.page.status.unavailableReasons.credentialMissing',
        'the shared key is missing; an administrator must set it'
      );
    case 'not_configured':
      return t(
        'integrations.page.status.unavailableReasons.notConfigured',
        'the sign-in is not set up; an administrator must finish it'
      );
    default:
      return t(
        'integrations.page.status.unavailableReasons.unreachable',
        'the system cannot be reached; an administrator must check it'
      );
  }
}

/**
 * The status line of a row: who iHub acts as, in the user's words.
 *
 * - `Connected as <account> · expires in N days` (expiry only when it does not renew)
 * - `Signed in via SSO`, `Runs as service account (<groups>)`, `Shared key`,
 *   `No sign-in needed`
 * - `Not connected`, `Reconnect needed · <reason>`, `Unavailable · <admin action>`
 *
 * @param {Object} entry
 * @param {Function} t
 * @param {Object} [options]
 * @param {string} [options.language]
 * @param {number} [options.now=Date.now()]
 * @returns {string}
 */
export function statusText(entry, t, { language, now = Date.now() } = {}) {
  const connection = entry?.connection || {};
  switch (connection.status) {
    case 'connected': {
      const who = connection.account
        ? t('integrations.page.status.connectedAs', 'Connected as {{account}}', {
            account: connection.account
          })
        : t('integrations.page.status.connected', 'Connected');
      if (!accessExpires(connection)) return who;
      return `${who} · ${t('integrations.page.status.expires', 'expires {{when}}', {
        when: relativeTime(connection.expiresAt, language, now)
      })}`;
    }
    case 'not_connected':
      return t('integrations.page.status.notConnected', 'Not connected');
    case 'needs_reconnect':
      return t('integrations.page.status.needsReconnect', 'Reconnect needed · {{reason}}', {
        reason: reconnectReason(connection.reason, t)
      });
    case 'sso':
      return t('integrations.page.status.sso', 'Signed in via SSO');
    case 'service_account': {
      const groups = groupNames(connection);
      return groups
        ? t('integrations.page.status.serviceAccountFor', 'Runs as service account ({{groups}})', {
            groups
          })
        : t('integrations.page.status.serviceAccount', 'Runs as service account');
    }
    case 'shared_key':
      return t('integrations.page.status.sharedKey', 'Shared key');
    case 'none':
      return t('integrations.page.status.none', 'No sign-in needed');
    case 'unavailable':
      return t('integrations.page.status.unavailable', 'Unavailable · {{reason}}', {
        reason: unavailableReason(connection.reason, t)
      });
    default:
      return t('integrations.page.status.unknown', 'Status unknown');
  }
}

/**
 * A short summary of what an integration can do: up to three action titles
 * ("Search issues, Add comment, +4 more"), else its capabilities in words.
 *
 * @param {Object} entry
 * @param {Function} t
 * @returns {string}
 */
export function capabilitySummary(entry, t) {
  const titles = (Array.isArray(entry?.actions) ? entry.actions : [])
    .map(action => action?.title || action?.name)
    .filter(Boolean);
  if (titles.length > 0) {
    const shown = titles.slice(0, 3);
    if (titles.length > 3) {
      shown.push(
        t('integrations.page.moreActions', '+{{count}} more', { count: titles.length - 3 })
      );
    }
    return shown.join(', ');
  }
  return (Array.isArray(entry?.capabilities) ? entry.capabilities : [])
    .map(capability => capabilityLabel(capability, t))
    .join(', ');
}

/** A capability (`tools`, `files`, `search`, …) in words. */
export function capabilityLabel(capability, t) {
  const defaults = {
    tools: 'Actions in chat',
    files: 'Files',
    search: 'Search',
    views: 'Interactive views',
    triggers: 'Events',
    agent: 'Agent'
  };
  return t(`integrations.page.capabilities.${capability}`, defaults[capability] || capability);
}

/** A definition category tag (`productivity`, `open-data`) in words. */
export function categoryLabel(category, t) {
  const fallback = String(category || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return t(`integrations.page.categories.${category}`, fallback);
}

/**
 * The categories present in a list of entries, sorted by their label.
 *
 * @param {Object[]} entries
 * @param {Function} t
 * @returns {Array<{value: string, label: string}>}
 */
export function categoryOptions(entries, t) {
  const values = new Set();
  for (const entry of entries || []) {
    for (const category of entry?.categories || []) if (category) values.add(category);
  }
  return [...values]
    .map(value => ({ value, label: categoryLabel(value, t) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The entries that match the search text (name, description, action titles,
 * status line), the category and the status filter.
 *
 * @param {Object[]} entries
 * @param {Object} filters
 * @param {string} [filters.query]
 * @param {string} [filters.category] - empty for all
 * @param {string} [filters.status] - one of {@link STATUS_FILTERS}
 * @param {Function} t
 * @param {Object} [options] - passed to {@link statusText}
 * @returns {Object[]}
 */
export function filterIntegrations(
  entries,
  { query = '', category = '', status = 'all' },
  t,
  options = {}
) {
  const needle = query.trim().toLowerCase();
  return (entries || []).filter(entry => {
    if (category && !(entry.categories || []).includes(category)) return false;
    if (status === STATUS_FILTERS.ATTENTION && !needsAttention(entry, options.now)) return false;
    if (!needle) return true;
    const haystack = [
      entry.name,
      entry.description,
      ...(entry.actions || []).map(action => action?.title),
      statusText(entry, t, options)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

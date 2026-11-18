// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first day the audit cleanup keeps, as shown in its confirmation
 * ("Delete audit entries older than {{date}}?").
 *
 * The server (`AuditLogService.cleanupAuditLog`) names its daily files by the
 * UTC date and deletes the files dated strictly before the UTC date of
 * `now - retentionDays`. The label therefore formats that UTC date; a local
 * date would be a day off for admins east or west of UTC near midnight.
 *
 * @param {number} retentionDays - Retention period of the audit policy.
 * @param {number} [nowMs=Date.now()] - Current time (for tests).
 * @param {string|string[]} [locale] - Display locale (default: the browser's).
 * @returns {string} The cut-off date, formatted for the locale.
 *
 * @example
 * auditCleanupCutoffLabel(30, Date.UTC(2026, 10, 17, 0, 30), 'en-CA') // '2026-10-18'
 */
export function auditCleanupCutoffLabel(retentionDays, nowMs = Date.now(), locale = undefined) {
  return new Date(nowMs - retentionDays * DAY_MS).toLocaleDateString(locale, { timeZone: 'UTC' });
}

export default auditCleanupCutoffLabel;

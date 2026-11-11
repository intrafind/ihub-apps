// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI-use acknowledgement (#3326): settings, versioning rule, status of a user,
 * the counts and the CSV rows. Route handlers stay thin; #3329 reads the same
 * `summary()`.
 *
 * Rule: an acknowledgement is valid when the user has an entry whose `version`
 * is at least `requiredVersion`. Editing the text never changes the version; only
 * the admin action "request again" does.
 *
 * @module services/aiAcknowledgement/aiAcknowledgementService
 */
import crypto from 'node:crypto';
import configCache from '../../configCache.js';
import { loadUsers } from '../../utils/userManager.js';
import { localUsersFile } from '../../utils/contentsPath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { LANGUAGE_CODE_PATTERN } from '../../../shared/validationPatterns.js';

/** Built-in text for when the admin cleared every language. */
export const FALLBACK_TEXT = Object.freeze({
  en: "This platform uses AI systems. Their answers can be incorrect or incomplete. Please use them responsibly and follow your organisation's AI policy.",
  de: 'Diese Plattform nutzt KI-Systeme. Deren Antworten können falsch oder unvollständig sein. Bitte nutzen Sie sie verantwortungsvoll und beachten Sie die KI-Richtlinie Ihrer Organisation.'
});

/**
 * Whether a policy URL may be rendered as a link: empty, http(s) or a
 * site-relative path. Never `javascript:`, `data:` or a protocol-relative URL.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafePolicyUrl(value) {
  return (
    typeof value === 'string' &&
    value.length <= 2000 &&
    (value === '' || /^(https?:\/\/\S+|\/(?!\/)\S*)$/i.test(value))
  );
}

/**
 * The platform's acknowledgement settings with defaults applied.
 *
 * @param {Object} [platform] - Platform config; defaults to the cached one
 * @returns {{enabled: boolean, enforce: boolean, requiredVersion: number, resetAt: string|null, text: Object<string,string>, policyUrl: string}}
 */
export function getSettings(platform = configCache.getPlatform() || {}) {
  const raw = platform.aiAcknowledgement || {};
  const version = Number.isInteger(raw.requiredVersion) && raw.requiredVersion >= 1;
  return {
    enabled: raw.enabled !== false,
    enforce: raw.enforce !== false,
    requiredVersion: version ? raw.requiredVersion : 1,
    resetAt: typeof raw.resetAt === 'string' ? raw.resetAt : null,
    text: raw.text && typeof raw.text === 'object' ? raw.text : {},
    policyUrl: isSafePolicyUrl(raw.policyUrl) ? raw.policyUrl : ''
  };
}

/** @returns {string} Path of users.json as configured. */
export function usersFilePath(platform = configCache.getPlatform() || {}) {
  return localUsersFile(platform.localAuth);
}

/**
 * The text a user sees in `language`: that language, then the platform default
 * language, English, then any other non-empty one, then the built-in text.
 *
 * @param {Object} settings - See {@link getSettings}
 * @param {string} [language]
 * @param {string} [defaultLanguage]
 * @returns {{text: string, language: string}}
 */
export function resolveText(settings, language, defaultLanguage = 'en') {
  const texts = settings.text || {};
  // Own properties only: `language` comes from a query string (`constructor`, `toString`, ...).
  const usable = code =>
    Object.hasOwn(texts, code) && typeof texts[code] === 'string' && texts[code].trim() !== '';
  const order = [language, defaultLanguage, 'en', ...Object.keys(texts)].filter(Boolean);
  const code = order.find(usable);
  if (code) return { text: texts[code], language: code };
  const builtIn = [language, defaultLanguage].find(c => Object.hasOwn(FALLBACK_TEXT, c)) || 'en';
  return { text: FALLBACK_TEXT[builtIn], language: builtIn };
}

/**
 * Hash of the exact text a user was shown.
 *
 * @param {string} text
 * @returns {string} `sha256:<hex>`
 */
export function textHash(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

/** @returns {Object[]} The user's entries, newest version last. */
function entriesOf(user) {
  return Array.isArray(user?.aiAcknowledgements)
    ? user.aiAcknowledgements.filter(entry => Number.isInteger(entry?.version))
    : [];
}

/**
 * The newest entry of a user, or null.
 *
 * @param {Object} user - users.json record
 * @returns {Object|null}
 */
export function latestEntry(user) {
  return entriesOf(user).reduce(
    (best, entry) => (!best || entry.version > best.version ? entry : best),
    null
  );
}

/**
 * Whether a user's acknowledgement counts for the current policy version.
 *
 * @param {Object} user - users.json record
 * @param {{requiredVersion: number, resetAt?: string|null}} settings
 * @returns {boolean}
 */
export function isAcknowledged(user, settings) {
  const reset = settings.resetAt ? Date.parse(settings.resetAt) : NaN;
  return entriesOf(user).some(
    entry =>
      entry.version >= settings.requiredVersion &&
      // "Remove all" sets `resetAt`. An entry from before it does not count even if a stale
      // whole-file write of users.json brought it back.
      (!Number.isFinite(reset) || !(Date.parse(entry.acknowledgedAt) < reset))
  );
}

/**
 * `acknowledged`, `outdated` (only older versions) or `never`.
 *
 * @param {Object} user - users.json record
 * @param {{requiredVersion: number}} settings
 * @returns {'acknowledged'|'outdated'|'never'}
 */
export function statusOfUser(user, settings) {
  if (isAcknowledged(user, settings)) return 'acknowledged';
  return entriesOf(user).length > 0 ? 'outdated' : 'never';
}

/**
 * Principals that are machines: OAuth clients, personal API keys, delegated
 * tokens and agents. A person cannot click a dialog there, so they are exempt.
 *
 * @param {Object} [user] - `req.user`
 * @returns {boolean}
 */
export function isMachinePrincipal(user) {
  return Boolean(
    user && (user.isOAuthClient || user.isPersonalApiKey || user.clientId || user.isAgent === true)
  );
}

/**
 * Counts for the admin overview: users with a current acknowledgement,
 * the rest, and the total. Anonymous guests are not counted (no record).
 *
 * @param {Object} [options]
 * @param {Object} [options.platform]
 * @returns {{enabled: boolean, enforce: boolean, requiredVersion: number, acknowledged: number, pending: number, total: number}}
 */
export function summary({ platform = configCache.getPlatform() || {} } = {}) {
  const settings = getSettings(platform);
  const users = loadUsers(usersFilePath(platform)).users || {};
  let acknowledged = 0;
  const ids = Object.keys(users);
  for (const id of ids) if (isAcknowledged(users[id], settings)) acknowledged += 1;
  return {
    enabled: settings.enabled,
    enforce: settings.enforce,
    requiredVersion: settings.requiredVersion,
    acknowledged,
    pending: ids.length - acknowledged,
    total: ids.length
  };
}

/** CSV columns of the export. No email (data minimisation). */
export const CSV_HEADERS = Object.freeze([
  'userId',
  'username',
  'name',
  'authMethods',
  'active',
  'status',
  'version',
  'acknowledgedAt',
  'textHash',
  'requiredVersion'
]);

/**
 * The rows of the CSV export, every user of users.json (filtered by `status`):
 * `acknowledged` keeps users with a current acknowledgement, `pending` everyone
 * else, no filter keeps all.
 *
 * @param {'acknowledged'|'pending'|undefined} status
 * @param {Object} [options]
 * @param {Object} [options.platform]
 * @returns {Array<Array<*>>}
 */
export function buildCsvRows(status, { platform = configCache.getPlatform() || {} } = {}) {
  const settings = getSettings(platform);
  const users = loadUsers(usersFilePath(platform)).users || {};
  const rows = [];
  for (const [id, user] of Object.entries(users)) {
    const state = statusOfUser(user, settings);
    if (status === 'acknowledged' && state !== 'acknowledged') continue;
    if (status === 'pending' && state === 'acknowledged') continue;
    const entry = latestEntry(user);
    rows.push([
      id,
      user.username ?? '',
      user.name ?? user.fullName ?? '',
      Array.isArray(user.authMethods) ? user.authMethods.join(' ') : '',
      user.active !== false,
      state,
      entry?.version ?? '',
      entry?.acknowledgedAt ?? '',
      entry?.textHash ?? '',
      settings.requiredVersion
    ]);
  }
  return rows;
}

/**
 * The `aiAcknowledgement` block to store after an admin settings save.
 *
 * Only `enabled`, `enforce`, `text` and `policyUrl` come from the form.
 * `requiredVersion` and `resetAt` are server-owned (written only by "request
 * again" and "remove all"), so they always come from the stored block: a stale
 * form value must never lower the version and silently re-validate everyone.
 *
 * @param {Object|undefined} incoming - `aiAcknowledgement` of the request, if any
 * @param {Object|undefined} stored - The stored block
 * @returns {Object|undefined} The block to store; `stored` when the request has none
 * @throws {ServiceError} `BAD_REQUEST` for a malformed block or an unsafe URL
 */
export function mergeSettingsForSave(incoming, stored) {
  if (incoming === undefined) return stored;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new ServiceError('BAD_REQUEST', 'aiAcknowledgement must be an object');
  }
  if (incoming.enabled !== undefined && typeof incoming.enabled !== 'boolean') {
    throw new ServiceError('BAD_REQUEST', 'aiAcknowledgement.enabled must be a boolean');
  }
  if (incoming.enforce !== undefined && typeof incoming.enforce !== 'boolean') {
    throw new ServiceError('BAD_REQUEST', 'aiAcknowledgement.enforce must be a boolean');
  }
  if (incoming.policyUrl !== undefined && !isSafePolicyUrl(incoming.policyUrl)) {
    throw new ServiceError(
      'BAD_REQUEST',
      'aiAcknowledgement.policyUrl must be empty, an http(s) URL or a path starting with /'
    );
  }
  if (incoming.text !== undefined) {
    const text = incoming.text;
    const valid =
      text &&
      typeof text === 'object' &&
      !Array.isArray(text) &&
      Object.entries(text).every(
        ([code, value]) =>
          LANGUAGE_CODE_PATTERN.test(code) && typeof value === 'string' && value.length <= 5000
      );
    if (!valid) {
      throw new ServiceError(
        'BAD_REQUEST',
        'aiAcknowledgement.text must map language codes to strings of at most 5000 characters'
      );
    }
  }
  const before = stored && typeof stored === 'object' ? stored : {};
  const merged = { ...before };
  for (const key of ['enabled', 'enforce', 'text', 'policyUrl']) {
    if (incoming[key] !== undefined) merged[key] = incoming[key];
  }
  if (before.requiredVersion !== undefined) merged.requiredVersion = before.requiredVersion;
  else delete merged.requiredVersion;
  if (before.resetAt !== undefined) merged.resetAt = before.resetAt;
  else delete merged.resetAt;
  return merged;
}

/**
 * What changed between two stored blocks, for the audit entry.
 *
 * @param {Object|undefined} before
 * @param {Object|undefined} after
 * @returns {{changed: string[], textHashes: Object<string,string>}|null} null when nothing changed
 */
export function describeSettingsChange(before, after) {
  const a = getSettings({ aiAcknowledgement: before });
  const b = getSettings({ aiAcknowledgement: after });
  const changed = [];
  for (const key of ['enabled', 'enforce', 'policyUrl']) if (a[key] !== b[key]) changed.push(key);
  const hashes = settings =>
    Object.fromEntries(
      Object.entries(settings.text).map(([code, value]) => [code, textHash(value)])
    );
  const hashesBefore = hashes(a);
  const hashesAfter = hashes(b);
  if (JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfter)) changed.push('text');
  return changed.length ? { changed, textHashes: hashesAfter } : null;
}

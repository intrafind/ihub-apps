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
import { isEuAiActEnabled } from '../euAiAct/conformity.js';
import crypto from 'node:crypto';
import configCache from '../../configCache.js';
import { loadUsers } from '../../utils/userManager.js';
import { getAiAcknowledgementRepository } from './AiAcknowledgementRepository.js';
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
 * @returns {{enabled: boolean, configuredEnabled: boolean, enforce: boolean, requiredVersion: number, resetAt: string|null, text: Object<string,string>, policyUrl: string}}
 *   `enabled` is the effective value: the admin's setting AND the EU AI Act master switch.
 *   One edit here covers the 428 guard, `GET/POST /me`, the summary and the public config.
 *   `configuredEnabled` is what the admin configured; forms and the status page show it.
 */
export function getSettings(platform = configCache.getPlatform() || {}) {
  const raw = platform.aiAcknowledgement || {};
  const version = Number.isInteger(raw.requiredVersion) && raw.requiredVersion >= 1;
  return {
    enabled: isEuAiActEnabled() && raw.enabled !== false,
    configuredEnabled: raw.enabled !== false,
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

/** @returns {Object[]} The record's entries, newest version last. */
function entriesOf(record) {
  return Array.isArray(record?.aiAcknowledgements)
    ? record.aiAcknowledgements.filter(entry => Number.isInteger(entry?.version))
    : [];
}

/**
 * The entries of a record that "Remove all" left standing: those confirmed at
 * or after `resetAt`. An older one is removed (a background pass deletes it,
 * and so does the user's next confirmation); until then it is treated as gone.
 *
 * @param {Object|null} record - A user's acknowledgement document (see
 *   `AiAcknowledgementRepository`), or anything with `aiAcknowledgements`
 * @param {{resetAt?: string|null}} [settings]
 * @returns {Object[]}
 */
export function currentEntries(record, settings = {}) {
  const reset = settings.resetAt ? Date.parse(settings.resetAt) : NaN;
  if (!Number.isFinite(reset)) return entriesOf(record);
  return entriesOf(record).filter(entry => !(Date.parse(entry.acknowledgedAt) < reset));
}

/**
 * The newest current entry of a record, or null.
 *
 * @param {Object|null} record - See {@link currentEntries}
 * @param {{resetAt?: string|null}} [settings]
 * @returns {Object|null}
 */
export function latestEntry(record, settings) {
  return currentEntries(record, settings).reduce(
    (best, entry) => (!best || entry.version > best.version ? entry : best),
    null
  );
}

/**
 * Whether a user's acknowledgement counts for the current policy version.
 *
 * @param {Object|null} record - See {@link currentEntries}
 * @param {{requiredVersion: number, resetAt?: string|null}} settings
 * @returns {boolean}
 */
export function isAcknowledged(record, settings) {
  return currentEntries(record, settings).some(entry => entry.version >= settings.requiredVersion);
}

/**
 * `acknowledged`, `outdated` (only older versions) or `never`.
 *
 * @param {Object|null} record - See {@link currentEntries}
 * @param {{requiredVersion: number, resetAt?: string|null}} settings
 * @returns {'acknowledged'|'outdated'|'never'}
 */
export function statusOfUser(record, settings) {
  if (isAcknowledged(record, settings)) return 'acknowledged';
  return currentEntries(record, settings).length > 0 ? 'outdated' : 'never';
}

/**
 * The first-party clients a person types into: the Outlook add-in, the browser
 * extension and the Nextcloud embed. Each signs in with a delegated OAuth token
 * (authorization code + PKCE) that carries the client id the admin configured
 * under `officeIntegration`, `browserExtension` and `nextcloudEmbed`
 * (`oauthClientId`). They show the acknowledgement dialog, so they count as
 * people. A small, explicit allow-list: every other client id stays a machine.
 */
const FIRST_PARTY_CLIENTS = Object.freeze([
  { kind: 'office', platformKey: 'officeIntegration' },
  { kind: 'extension', platformKey: 'browserExtension' },
  { kind: 'nextcloud', platformKey: 'nextcloudEmbed' }
]);

/**
 * Which first-party client a delegated token's client id belongs to.
 *
 * @param {string|null|undefined} clientId - `req.user.clientId`
 * @param {Object} [platform] - Platform config; defaults to the cached one
 * @returns {'office'|'extension'|'nextcloud'|null} null for any other client
 */
export function firstPartyClientKind(clientId, platform = configCache.getPlatform() || {}) {
  if (typeof clientId !== 'string' || clientId === '') return null;
  const match = FIRST_PARTY_CLIENTS.find(({ platformKey }) => {
    const configured = platform?.[platformKey]?.oauthClientId;
    return typeof configured === 'string' && configured !== '' && configured === clientId;
  });
  return match ? match.kind : null;
}

/**
 * Principals that are machines: OAuth clients, personal API keys, third-party
 * delegated tokens and agents. A person cannot click a dialog there, so they
 * are exempt.
 *
 * A delegated (authorization code) token of one of the three first-party
 * clients is a person: those clients show the dialog (see
 * {@link firstPartyClientKind}). A token of the same client id that was not
 * issued to a user (client credentials) stays a machine.
 *
 * @param {Object} [user] - `req.user`
 * @param {Object} [platform] - Platform config; defaults to the cached one
 * @returns {boolean}
 */
export function isMachinePrincipal(user, platform = configCache.getPlatform() || {}) {
  if (!user) return false;
  if (user.isOAuthClient || user.isPersonalApiKey || user.isAgent === true) return true;
  if (!user.clientId) return false;
  return !(user.isOAuthAuthCode && firstPartyClientKind(user.clientId, platform));
}

/**
 * Counts for the admin overview: users with a current acknowledgement,
 * the rest, and the total. Users come from users.json, their state from the
 * acknowledgement documents (one listing). Anonymous guests are not counted.
 *
 * @param {Object} [options]
 * @param {Object} [options.platform]
 * @returns {Promise<{enabled: boolean, enforce: boolean, requiredVersion: number, acknowledged: number, pending: number, total: number}>}
 */
export async function summary({ platform = configCache.getPlatform() || {} } = {}) {
  const settings = getSettings(platform);
  const users = loadUsers(usersFilePath(platform)).users || {};
  const records = await getAiAcknowledgementRepository().listAll();
  let acknowledged = 0;
  const ids = Object.keys(users);
  for (const id of ids) if (isAcknowledged(records.get(id)?.data, settings)) acknowledged += 1;
  return {
    enabled: settings.enabled,
    configuredEnabled: settings.configuredEnabled,
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
 * The rows of the CSV export, every user of users.json (filtered by `status`),
 * with the state of their acknowledgement document:
 * `acknowledged` keeps users with a current acknowledgement, `pending` everyone
 * else, no filter keeps all.
 *
 * @param {'acknowledged'|'pending'|undefined} status
 * @param {Object} [options]
 * @param {Object} [options.platform]
 * @returns {Promise<Array<Array<*>>>}
 */
export async function buildCsvRows(status, { platform = configCache.getPlatform() || {} } = {}) {
  const settings = getSettings(platform);
  const users = loadUsers(usersFilePath(platform)).users || {};
  const records = await getAiAcknowledgementRepository().listAll();
  const rows = [];
  for (const [id, user] of Object.entries(users)) {
    const record = records.get(id)?.data;
    const state = statusOfUser(record, settings);
    if (status === 'acknowledged' && state !== 'acknowledged') continue;
    if (status === 'pending' && state === 'acknowledged') continue;
    const entry = latestEntry(record, settings);
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
  // The configured value, not the effective one: a save while the master switch is off still
  // changes `enabled`.
  if (a.configuredEnabled !== b.configuredEnabled) changed.push('enabled');
  for (const key of ['enforce', 'policyUrl']) if (a[key] !== b[key]) changed.push(key);
  const hashes = settings =>
    Object.fromEntries(
      Object.entries(settings.text).map(([code, value]) => [code, textHash(value)])
    );
  const hashesBefore = hashes(a);
  const hashesAfter = hashes(b);
  if (JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfter)) changed.push('text');
  return changed.length ? { changed, textHashes: hashesAfter } : null;
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a user's new chats of an app start with (#2923, concept
 * `2026-10-20 Unified Integrations/03-product-concept.md` §7.2): the
 * integrations switched on, web search, and the scope picked per integration.
 *
 * Two levels of state, both on the server:
 *
 * - **this one**, the per-user default for each app, one document per
 *   (user, app) in the namespace `integration-preferences`, keyed
 *   `ip_<hash(userId)>__<appId>` and owned by the user, so it follows the user
 *   to another browser;
 * - **the chat's own copy**, stored with the chat's settings
 *   (`ChatRepository.normalizeChatSettings`: `enabledTools`,
 *   `websearchEnabled`, `integrationScopes`).
 *
 * A new chat starts from this default and from then on changes only its own
 * copy. Scheduled tasks and workflows keep their own set, taken when they are
 * created; nothing but a new chat reads this document.
 *
 * The default is stored with the tool references the app offered when it was
 * saved (`knownRefs`): a reference the app has added since is on, as it is for
 * a user who never saved a default, instead of being off because the stored
 * list predates it.
 *
 * @module services/integrations/IntegrationPreferencesRepository
 */
import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { normalizeChatSettings } from '../chat/ChatRepository.js';

/** Namespace holding the per-user, per-app defaults. */
export const INTEGRATION_PREFERENCES_NAMESPACE = RUNTIME_NAMESPACES.integrationPreferences;

/** Schema version stamped on every document written here. */
export const INTEGRATION_PREFERENCES_VERSION = 1;

/** Most references kept in `knownRefs` (the app's offer when saved). */
const MAX_KNOWN_REFS = 200;

/** Lock lease for one write. */
const LOCK_OPTIONS = { ttlMs: 15000, waitMs: 5000 };

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

/**
 * Key prefix of every document of one user.
 * @param {string} userId
 * @returns {string}
 */
export function preferencesKeyPrefix(userId) {
  return `ip_${digest(userId)}__`;
}

/**
 * Key of one user's default for one app.
 * @param {string} userId
 * @param {string} appId
 * @returns {string}
 */
export function preferencesKey(userId, appId) {
  return `${preferencesKeyPrefix(userId)}${appId}`;
}

/**
 * The storable part of a default: the three keys a chat stores for its
 * integrations, normalized the way the chat normalizes them (same caps, same
 * id rules), so a default can always become a chat's settings unchanged.
 *
 * @param {unknown} value
 * @returns {{enabledTools?: string[], websearchEnabled?: boolean, integrationScopes?: Object<string, string>}}
 */
export function normalizePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const picked = {};
  for (const key of ['enabledTools', 'websearchEnabled', 'integrationScopes']) {
    if (Object.hasOwn(value, key)) picked[key] = value[key];
  }
  const normalized = normalizeChatSettings(picked) || {};
  // An empty list is a choice ("nothing on"), which `normalizeChatSettings`
  // keeps; an absent one means "the app's default".
  return normalized;
}

/**
 * The default a new chat of the app starts with: the stored one merged over
 * the app's own defaults. A reference the app offers now but did not offer
 * when the default was saved is on.
 *
 * @param {Object|null} stored - The stored document's data, or null
 * @param {Object} appDefaults - `{ enabledTools: string[], websearchEnabled: boolean }`
 * @returns {{enabledTools: string[], websearchEnabled: boolean, integrationScopes: Object<string, string>}}
 */
export function effectivePreferences(stored, appDefaults) {
  const offered = Array.isArray(appDefaults?.enabledTools) ? appDefaults.enabledTools : [];
  const base = {
    enabledTools: [...offered],
    websearchEnabled: appDefaults?.websearchEnabled === true,
    integrationScopes: {}
  };
  if (!stored) return base;
  const known = new Set(Array.isArray(stored.knownRefs) ? stored.knownRefs : []);
  if (Array.isArray(stored.enabledTools)) {
    const added = offered.filter(ref => !known.has(ref));
    base.enabledTools = [...new Set([...stored.enabledTools, ...added])];
  }
  if (typeof stored.websearchEnabled === 'boolean') base.websearchEnabled = stored.websearchEnabled;
  if (stored.integrationScopes && typeof stored.integrationScopes === 'object') {
    base.integrationScopes = { ...stored.integrationScopes };
  }
  return base;
}

/**
 * Per-user, per-app defaults on top of the storage abstraction.
 */
export class IntegrationPreferencesRepository {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.documents] - Document facet; null makes every method a no-op
   * @param {Object|null} [options.locks] - Lock facet; null makes every method a no-op
   * @param {Object} [options.logger]
   */
  constructor({ documents = null, locks = null, logger: log } = {}) {
    this.documents = documents || null;
    this.locks = locks || null;
    this.logger = log || logger;
  }

  /** Whether this repository can store anything. */
  isAvailable() {
    return Boolean(this.documents && this.locks);
  }

  /**
   * One user's stored default for an app, or null when none is stored.
   *
   * @param {string} userId
   * @param {string} appId
   * @returns {Promise<Object|null>} `{ enabledTools?, knownRefs, websearchEnabled?, integrationScopes?, updatedAt }`
   */
  async get(userId, appId) {
    if (!this.isAvailable() || !userId || !isValidId(appId)) return null;
    const doc = await this.documents.get(
      INTEGRATION_PREFERENCES_NAMESPACE,
      preferencesKey(userId, appId)
    );
    const data = doc?.data;
    // The key is a hash: the document must name the same user and app.
    if (!data || String(data.userId) !== String(userId) || data.appId !== appId) return null;
    return data;
  }

  /**
   * Replace one user's default for an app.
   *
   * @param {string} userId
   * @param {string} appId
   * @param {Object} preferences - `{ enabledTools?, websearchEnabled?, integrationScopes? }`
   * @param {Object} [options]
   * @param {string[]} [options.knownRefs] - The references the app offers now
   * @param {boolean} [options.onlyIfAbsent=false] - Write only when nothing is
   *   stored yet (the one-time import from the browser); answers the stored
   *   document unchanged otherwise
   * @returns {Promise<{stored: Object|null, written: boolean}>}
   */
  async set(userId, appId, preferences, { knownRefs = [], onlyIfAbsent = false } = {}) {
    if (!this.isAvailable() || !userId || !isValidId(appId)) {
      return { stored: null, written: false };
    }
    const key = preferencesKey(userId, appId);
    return this.locks.withLock(
      `integration-preferences:${key}`,
      async () => {
        const doc = await this.documents.get(INTEGRATION_PREFERENCES_NAMESPACE, key);
        const current =
          doc?.data && String(doc.data.userId) === String(userId) && doc.data.appId === appId
            ? doc.data
            : null;
        if (onlyIfAbsent && current) return { stored: current, written: false };
        const next = {
          version: INTEGRATION_PREFERENCES_VERSION,
          userId: String(userId),
          appId,
          ...normalizePreferences(preferences),
          knownRefs: [...new Set((knownRefs || []).filter(ref => typeof ref === 'string'))].slice(
            0,
            MAX_KNOWN_REFS
          ),
          updatedAt: new Date().toISOString()
        };
        await this.documents.put(INTEGRATION_PREFERENCES_NAMESPACE, key, next, {
          ownerId: String(userId),
          etag: doc ? doc.etag : null
        });
        return { stored: next, written: true };
      },
      LOCK_OPTIONS
    );
  }

  /**
   * Remove every default of one user (user deletion).
   *
   * @param {string} userId
   * @returns {Promise<number>} How many documents were removed
   */
  async deleteAllOfUser(userId) {
    if (!this.isAvailable() || !userId) return 0;
    const prefix = preferencesKeyPrefix(userId);
    const keys = [];
    let cursor;
    do {
      const page = await this.documents.list(INTEGRATION_PREFERENCES_NAMESPACE, {
        prefix,
        cursor,
        limit: 500,
        includeData: false
      });
      keys.push(...page.items.map(item => item.key));
      cursor = page.nextCursor || undefined;
    } while (cursor);
    let removed = 0;
    for (const key of keys) {
      if (await this.documents.delete(INTEGRATION_PREFERENCES_NAMESPACE, key)) removed += 1;
    }
    return removed;
  }
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * The process-wide repository over the bootstrapped storage provider.
 * @returns {IntegrationPreferencesRepository}
 */
export function getIntegrationPreferencesRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new IntegrationPreferencesRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks'),
      logger
    });
  }
  return cachedRepository;
}

export default IntegrationPreferencesRepository;

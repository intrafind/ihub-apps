/**
 * Chat persistence policy — the single place that decides whether a chat turn
 * is written to durable storage.
 *
 * Five conditions have to hold and they live in five different subsystems:
 * the feature flag, the platform config, the storage provider, the caller's
 * identity and the per-request `ephemeral` flag. Re-deriving that anywhere
 * else guarantees the request path and the run-completion path (which happens
 * with no request in scope) eventually disagree, and a chat that half-persists
 * is worse than one that never does.
 *
 * The module is deliberately import-light — no `configCache`, no repository —
 * because `RunLog` imports it to couple the ledger to chat persistence, and
 * `RunLog` is itself imported by half the tree. Everything here is a pure
 * function over configuration the caller has already loaded.
 *
 * @module services/chat/chatPersistence
 */
import { featureRegistry, isFeatureEnabled } from '../../featureRegistry.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { isStorageReady } from '../../storage/bootstrap.js';

/** Feature flag that gates durable chats. */
export const CHAT_PERSISTENCE_FEATURE = 'chatPersistence';

/** Days a chat is kept when `platform.chats.retentionDays` says nothing. */
export const DEFAULT_CHAT_RETENTION_DAYS = 90;

/** Chats kept per owner when `platform.chats.maxChatsPerUser` says nothing. */
export const DEFAULT_MAX_CHATS_PER_USER = 200;

/**
 * Read a numeric setting, keeping zero and negative values — both are
 * meaningful ("disable this rule") and must survive as written.
 *
 * @param {unknown} value - Configured value.
 * @param {number} fallback - Default for a missing or unparseable value.
 * @returns {number}
 */
function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Whether the flag exists in the registry.
 *
 * `isFeatureEnabled` answers `true` for an id it does not know, so a missing
 * registry entry — a typo, or a build where the entry did not ship — would
 * silently turn durable persistence on for every installation. A preview
 * feature has to fail closed instead.
 *
 * @param {string} featureId - Feature id.
 * @returns {boolean}
 */
function isFeatureRegistered(featureId) {
  return featureRegistry.some(entry => entry.id === featureId);
}

/**
 * Whether the installation is set up for durable chats: the feature flag is
 * on, `platform.chats` is not switched off, and a storage provider came up.
 *
 * This is the caller-independent half of the policy — it says nothing about
 * who is asking or whether this particular turn is ephemeral.
 *
 * @param {Object} [features] - Resolved feature flags (`features.json`).
 * @param {Object} [platformConfig] - Platform configuration.
 * @param {() => boolean} [storageReady=isStorageReady] - Storage readiness
 *   predicate. Injectable so a test can drive the policy without booting a
 *   provider.
 * @returns {boolean}
 */
export function isChatPersistenceConfigured(
  features,
  platformConfig,
  storageReady = isStorageReady
) {
  if (!isFeatureRegistered(CHAT_PERSISTENCE_FEATURE)) return false;
  if (!isFeatureEnabled(CHAT_PERSISTENCE_FEATURE, features || {})) return false;
  if (platformConfig?.chats?.enabled === false) return false;
  return storageReady() === true;
}

/**
 * Whether this turn is persisted: the installation is configured for it, the
 * caller is a real authenticated principal, and the turn is not ephemeral.
 *
 * Anonymous callers never persist. `resolvePrincipal` mints a fresh random
 * `anon-<hex>` id per call, so an anonymous chat could be written but never
 * listed or reloaded — storing it would only burn disk.
 *
 * @param {Object} [options]
 * @param {Object} [options.features] - Resolved feature flags.
 * @param {Object} [options.platformConfig] - Platform configuration.
 * @param {Object} [options.user] - `req.user`-like principal, or undefined.
 * @param {boolean} [options.ephemeral] - The request's ephemeral flag. Client
 *   asserted and therefore advisory: it can only ever turn persistence off.
 * @param {() => boolean} [options.storageReady] - Storage readiness predicate;
 *   see {@link isChatPersistenceConfigured}.
 * @returns {boolean}
 */
export function isChatPersistenceActive({
  features,
  platformConfig,
  user,
  ephemeral,
  storageReady
} = {}) {
  if (ephemeral === true) return false;
  if (isAnonymousUser(user)) return false;
  return isChatPersistenceConfigured(features, platformConfig, storageReady);
}

/**
 * Retention settings for stored chats.
 *
 * Both rules are disabled by a value of zero or less: `retentionDays <= 0`
 * keeps chats forever, `maxChatsPerUser <= 0` puts no cap on how many a single
 * owner keeps.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {{retentionDays: number, maxChatsPerUser: number}}
 */
export function chatRetentionSettings(platformConfig) {
  const chats = platformConfig?.chats || {};
  return {
    retentionDays: readNumber(chats.retentionDays, DEFAULT_CHAT_RETENTION_DAYS),
    maxChatsPerUser: readNumber(chats.maxChatsPerUser, DEFAULT_MAX_CHATS_PER_USER)
  };
}

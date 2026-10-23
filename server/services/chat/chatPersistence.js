// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat persistence policy — the single place that decides how a chat turn is
 * stored.
 *
 * Every chat turn is stored: the server holds the conversation and the client
 * posts one message per turn. What varies is whether the chat is *kept* — listed
 * in its owner's history and subject to the history retention rules — or
 * **temporary**: stored like any other chat, never listed or shared, and
 * deleted `chats.temporaryRetentionHours` after its last activity.
 *
 * Four things decide that and they live in four subsystems: the feature flag
 * (`chatPersistence`, shown to admins as "Chat History"), the platform config,
 * the caller's identity and the per-request `ephemeral` flag. Re-deriving it
 * anywhere else guarantees the request path and the run-completion path
 * (which happens with no request in scope) eventually disagree.
 *
 * The module is deliberately import-light — no repository — because `RunLog`
 * imports it to couple the ledger to chat storage, and `RunLog` is itself
 * imported by half the tree.
 *
 * @module services/chat/chatPersistence
 */
import { featureRegistry, isFeatureEnabled } from '../../featureRegistry.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { isStorageReady } from '../../storage/bootstrap.js';
import configCache from '../../configCache.js';

/** Feature flag that gates the chat history ("Chat History" in the admin UI). */
export const CHAT_PERSISTENCE_FEATURE = 'chatPersistence';

/** Days a chat is kept when `platform.chats.retentionDays` says nothing. */
export const DEFAULT_CHAT_RETENTION_DAYS = 90;

/** Chats kept per owner when `platform.chats.maxChatsPerUser` says nothing. */
export const DEFAULT_MAX_CHATS_PER_USER = 200;

/**
 * Messages kept in one chat when `platform.chats.maxMessagesPerChat` says
 * nothing.
 *
 * A transcript is a single document: every message rewrites, re-serializes and
 * re-hashes the whole thing, and `GET /api/chats/:id` ships all of it back
 * when the chat is opened. Prompt replay usually makes a chat unusable long
 * before the document becomes a problem — but an app with
 * `sendChatHistory: false` has no such backstop, so its chats grow for as long
 * as somebody keeps typing into them, with nothing anywhere pushing back.
 *
 * 2000 is far above any conversation a person has and far below where a
 * document becomes slow to read.
 */
export const DEFAULT_MAX_MESSAGES_PER_CHAT = 2000;

/**
 * Hours a temporary chat is kept after its last activity when
 * `platform.chats.temporaryRetentionHours` says nothing. Long enough to come
 * back to an answer after a lost connection or a reload, short enough that a
 * chat the user asked not to keep does not outlive the day.
 */
export const DEFAULT_TEMPORARY_RETENTION_HOURS = 24;

/**
 * The longest a temporary chat may be kept: 30 days. Past that it is a history
 * by another name, and a large enough value would switch expiry off.
 */
export const MAX_TEMPORARY_RETENTION_HOURS = 720;

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
 * Whether the installation keeps a chat history: the feature flag is on,
 * `platform.chats` is not switched off, and a storage provider came up.
 *
 * This is the caller-independent half of "is this chat kept" — it says nothing
 * about who is asking or whether this particular chat is temporary. Without
 * it every chat is temporary; chats are still stored, just never listed.
 *
 * @param {Object} [features] - Resolved feature flags (`features.json`).
 * @param {Object} [platformConfig] - Platform configuration.
 * @param {() => boolean} [storageReady=isStorageReady] - Storage readiness
 *   predicate. Injectable so a test can drive the policy without booting a
 *   provider.
 * @returns {boolean}
 */
export function isChatHistoryConfigured(features, platformConfig, storageReady = isStorageReady) {
  if (!isFeatureRegistered(CHAT_PERSISTENCE_FEATURE)) return false;
  if (!isFeatureEnabled(CHAT_PERSISTENCE_FEATURE, features || {})) return false;
  if (platformConfig?.chats?.enabled === false) return false;
  return storageReady() === true;
}

/**
 * Whether chats can be stored at all — a storage provider came up.
 *
 * Every chat turn needs it: there is no browser-held fallback any more, so a
 * chat request on an installation without storage is refused rather than
 * answered with a conversation nobody can continue.
 *
 * @param {() => boolean} [storageReady=isStorageReady] - Storage readiness predicate.
 * @returns {boolean}
 */
export function isChatStorageAvailable(storageReady = isStorageReady) {
  return storageReady() === true;
}

/**
 * Whether `user` can keep chats in a history: anyone but an anonymous visitor.
 *
 * A guest owns the chats it starts (through its guest cookie, see
 * `chatOwner.js`) but only as temporary ones — it has no account a history
 * could follow to another browser.
 *
 * @param {Object} [user] - `req.user`-like principal, or undefined.
 * @returns {boolean}
 */
export function canKeepChatHistory(user) {
  return !isAnonymousUser(user);
}

/**
 * How a new chat is stored: always, and temporary unless the installation
 * keeps a history, the caller can have one and the request did not ask for a
 * temporary chat.
 *
 * Only the turn that creates a chat consults this; a chat stays what it was
 * created as (`PATCH /api/chats/:id { temporary: false }` is the one way out).
 *
 * @param {Object} [options]
 * @param {Object} [options.features] - Resolved feature flags.
 * @param {Object} [options.platformConfig] - Platform configuration.
 * @param {Object} [options.user] - `req.user`-like principal, or undefined.
 * @param {boolean} [options.ephemeral] - The request's ephemeral flag. Client
 *   asserted and therefore advisory: it can only ever make a chat temporary.
 * @param {() => boolean} [options.storageReady] - Storage readiness predicate.
 * @returns {{stored: boolean, temporary: boolean}} `stored` is false only
 *   when no storage provider is available.
 */
export function resolveChatStorage({
  features,
  platformConfig,
  user,
  ephemeral,
  storageReady = isStorageReady
} = {}) {
  if (!isChatStorageAvailable(storageReady)) return { stored: false, temporary: true };
  const kept =
    ephemeral !== true &&
    canKeepChatHistory(user) &&
    isChatHistoryConfigured(features, platformConfig, storageReady);
  return { stored: true, temporary: !kept };
}

/**
 * The message cap in force right now, read from the live platform config.
 *
 * Resolved per write rather than captured at construction, so an admin who
 * lowers it does not have to restart the server for it to take effect — and
 * so the repository does not have to know where platform configuration comes
 * from.
 *
 * @returns {number} Messages one chat may keep; `<= 0` means no cap.
 */
export function chatMessageCap() {
  // `getPlatform()` already returns the config itself, not a `{ data }`
  // cache entry — reading `.data` off it silently fell back to the default.
  return chatRetentionSettings(configCache.getPlatform?.() || {}).maxMessagesPerChat;
}

/**
 * Retention settings for stored chats.
 *
 * Every rule is disabled by a value of zero or less: `retentionDays <= 0`
 * keeps chats forever, `maxChatsPerUser <= 0` puts no cap on how many a single
 * owner keeps, and `maxMessagesPerChat <= 0` lets one chat grow without bound.
 *
 * The first two are enforced by the history sweep; the third is enforced at
 * write time, because a transcript that has already grown too large to read
 * back is not something a nightly job can undo for the user who is typing into
 * it now.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * `temporaryRetentionHours` is the age at which a temporary chat goes. Unlike
 * the others it cannot be switched off — a value of zero or less falls back to
 * the default, and anything past {@link MAX_TEMPORARY_RETENTION_HOURS} is
 * capped there — because a temporary chat nobody ever deletes is exactly the
 * history its owner asked not to have.
 *
 * @returns {{retentionDays: number, maxChatsPerUser: number, maxMessagesPerChat: number, temporaryRetentionHours: number}}
 */
export function chatRetentionSettings(platformConfig) {
  const chats = platformConfig?.chats || {};
  const temporaryRetentionHours = readNumber(
    chats.temporaryRetentionHours,
    DEFAULT_TEMPORARY_RETENTION_HOURS
  );
  return {
    temporaryRetentionHours:
      temporaryRetentionHours > 0
        ? Math.min(temporaryRetentionHours, MAX_TEMPORARY_RETENTION_HOURS)
        : DEFAULT_TEMPORARY_RETENTION_HOURS,
    retentionDays: readNumber(chats.retentionDays, DEFAULT_CHAT_RETENTION_DAYS),
    maxChatsPerUser: readNumber(chats.maxChatsPerUser, DEFAULT_MAX_CHATS_PER_USER),
    maxMessagesPerChat: readNumber(chats.maxMessagesPerChat, DEFAULT_MAX_MESSAGES_PER_CHAT)
  };
}

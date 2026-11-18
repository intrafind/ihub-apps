// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Per-worker memory of users who have acknowledged the AI-use notice, so the
 * 428 guard does not read the store on every chat request.
 *
 * Only "acknowledged" is remembered, never "not yet": a user who confirms on
 * worker A must not get a 428 from worker B's memory. An entry holds the
 * `requiredVersion` and `resetAt` it was true for, so a version bump or
 * "Remove all" makes every entry miss at once. Removing one user's
 * acknowledgements forgets them here and tells the other workers over the
 * cluster bus. Other pods keep a remembered "yes" for at most
 * {@link ACKNOWLEDGEMENT_CACHE_TTL_MS}, which is accepted. A "yes" read before
 * such a forget is not remembered after it: the read may predate the removal.
 *
 * @module services/aiAcknowledgement/acknowledgementCache
 */
import { publish, subscribe } from '../../clusterBus.js';

/** How long a remembered acknowledgement counts without asking the store. */
export const ACKNOWLEDGEMENT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Most users remembered; the oldest go first. */
const MAX_ENTRIES = 20000;

/** Bus channel: a user's acknowledgements were removed on another worker. */
const FORGET_MESSAGE = 'aiAcknowledgement:forget';

/** userId → {stamp, expiresAt}, in insertion order (the oldest first). */
const remembered = new Map();

/** userId → when this worker last forgot them, in insertion order (the oldest first). */
const forgotten = new Map();

/** Note that `userId` was forgotten now. */
function markForgotten(userId) {
  remembered.delete(userId);
  forgotten.delete(userId);
  forgotten.set(userId, Date.now());
  if (forgotten.size > MAX_ENTRIES) forgotten.delete(forgotten.keys().next().value);
}

/**
 * What an acknowledgement is valid for: the version asked for and the last
 * "Remove all".
 *
 * @param {{requiredVersion: number, resetAt?: string|null}} settings
 * @returns {string}
 */
const stampOf = settings => `${settings.requiredVersion}|${settings.resetAt ?? ''}`;

/**
 * Whether this worker remembers that the user acknowledged under these settings.
 *
 * @param {string} userId
 * @param {{requiredVersion: number, resetAt?: string|null}} settings
 * @returns {boolean}
 */
export function isRememberedAcknowledged(userId, settings) {
  const entry = remembered.get(userId);
  if (!entry) return false;
  if (entry.expiresAt > Date.now() && entry.stamp === stampOf(settings)) return true;
  remembered.delete(userId);
  return false;
}

/**
 * Remember that the user acknowledged under these settings, unless they were
 * forgotten since `readStartedAt`: that "yes" may be from before the removal.
 *
 * @param {string} userId
 * @param {{requiredVersion: number, resetAt?: string|null}} settings
 * @param {number} readStartedAt - `Date.now()` taken before the store was read
 *   (or written) that said "yes"
 */
export function rememberAcknowledged(userId, settings, readStartedAt) {
  if (forgotten.get(userId) >= readStartedAt) return;
  remembered.delete(userId);
  remembered.set(userId, {
    stamp: stampOf(settings),
    expiresAt: Date.now() + ACKNOWLEDGEMENT_CACHE_TTL_MS
  });
  if (remembered.size > MAX_ENTRIES) remembered.delete(remembered.keys().next().value);
}

/**
 * Forget a user's acknowledgement here and on the other workers of this pod.
 * Call after their acknowledgements were removed from the store.
 *
 * @param {string} userId
 */
export function forgetAcknowledgement(userId) {
  markForgotten(userId);
  publish(FORGET_MESSAGE, { userId });
}

/**
 * Bus handler: another worker removed this user's acknowledgements.
 *
 * @param {{userId?: string}} payload
 */
export function onForgetMessage(payload) {
  if (payload?.userId) markForgotten(payload.userId);
}

subscribe(FORGET_MESSAGE, onForgetMessage);

/** Test seam: forget everything. */
export function resetAcknowledgementCacheForTests() {
  remembered.clear();
  forgotten.clear();
}

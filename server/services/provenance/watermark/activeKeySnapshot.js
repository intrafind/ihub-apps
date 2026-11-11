// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * In-memory snapshot of the active watermark key's *id* (never its value).
 * Adapters read it synchronously on every request; the key store refreshes it
 * at start-up and on every key change. Kept in its own module so the adapters
 * do not import the store (and its encryption and config dependencies).
 *
 * @module services/provenance/watermark/activeKeySnapshot
 */

/** @type {string|null} */
let activeKeyId = null;

/** Id of the active key, or null when the store has no keys. */
export function getActiveKeyId() {
  return activeKeyId;
}

/** Set by the key store and by tests. */
export function setActiveKeyIdSnapshot(id) {
  activeKeyId = id ?? null;
}

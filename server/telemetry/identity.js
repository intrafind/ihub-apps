// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who a span belongs to, without saying it in clear text.
 *
 * A raw login (an NTLM user name, an OIDC `preferred_username` or email, a
 * proxy header value) on every LLM span is a per-employee activity profile in
 * the trace backend. This module is the only place that turns a user or a
 * conversation into a span attribute, and it follows
 * `telemetry.spans.userIdMode`:
 *
 * - `pseudonymised` (default): `user.hash`, an HMAC-SHA256 of the id under a
 *   per-installation key. The same user gets the same value on every span and
 *   in every worker, so traces of one person can be grouped while incident
 *   work needs no clear name; mapping it back needs the key and the user list.
 * - `off`: no user attribute at all.
 * - `clear`: `user.id` in clear text, for installations whose works agreement
 *   allows it.
 *
 * Conversation and run ids are hashed with the same key in every mode but
 * `clear`, so the turns of one chat still line up.
 *
 * The key is derived (HKDF-SHA256) from the installation's encryption key
 * (`contents/.encryption-key` or `TOKEN_ENCRYPTION_KEY`), the key that already
 * protects every other platform secret. Nothing new has to be stored or backed
 * up. Rotating that key changes every pseudonym, which is the intended way to
 * unlink old traces. Until the key is loaded the helpers return nothing: an
 * attribute is left out, never sent in clear text.
 *
 * @module telemetry/identity
 */

import crypto from 'node:crypto';
import tokenStorageService from '../services/TokenStorageService.js';

/** The values `telemetry.spans.userIdMode` accepts. */
export const USER_ID_MODES = Object.freeze(['off', 'pseudonymised', 'clear']);

/** The mode used when the setting is missing or unknown. */
export const DEFAULT_USER_ID_MODE = 'pseudonymised';

/** HKDF info string; changing it changes every pseudonym. */
const KEY_INFO = 'ihub-telemetry-pseudonym-v1';

/** Hex characters kept from the HMAC: 128 bits, ample against collisions. */
const PSEUDONYM_LENGTH = 32;

let derivedKey = null;
let derivedFrom = null;
let currentMode = DEFAULT_USER_ID_MODE;

/**
 * The user id mode a telemetry config asks for.
 *
 * @param {Object} [config] - The `telemetry` block of platform.json
 * @returns {'off'|'pseudonymised'|'clear'}
 */
export function resolveUserIdMode(config) {
  const mode = config?.spans?.userIdMode;
  return USER_ID_MODES.includes(mode) ? mode : DEFAULT_USER_ID_MODE;
}

/**
 * Set the mode the helpers below follow. Called when telemetry starts and
 * whenever an admin saves the telemetry settings.
 *
 * @param {Object} [config] - The `telemetry` block of platform.json
 */
export function configureIdentity(config) {
  currentMode = resolveUserIdMode(config);
}

/** @returns {'off'|'pseudonymised'|'clear'} The mode in effect. */
export function getUserIdMode() {
  return currentMode;
}

/** The HMAC key, derived once per installation key; null while none is loaded. */
function pseudonymKey() {
  const base = tokenStorageService.encryptionKey;
  if (!base) return null;
  if (derivedFrom !== base) {
    derivedKey = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(base, 'hex'), Buffer.alloc(0), KEY_INFO, 32)
    );
    derivedFrom = base;
  }
  return derivedKey;
}

/**
 * The pseudonym of a value within a domain (`user`, `conversation`, …). The
 * domain keeps a user id and a chat id that happen to be equal apart.
 *
 * @param {unknown} value
 * @param {string} domain
 * @returns {string|undefined} 32 hex characters, or undefined when there is no
 *   value or no key yet
 */
export function pseudonymise(value, domain) {
  if (value === undefined || value === null || value === '') return undefined;
  const key = pseudonymKey();
  if (!key) return undefined;
  return crypto
    .createHmac('sha256', key)
    .update(`${domain}\u0000${String(value)}`)
    .digest('hex')
    .slice(0, PSEUDONYM_LENGTH);
}

/**
 * The span attributes that name a user, by the mode in effect.
 *
 * @param {string|undefined|null} userId - The user's id as the auth layer set it
 * @returns {Object} `{ 'user.hash': … }`, `{ 'user.id': … }` or `{}`
 */
export function userSpanAttributes(userId) {
  if (userId === undefined || userId === null || userId === '') return {};
  if (currentMode === 'off') return {};
  if (currentMode === 'clear') return { 'user.id': String(userId) };
  const hash = pseudonymise(userId, 'user');
  return hash ? { 'user.hash': hash } : {};
}

/**
 * The span attribute for a conversation (chat) id: hashed unless the mode is
 * `clear`.
 *
 * @param {string|undefined|null} conversationId
 * @returns {Object} `{ 'gen_ai.conversation.id': … }` or `{}`
 */
export function conversationSpanAttributes(conversationId) {
  if (conversationId === undefined || conversationId === null || conversationId === '') return {};
  if (currentMode === 'clear') return { 'gen_ai.conversation.id': String(conversationId) };
  const hash = pseudonymise(conversationId, 'conversation');
  return hash ? { 'gen_ai.conversation.id': hash } : {};
}

/** Reset the derived key and mode (tests only). */
export function resetIdentityForTests() {
  derivedKey = null;
  derivedFrom = null;
  currentMode = DEFAULT_USER_ID_MODE;
}

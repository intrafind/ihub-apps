// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Stops one wrong Windows password from locking the account.
 *
 * Until a sign-in succeeds there is no session cookie, so every request the
 * browser sends runs its own NTLM handshake. With a stale password each of
 * them is a failed logon at the domain controller, and a single page load
 * (a dozen parallel API calls) is enough to reach the lockout threshold.
 *
 * After the domain controller rejects a user, further NTLM answers (Type 3
 * messages) for that user are refused here for a short while instead of being
 * relayed, so they never reach the domain controller.
 */

const DEFAULT_COOLDOWN_MS = 60 * 1000;
const NTLM_TYPE3 = 3;
const NTLMSSP_NEGOTIATE_UNICODE = 0x00000001;

/** @type {Map<string, number>} account key -> cooldown end (epoch ms) */
const rejectedUntil = new Map();

function accountKey(domain, user) {
  return `${String(domain || '').toLowerCase()}\\${String(user || '').toLowerCase()}`;
}

function readSecurityBuffer(buf, offset, unicode) {
  if (buf.length < offset + 8) return null;
  const length = buf.readUInt16LE(offset);
  const start = buf.readUInt32LE(offset + 4);
  if (start + length > buf.length) return null;
  return buf.subarray(start, start + length).toString(unicode ? 'utf16le' : 'latin1');
}

/**
 * Read the domain and user name from an `Authorization: NTLM …` header that
 * carries an NTLM Type 3 (authenticate) message.
 *
 * @param {string|undefined} authorization - The Authorization header
 * @returns {{domain: string, user: string}|null} null for anything else
 */
export function parseNtlmType3Identity(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^NTLM\s+([A-Za-z0-9+/=]+)\s*$/.exec(authorization);
  if (!match) return null;

  const buf = Buffer.from(match[1], 'base64');
  if (buf.length < 64 || buf.toString('latin1', 0, 8) !== 'NTLMSSP\0') return null;
  if (buf.readUInt32LE(8) !== NTLM_TYPE3) return null;

  const unicode = (buf.readUInt32LE(60) & NTLMSSP_NEGOTIATE_UNICODE) !== 0;
  const domain = readSecurityBuffer(buf, 28, unicode);
  const user = readSecurityBuffer(buf, 36, unicode);
  if (domain === null || !user) return null;
  return { domain, user };
}

/**
 * Remember that the domain controller rejected this account.
 *
 * @param {string} domain
 * @param {string} user
 * @param {number} [now]
 * @param {number} [cooldownMs]
 */
export function recordNtlmRejection(
  domain,
  user,
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS
) {
  if (!user) return;
  rejectedUntil.set(accountKey(domain, user), now + cooldownMs);
}

/**
 * How long this account is still cooling down after a rejection.
 *
 * @param {string} domain
 * @param {string} user
 * @param {number} [now]
 * @returns {number} Remaining milliseconds; 0 when the account may try again
 */
export function ntlmCooldownRemaining(domain, user, now = Date.now()) {
  const key = accountKey(domain, user);
  const until = rejectedUntil.get(key);
  if (until === undefined) return 0;
  if (until <= now) {
    rejectedUntil.delete(key);
    return 0;
  }
  return until - now;
}

/** Forget all rejections (tests). */
export function resetNtlmRejections() {
  rejectedUntil.clear();
}

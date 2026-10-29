// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Ed25519 signatures on update manifests and checksum files.
 *
 * A checksum published next to an archive proves the download is intact, not
 * that it came from us: whoever can replace the archive can replace the
 * checksum. The release workflow therefore signs `update-manifest.json`
 * (inside every archive, listing the SHA-256 of every file) and
 * `checksums.sha256` (listing the SHA-256 of every archive) with a key held in
 * a protected GitHub environment, and the updater accepts an archive only
 * when one of those signatures verifies against a trusted public key.
 *
 * Signature file (`<file>.sig`), JSON:
 *   { "algorithm": "ed25519", "signatures": [ { "keyId": "…", "signature": "<base64>" } ] }
 * More than one entry while a key rotation is under way.
 *
 * @module update/signature
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { EMBEDDED_UPDATE_KEYS } from './trustedKeys.js';

/**
 * Identifier of a public key: the first 16 hex digits of the SHA-256 of its
 * SPKI DER encoding.
 * @param {import('node:crypto').KeyObject} keyObject
 */
export function keyIdOf(keyObject) {
  const der = keyObject.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * The keys the updater trusts: the embedded release keys plus any configured in
 * `platform.json` → `update.trustedPublicKeys`. Keys that do not parse as
 * Ed25519 are reported, not trusted.
 *
 * @param {Array<string|{ label?: string, publicKey: string }>} [configuredKeys]
 * @param {ReadonlyArray<{ label?: string, publicKey: string }>} [embeddedKeys]
 * @returns {{ keys: Array<{ keyId: string, label: string, key: import('node:crypto').KeyObject, source: string }>, invalid: string[] }}
 */
export function loadTrustedKeys(configuredKeys = [], embeddedKeys = EMBEDDED_UPDATE_KEYS) {
  const keys = [];
  const invalid = [];
  const add = (entry, source, index) => {
    const pem = typeof entry === 'string' ? entry : entry?.publicKey;
    const label = (typeof entry === 'object' && entry?.label) || `${source} key ${index + 1}`;
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
      const keyId = keyIdOf(key);
      if (!keys.some(k => k.keyId === keyId)) keys.push({ keyId, label, key, source });
    } catch (error) {
      invalid.push(`${label}: ${error.message}`);
    }
  };
  embeddedKeys.forEach((entry, i) => add(entry, 'embedded', i));
  (Array.isArray(configuredKeys) ? configuredKeys : []).forEach((entry, i) =>
    add(entry, 'configured', i)
  );
  return { keys, invalid };
}

/**
 * Check a detached signature.
 *
 * @param {Buffer} data - The exact bytes that were signed
 * @param {string|Buffer|null} signatureFile - Contents of the `.sig` file
 * @param {Array<{ keyId: string, label: string, key: import('node:crypto').KeyObject }>} trustedKeys
 * @returns {{ status: 'valid'|'invalid'|'unknown-key'|'missing'|'malformed', keyId?: string, label?: string }}
 *   `invalid`: a trusted key's signature does not match — the data was changed
 */
export function verifyDetachedSignature(data, signatureFile, trustedKeys) {
  if (signatureFile === null || signatureFile === undefined || signatureFile.length === 0) {
    return { status: 'missing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(signatureFile.toString());
  } catch {
    return { status: 'malformed' };
  }
  if (parsed?.algorithm && parsed.algorithm !== 'ed25519') return { status: 'malformed' };
  const entries = Array.isArray(parsed?.signatures)
    ? parsed.signatures
    : parsed?.signature
      ? [parsed]
      : [];
  if (entries.length === 0) return { status: 'malformed' };

  let invalid = null;
  for (const entry of entries) {
    const trusted = trustedKeys.find(k => k.keyId === entry?.keyId);
    if (!trusted || typeof entry.signature !== 'string') continue;
    let ok = false;
    try {
      ok = cryptoVerify(null, data, trusted.key, Buffer.from(entry.signature, 'base64'));
    } catch {
      ok = false;
    }
    if (ok) return { status: 'valid', keyId: trusted.keyId, label: trusted.label };
    invalid = { status: 'invalid', keyId: trusted.keyId, label: trusted.label };
  }
  return invalid || { status: 'unknown-key', keyId: entries[0]?.keyId };
}

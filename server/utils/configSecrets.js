// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Decryption of the secrets the config files store encrypted at rest
 * (`ENC[...]`, AES-256-GCM, see `TokenStorageService`). The cache decrypts them
 * as it loads an entry, so readers receive plaintext.
 */

import tokenStorageService from '../services/TokenStorageService.js';
import { SECRET_FIELDS_BY_TYPE } from '../validators/credentialSchema.js';
import logger from './logger.js';

/**
 * Decrypt a single value if it has the ENC[...] format.
 *
 * @param {*} value - The stored value
 * @param {Object} [context] - Names the secret in the error log when it cannot
 *   be decrypted (for example `{ credentialId, field }`); never the value itself
 */
export function decryptIfEncrypted(value, context = {}) {
  if (!value || typeof value !== 'string') return value;
  if (tokenStorageService.isEncrypted(value)) {
    try {
      return tokenStorageService.decryptString(value);
    } catch (error) {
      logger.error('Failed to decrypt config secret', {
        component: 'ConfigCache',
        ...context,
        keySource: tokenStorageService.keySource,
        keyFingerprint: tokenStorageService.getKeyFingerprint(),
        error
      });
      return value; // Return encrypted value as-is on failure
    }
  }
  return value;
}

/**
 * Decrypt secret fields in the central credential store so CredentialService
 * consumers receive plaintext. Operates in-place on the credentials map.
 */
export function decryptCredentials(config) {
  if (!config || typeof config !== 'object' || !config.credentials) return config;
  for (const [credentialId, profile] of Object.entries(config.credentials)) {
    if (!profile || typeof profile !== 'object') continue;
    const secretFields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
    for (const field of secretFields) {
      if (profile[field]) {
        profile[field] = decryptIfEncrypted(profile[field], {
          configPath: 'config/credentials.json',
          credentialId,
          field
        });
      }
    }
  }
  return config;
}

/**
 * Decrypt the speech secret platform.json stores encrypted at rest, in place.
 *
 * The Azure token broker (`/api/voice/azure/token`) reads it from the cache and
 * expects plaintext. Env-var placeholders are resolved later, when the entry is
 * stored. Transcription and TTS endpoints keep their keys on their models.
 *
 * @param {Object} platformData - Parsed platform.json
 * @returns {Object} The same object
 */
export function decryptPlatformSecrets(platformData) {
  if (platformData.speech?.azure?.subscriptionKey) {
    platformData.speech.azure.subscriptionKey = decryptIfEncrypted(
      platformData.speech.azure.subscriptionKey,
      { configPath: 'config/platform.json', setting: 'speech.azure.subscriptionKey' }
    );
  }
  return platformData;
}

/**
 * The secrets `platform.json` stores encrypted at rest, as paths through
 * plain objects. Each is encrypted by {@link encryptPlatformSecrets} on every
 * save of the file.
 *
 * `storage.blobs.s3.secretAccessKey` is not decrypted into the runtime cache
 * (see {@link decryptPlatformSecrets}): the storage bootstrap reads the raw
 * file and opens the secret itself, and nothing else needs it, so the cache
 * keeps the ciphertext.
 */
const ENCRYPTED_PLATFORM_SECRETS = Object.freeze([
  Object.freeze(['speech', 'azure', 'subscriptionKey']),
  Object.freeze(['storage', 'blobs', 's3', 'secretAccessKey'])
]);

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The value at a path of plain objects, or undefined.
 *
 * @param {Object} data
 * @param {ReadonlyArray<string>} path
 * @returns {unknown}
 */
function valueAt(data, path) {
  let current = data;
  for (const segment of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * A copy of `data` with the value at `path` replaced; only the objects on the
 * path are copied.
 *
 * @param {Object} data
 * @param {ReadonlyArray<string>} path
 * @param {unknown} value
 * @returns {Object}
 */
function withValueAt(data, [segment, ...rest], value) {
  return {
    ...data,
    [segment]: rest.length === 0 ? value : withValueAt(data[segment], rest, value)
  };
}

/**
 * The inverse of {@link decryptPlatformSecrets}, for the way back to disk.
 *
 * The runtime cache holds the Azure Speech subscription key decrypted, so a
 * route that builds the file it saves from the cache would store the key in
 * plain text. This encrypts it again, and with it every other secret of
 * {@link ENCRYPTED_PLATFORM_SECRETS} that is still plain text (the S3 secret
 * access key of the blob storage, which an operator writes into the file by
 * hand); an environment variable placeholder (`${NAME}`) and a value that is
 * already encrypted stay as they are, so calling it twice is harmless.
 *
 * @param {Object} platformData - The platform configuration about to be saved
 * @returns {Promise<Object>} `platformData` itself when it holds no plain-text secret,
 *   otherwise a copy with the secrets encrypted (the argument is not modified)
 */
export async function encryptPlatformSecrets(platformData) {
  let result = platformData;
  for (const path of ENCRYPTED_PLATFORM_SECRETS) {
    const secret = valueAt(result, path);
    if (!secret || typeof secret !== 'string') continue;
    if (/^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(secret)) continue;
    if (tokenStorageService.isEncrypted(secret)) continue;
    // The file is also saved early in startup (migrations), before the server
    // has set the key up.
    if (!tokenStorageService.encryptionKey) await tokenStorageService.initializeEncryptionKey();
    result = withValueAt(result, path, tokenStorageService.encryptString(secret));
  }
  return result;
}

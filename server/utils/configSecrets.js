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
 * Decrypt the secrets platform.json stores encrypted at rest, in place: the
 * Azure Speech key and the OTLP exporter headers.
 *
 * The Azure token broker (`/api/voice/azure/token`) reads the key from the
 * cache and expects plaintext. Env-var placeholders are resolved later, when the entry is
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
  const otlpHeaders = platformData.telemetry?.exporters?.otlp?.headers;
  if (otlpHeaders && typeof otlpHeaders === 'object' && !Array.isArray(otlpHeaders)) {
    for (const [name, value] of Object.entries(otlpHeaders)) {
      otlpHeaders[name] = decryptIfEncrypted(value, {
        configPath: 'config/platform.json',
        setting: 'telemetry.exporters.otlp.headers'
      });
    }
  }
  return platformData;
}

/**
 * The inverse of {@link decryptPlatformSecrets}, for the way back to disk.
 *
 * The runtime cache holds the Azure Speech subscription key and the OTLP
 * exporter headers decrypted, and an admin save sends new values in plain
 * text, so a write would store them in plain text. This encrypts them; an environment variable placeholder
 * (`${NAME}`) and a value that is already encrypted stay as they are, so
 * calling it twice is harmless.
 *
 * @param {Object} platformData - The platform configuration about to be saved
 * @returns {Promise<Object>} `platformData` itself when it holds no plain-text secret,
 *   otherwise a copy with the secret encrypted (the argument is not modified)
 */
export async function encryptPlatformSecrets(platformData) {
  const key = platformData?.speech?.azure?.subscriptionKey;
  const otlpHeaders = platformData?.telemetry?.exporters?.otlp?.headers;
  const headerNeedsEncryption =
    otlpHeaders && typeof otlpHeaders === 'object' && !Array.isArray(otlpHeaders)
      ? Object.values(otlpHeaders).some(needsEncryption)
      : false;
  const keyNeedsEncryption = needsEncryption(key);
  if (!keyNeedsEncryption && !headerNeedsEncryption) return platformData;
  // The file is also saved early in startup (migrations), before the server
  // has set the key up.
  if (!tokenStorageService.encryptionKey) await tokenStorageService.initializeEncryptionKey();
  let next = platformData;
  if (keyNeedsEncryption) {
    next = {
      ...next,
      speech: {
        ...next.speech,
        azure: {
          ...next.speech.azure,
          subscriptionKey: tokenStorageService.encryptString(key)
        }
      }
    };
  }
  if (headerNeedsEncryption) {
    next = {
      ...next,
      telemetry: {
        ...next.telemetry,
        exporters: {
          ...next.telemetry.exporters,
          otlp: {
            ...next.telemetry.exporters.otlp,
            headers: Object.fromEntries(
              Object.entries(otlpHeaders).map(([name, value]) => [
                name,
                needsEncryption(value) ? tokenStorageService.encryptString(value) : value
              ])
            )
          }
        }
      }
    };
  }
  return next;
}

/**
 * Whether a stored secret value is plain text that belongs encrypted: a
 * non-empty string that is neither an `${ENV}` placeholder nor already `ENC[...]`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function needsEncryption(value) {
  if (!value || typeof value !== 'string') return false;
  if (/^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value)) return false;
  return !tokenStorageService.isEncrypted(value);
}

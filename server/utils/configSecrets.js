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
 */
export function decryptIfEncrypted(value) {
  if (!value || typeof value !== 'string') return value;
  if (tokenStorageService.isEncrypted(value)) {
    try {
      return tokenStorageService.decryptString(value);
    } catch (error) {
      logger.error('Failed to decrypt config secret', {
        component: 'ConfigCache',
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
  for (const profile of Object.values(config.credentials)) {
    if (!profile || typeof profile !== 'object') continue;
    const secretFields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
    for (const field of secretFields) {
      if (profile[field]) {
        profile[field] = decryptIfEncrypted(profile[field]);
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
      platformData.speech.azure.subscriptionKey
    );
  }
  return platformData;
}

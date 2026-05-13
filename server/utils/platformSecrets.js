// Shared helpers for encrypting/decrypting secret fields in platform.json
// before write / after read. Used by every admin route that persists
// `contents/config/platform.json` so encrypted secrets in unrelated sections
// (Jira, OIDC, LDAP, NTLM, iFinder, cloud-storage providers) survive a save
// that targets a different section.
//
// Without these guards, a route that does
//   { ...configCache.getPlatform(), ...updates }
// will overwrite encrypted secrets with their decrypted form, because
// `configCache.getPlatform()` decrypts on load.

import tokenStorageService from '../services/TokenStorageService.js';
import logger from './logger.js';

function isEnvVarPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value);
}

export function encryptIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (isEnvVarPlaceholder(value)) return value;
  if (tokenStorageService.isEncrypted(value)) return value;
  return tokenStorageService.encryptString(value);
}

export function decryptIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (tokenStorageService.isEncrypted(value)) {
    try {
      return tokenStorageService.decryptString(value);
    } catch (error) {
      logger.error('Failed to decrypt config secret', { component: 'PlatformSecrets', error });
      return value;
    }
  }
  return value;
}

/**
 * Encrypt every known secret field in `config` in place. New secret fields
 * should be added here and in `decryptPlatformSecrets`.
 */
export function encryptPlatformSecrets(config) {
  if (!config || typeof config !== 'object') return config;

  if (config.jira?.clientSecret) {
    config.jira.clientSecret = encryptIfNeeded(config.jira.clientSecret);
  }

  if (config.cloudStorage?.providers) {
    for (const provider of config.cloudStorage.providers) {
      if (provider.clientSecret) {
        provider.clientSecret = encryptIfNeeded(provider.clientSecret);
      }
      if (provider.type === 'office365' && provider.tenantId) {
        provider.tenantId = encryptIfNeeded(provider.tenantId);
      }
    }
  }

  if (config.oidcAuth?.providers) {
    for (const provider of config.oidcAuth.providers) {
      if (provider.clientSecret) {
        provider.clientSecret = encryptIfNeeded(provider.clientSecret);
      }
    }
  }

  if (config.ldapAuth?.providers) {
    for (const provider of config.ldapAuth.providers) {
      if (provider.adminPassword) {
        provider.adminPassword = encryptIfNeeded(provider.adminPassword);
      }
    }
  }

  if (config.ntlmAuth?.domainControllerPassword) {
    config.ntlmAuth.domainControllerPassword = encryptIfNeeded(
      config.ntlmAuth.domainControllerPassword
    );
  }

  if (config.iFinder?.privateKey) {
    config.iFinder.privateKey = encryptIfNeeded(config.iFinder.privateKey);
  }

  return config;
}

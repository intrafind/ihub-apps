import configCache from '../configCache.js';
import { SECRET_FIELDS_BY_TYPE } from '../validators/credentialSchema.js';
import logger from '../utils/logger.js';

/**
 * CredentialService — single access point for the central credential store
 * (`contents/config/credentials.json`).
 *
 * Profiles are decrypted by configCache when the store is loaded, so the
 * objects returned here always contain plaintext secrets. Consumers resolve a
 * `credentialRef` (the profile id) instead of holding inline secrets.
 */
class CredentialService {
  /**
   * Return the decrypted credentials map ({ id: profile }).
   * @returns {Record<string, object>}
   */
  list() {
    const store = configCache.getCredentials();
    return store?.credentials || {};
  }

  /**
   * Resolve a credentialRef to its decrypted profile.
   * Throws when the ref is missing so misconfiguration surfaces loudly rather
   * than silently falling back to anonymous access.
   *
   * @param {string} ref - Credential profile id
   * @returns {object} Decrypted credential profile
   */
  resolve(ref) {
    if (!ref || typeof ref !== 'string') {
      throw new Error('CredentialService.resolve requires a non-empty credentialRef');
    }
    const profile = this.list()[ref];
    if (!profile) {
      logger.error('Dangling credentialRef', { component: 'CredentialService', ref });
      throw new Error(`Unknown credentialRef: "${ref}"`);
    }
    return profile;
  }

  /**
   * Resolve a credentialRef to its primary secret value (plaintext).
   *
   * Returns the first secret-bearing field for the profile's type:
   * `secret` → value, `bearer` → token, `basic` → password,
   * `oauth2` → clientSecret, `apiKey*` → key. This is the convenience accessor
   * used by integrations that migrated a single inline secret to the store.
   *
   * @param {string} ref
   * @returns {string|undefined}
   */
  resolveSecret(ref) {
    const profile = this.resolve(ref);
    const fields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
    return fields.length ? profile[fields[0]] : undefined;
  }

  /**
   * Like resolveSecret but returns undefined instead of throwing when the ref
   * is absent/empty (for optional secrets such as NTLM password).
   * @param {string} ref
   * @returns {string|undefined}
   */
  tryResolveSecret(ref) {
    const profile = this.tryResolve(ref);
    if (!profile) return undefined;
    const fields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
    return fields.length ? profile[fields[0]] : undefined;
  }

  /**
   * Resolve a credentialRef, returning null instead of throwing when absent.
   * @param {string} ref
   * @returns {object|null}
   */
  tryResolve(ref) {
    if (!ref || typeof ref !== 'string') return null;
    return this.list()[ref] || null;
  }

  /**
   * Whether a credentialRef exists in the store.
   * @param {string} ref
   * @returns {boolean}
   */
  has(ref) {
    return Boolean(this.tryResolve(ref));
  }
}

const credentialService = new CredentialService();
export default credentialService;

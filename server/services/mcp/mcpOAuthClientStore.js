/**
 * Per-server OAuth client registrations for outbound `oauthUser` MCP servers.
 *
 * iHub registers itself once per authorization server — as a pre-registered
 * client from the config, through its Client ID Metadata Document, or by
 * dynamic client registration (RFC 7591) — and every user's sign-in on that
 * server reuses the registration. The record also keeps the discovery state
 * (authorization server URL and metadata, protected-resource metadata) so a
 * token refresh on any worker needs no re-discovery.
 *
 * Records are documents in the `mcp-oauth-clients` namespace of the storage
 * provider, keyed by server id, so every worker sees the same registration.
 * A DCR client secret is stored `ENC[...]`-encrypted with the token store's
 * key. Without a storage provider the store is memory-only (one registration
 * per worker; the authorization servers used here register public clients,
 * so a second registration is harmless).
 *
 * @module services/mcp/mcpOAuthClientStore
 */
import crypto from 'crypto';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpOAuthClientStore';

export const MCP_OAUTH_CLIENTS_NAMESPACE = RUNTIME_NAMESPACES.mcpOauthClients;

/**
 * Fingerprint of the parts of a server config a registration depends on: the
 * endpoint and the auth block. A registration made for another fingerprint is
 * ignored, so changing the server's URL or auth settings — even while iHub
 * was down — makes the next sign-in register afresh.
 *
 * @param {Object} serverConfig
 * @returns {string} hex digest
 */
export function registrationFingerprint(serverConfig) {
  const auth = serverConfig?.auth || {};
  const material = JSON.stringify({
    transport: serverConfig?.transport?.type || null,
    url: serverConfig?.transport?.url || null,
    auth: {
      type: auth.type || null,
      clientId: auth.clientId || null,
      clientSecretRef: auth.clientSecretRef || null,
      authorizationServer: auth.authorizationServer || null,
      scopes: Array.isArray(auth.scopes) ? auth.scopes : []
    }
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * @typedef {Object} McpOAuthClientRegistration
 * @property {string} serverId
 * @property {'config'|'cimd'|'dcr'} source - How iHub identified itself
 * @property {string} clientId
 * @property {string} [clientSecret] - `ENC[...]` (DCR confidential clients only)
 * @property {number} [clientIdIssuedAt]
 * @property {string} [tokenEndpointAuthMethod]
 * @property {string} authorizationServerUrl
 * @property {Object} [discovery] - SDK `OAuthDiscoveryState`
 * @property {string} redirectUri - The callback URL registered with the AS
 * @property {string} [clientMetadataUrl] - iHub's CIMD URL when `source` is `cimd`
 * @property {string} publicBase - Public base URL the registration was made for
 * @property {string} fingerprint - {@link registrationFingerprint} of the config it was made for
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export class McpOAuthClientStore {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents] -
   *   Document store; `null` pins memory-only mode, leaving it out resolves the
   *   provider lazily.
   * @param {() => number} [options.now]
   */
  constructor({ documents, now = () => Date.now() } = {}) {
    this._documents = documents;
    this._pinned = documents !== undefined;
    this.now = now;
    /** @type {Map<string, McpOAuthClientRegistration>} */
    this.memory = new Map();
  }

  _docs() {
    if (this._pinned) return this._documents || null;
    return readFacet(getStorage(), 'documents');
  }

  /**
   * The registration for a server, or null.
   * @param {string} serverId
   * @returns {Promise<McpOAuthClientRegistration|null>}
   */
  async get(serverId) {
    if (typeof serverId !== 'string' || !serverId) return null;
    const documents = this._docs();
    if (documents) {
      try {
        const doc = await documents.get(MCP_OAUTH_CLIENTS_NAMESPACE, serverId);
        if (doc?.data?.clientId) {
          this.memory.set(serverId, doc.data);
          return doc.data;
        }
        // The document store is authoritative: a record only in memory here
        // was removed elsewhere.
        this.memory.delete(serverId);
        return null;
      } catch (error) {
        logger.warn('MCP OAuth client registration read failed; using in-memory copy', {
          component: COMPONENT,
          serverId,
          error: error.message
        });
      }
    }
    return this.memory.get(serverId) || null;
  }

  /**
   * The registration for a server config, or null when there is none or it
   * was made for a different endpoint / auth block (it is then dropped).
   *
   * @param {Object} serverConfig
   * @returns {Promise<McpOAuthClientRegistration|null>}
   */
  async getFor(serverConfig) {
    const registration = await this.get(serverConfig?.id);
    if (!registration) return null;
    if (registration.fingerprint !== registrationFingerprint(serverConfig)) {
      await this.clear(serverConfig.id);
      return null;
    }
    return registration;
  }

  /**
   * Store (or replace) a server's registration. A clear-text `clientSecret`
   * is encrypted before it is written.
   *
   * @param {string} serverId
   * @param {Object} registration - Fields of {@link McpOAuthClientRegistration} minus timestamps
   * @returns {Promise<McpOAuthClientRegistration>}
   */
  async put(serverId, registration) {
    const existing = await this.get(serverId);
    const nowIso = new Date(this.now()).toISOString();
    const record = {
      ...registration,
      serverId,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso
    };
    if (typeof record.clientSecret === 'string' && record.clientSecret) {
      if (!tokenStorageService.isEncrypted(record.clientSecret)) {
        record.clientSecret = tokenStorageService.encryptString(record.clientSecret);
      }
    } else {
      delete record.clientSecret;
    }
    this.memory.set(serverId, record);
    const documents = this._docs();
    if (documents) {
      try {
        await documents.put(MCP_OAUTH_CLIENTS_NAMESPACE, serverId, record, { ownerId: 'system' });
      } catch (error) {
        logger.warn('MCP OAuth client registration write failed; kept on this worker only', {
          component: COMPONENT,
          serverId,
          error: error.message
        });
      }
    }
    return record;
  }

  /**
   * Merge fields into an existing registration (e.g. refreshed discovery
   * state). No-op when the server has no registration.
   *
   * @param {string} serverId
   * @param {Object} patch
   * @returns {Promise<McpOAuthClientRegistration|null>}
   */
  async update(serverId, patch) {
    const existing = await this.get(serverId);
    if (!existing) return null;
    return this.put(serverId, { ...existing, ...patch });
  }

  /**
   * Forget a server's registration (config change, `invalid_client`).
   * @param {string} serverId
   * @returns {Promise<void>}
   */
  async clear(serverId) {
    this.memory.delete(serverId);
    const documents = this._docs();
    if (!documents) return;
    try {
      await documents.delete(MCP_OAUTH_CLIENTS_NAMESPACE, serverId);
    } catch (error) {
      logger.warn('MCP OAuth client registration delete failed', {
        component: COMPONENT,
        serverId,
        error: error.message
      });
    }
  }

  /**
   * The SDK `OAuthClientInformation` of a registration, secret decrypted.
   *
   * @param {McpOAuthClientRegistration|null} registration
   * @returns {{client_id: string, client_secret?: string, token_endpoint_auth_method?: string}|null}
   */
  static clientInformationOf(registration) {
    if (!registration?.clientId) return null;
    const info = { client_id: registration.clientId };
    if (registration.clientSecret) {
      info.client_secret = tokenStorageService.decryptString(registration.clientSecret);
    }
    if (registration.tokenEndpointAuthMethod) {
      info.token_endpoint_auth_method = registration.tokenEndpointAuthMethod;
    }
    return info;
  }
}

let singleton = null;

/**
 * The process-wide store.
 * @returns {McpOAuthClientStore}
 */
export function getMcpOAuthClientStore() {
  if (!singleton) singleton = new McpOAuthClientStore();
  return singleton;
}

/** Test seam: replace the singleton. */
export function setMcpOAuthClientStoreForTests(store) {
  singleton = store;
}

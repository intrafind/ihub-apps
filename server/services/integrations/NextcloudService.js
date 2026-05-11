import 'dotenv/config';
import tokenStorage from '../TokenStorageService.js';
import { httpFetch } from '../../utils/httpConfig.js';
import { getForwardedProto, getForwardedHost } from '../../utils/publicBaseUrl.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';

/**
 * Nextcloud Service for Nextcloud file access integration.
 *
 * Uses Nextcloud's OAuth 2.0 implementation for authentication and the
 * WebDAV endpoint at `/remote.php/dav/files/{userId}/` for listing,
 * navigating, and downloading files. The OCS API
 * (`/ocs/v2.php/cloud/user`) is used to resolve the authenticated user's
 * Nextcloud login (which is the path segment used in WebDAV URLs).
 *
 * Auth endpoints:
 *   - Authorize: {serverUrl}/apps/oauth2/authorize
 *   - Token:     {serverUrl}/apps/oauth2/api/v1/token
 *
 * Notes / known constraints:
 *   - Nextcloud's OAuth 2.0 server does NOT support PKCE, so we rely on
 *     the CSRF `state` parameter for cross-request protection (kept in
 *     the user's session, same as the other cloud storage providers).
 *   - Nextcloud rotates refresh tokens on every refresh, so callers must
 *     persist the new refresh token returned by `refreshAccessToken`.
 */
class NextcloudService {
  constructor() {
    this.serviceName = 'nextcloud';
    logger.info('NextcloudService initialized', { component: 'NextcloudService' });
  }

  _buildCallbackUrl(req, providerId) {
    const protocol = getForwardedProto(req);
    const host = getForwardedHost(req);

    if (!host) {
      throw new Error('Unable to determine host for callback URL');
    }

    return `${protocol}://${host}/api/integrations/${this.serviceName}/${providerId}/callback`;
  }

  _normalizeServerUrl(serverUrl) {
    if (!serverUrl || typeof serverUrl !== 'string') return serverUrl;
    return serverUrl.replace(/\/+$/, '');
  }

  _getProviderConfig(providerId) {
    if (!configCache || typeof configCache.get !== 'function') {
      throw new Error('Platform configuration cache is not initialized');
    }

    const platformConfig = configCache.getPlatform();
    const cloudStorage = platformConfig?.cloudStorage;

    if (!cloudStorage?.enabled) {
      throw new Error('Cloud storage is not enabled');
    }

    const provider = cloudStorage.providers?.find(
      p => p.id === providerId && p.type === 'nextcloud' && p.enabled !== false
    );

    if (!provider) {
      throw new Error(`Nextcloud provider '${providerId}' not found or not enabled`);
    }

    if (!provider.serverUrl || !provider.clientId || !provider.clientSecret) {
      throw new Error(
        `Nextcloud provider '${providerId}' missing required configuration (serverUrl, clientId, clientSecret)`
      );
    }

    return { ...provider, serverUrl: this._normalizeServerUrl(provider.serverUrl) };
  }

  _resolveRedirectUri(provider, providerId, req) {
    let redirectUri = provider.redirectUri || process.env.NEXTCLOUD_OAUTH_REDIRECT_URI;

    if (!redirectUri && req) {
      redirectUri = this._buildCallbackUrl(req, providerId);
      logger.info('Auto-detected Nextcloud callback URL from request', {
        component: 'NextcloudService',
        redirectUri
      });
    }

    if (!redirectUri) {
      redirectUri = `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/${this.serviceName}/${providerId}/callback`;
      logger.warn('Using fallback localhost URL for Nextcloud callback', {
        component: 'NextcloudService',
        redirectUri
      });
    }

    return redirectUri;
  }

  /**
   * Generate OAuth 2.0 authorization URL.
   * Nextcloud's OAuth 2.0 implementation does not support PKCE, so we
   * rely on the session-bound `state` parameter for CSRF protection.
   */
  generateAuthUrl(providerId, state, req = null) {
    const provider = this._getProviderConfig(providerId);
    const redirectUri = this._resolveRedirectUri(provider, providerId, req);

    const params = new URLSearchParams({
      client_id: provider.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state
    });

    return `${provider.serverUrl}/apps/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(providerId, authCode, req = null) {
    try {
      const provider = this._getProviderConfig(providerId);
      const redirectUri = this._resolveRedirectUri(provider, providerId, req);
      const tokenUrl = `${provider.serverUrl}/apps/oauth2/api/v1/token`;

      const tokenData = new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: redirectUri,
        client_id: provider.clientId,
        client_secret: provider.clientSecret
      });

      const response = await httpFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Error exchanging Nextcloud authorization code', {
          component: 'NextcloudService',
          error: errorData
        });
        throw new Error('Failed to exchange authorization code for tokens');
      }

      const tokens = await response.json();

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
        // Nextcloud returns the user_id of the resource owner in the token
        // response — cache it so we can build WebDAV URLs without an extra
        // OCS round-trip on every API call.
        nextcloudUserId: tokens.user_id,
        providerId
      };
    } catch (error) {
      if (error.message === 'Failed to exchange authorization code for tokens') throw error;
      logger.error('Error exchanging Nextcloud authorization code', {
        component: 'NextcloudService',
        error
      });
      throw new Error('Failed to exchange authorization code for tokens');
    }
  }

  async refreshAccessToken(providerId, refreshToken) {
    try {
      logger.info('Attempting to refresh Nextcloud access token', {
        component: 'NextcloudService'
      });

      const provider = this._getProviderConfig(providerId);
      const tokenUrl = `${provider.serverUrl}/apps/oauth2/api/v1/token`;

      const tokenData = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: provider.clientId,
        client_secret: provider.clientSecret
      });

      const response = await httpFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Error refreshing Nextcloud access token', {
          component: 'NextcloudService',
          error: errorData
        });

        if (response.status === 400) {
          if (errorData.error === 'invalid_grant') {
            throw new Error('Refresh token expired or invalid - user needs to reconnect');
          }
          throw new Error(
            `Token refresh failed: ${errorData.error_description || errorData.error}`
          );
        }

        throw new Error(`Failed to refresh access token: ${response.statusText}`);
      }

      const tokens = await response.json();
      logger.info('Nextcloud token refresh successful', { component: 'NextcloudService' });

      return {
        accessToken: tokens.access_token,
        // Nextcloud rotates refresh tokens on every refresh — always
        // persist the freshly issued value.
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
        nextcloudUserId: tokens.user_id,
        providerId
      };
    } catch (error) {
      if (
        error.message.includes('Refresh token expired') ||
        error.message.includes('Token refresh failed') ||
        error.message.includes('Failed to refresh access token')
      ) {
        throw error;
      }
      logger.error('Error refreshing Nextcloud access token', {
        component: 'NextcloudService',
        error
      });
      throw new Error(`Failed to refresh access token: ${error.message}`);
    }
  }

  async storeUserTokens(userId, tokens) {
    try {
      if (!tokens.refreshToken) {
        logger.warn(
          'No Nextcloud refresh token - user will need to reconnect when access token expires',
          { component: 'NextcloudService' }
        );
      }

      await tokenStorage.storeUserTokens(userId, this.serviceName, tokens);
      logger.info('Nextcloud tokens stored for user', {
        component: 'NextcloudService',
        userId,
        providerId: tokens.providerId
      });
      return true;
    } catch (error) {
      logger.error('Error storing Nextcloud user tokens', {
        component: 'NextcloudService',
        error
      });
      throw new Error('Failed to store user tokens');
    }
  }

  async getUserTokens(userId) {
    try {
      const tokens = await tokenStorage.getUserTokens(userId, this.serviceName);
      const expired = await tokenStorage.areTokensExpired(userId, this.serviceName);

      if (!expired) return tokens;

      logger.info('Nextcloud tokens expired, attempting refresh', {
        component: 'NextcloudService',
        userId
      });

      try {
        if (!tokens.refreshToken) {
          throw new Error('No refresh token available - user needs to reconnect Nextcloud account');
        }

        const refreshedTokens = await this.refreshAccessToken(
          tokens.providerId,
          tokens.refreshToken
        );

        // Preserve the cached username if the refresh response omitted it
        if (!refreshedTokens.nextcloudUserId && tokens.nextcloudUserId) {
          refreshedTokens.nextcloudUserId = tokens.nextcloudUserId;
        }

        await this.storeUserTokens(userId, refreshedTokens);
        logger.info('Successfully refreshed and stored Nextcloud tokens for user', {
          component: 'NextcloudService',
          userId
        });
        return refreshedTokens;
      } catch (refreshError) {
        logger.error('Failed to refresh Nextcloud tokens for user', {
          component: 'NextcloudService',
          userId,
          error: refreshError
        });
        await this.deleteUserTokens(userId);
        throw new Error('Nextcloud authentication expired. Please reconnect your account.');
      }
    } catch (error) {
      if (
        error.message.includes('not authenticated') ||
        error.message.includes('authentication expired') ||
        error.message.includes('needs to reconnect')
      ) {
        throw error;
      }
      logger.error('Error retrieving Nextcloud user tokens', {
        component: 'NextcloudService',
        error
      });
      throw new Error('Failed to retrieve user tokens');
    }
  }

  async deleteUserTokens(userId) {
    try {
      const result = await tokenStorage.deleteUserTokens(userId, this.serviceName);
      if (result) {
        logger.info('Nextcloud tokens deleted for user', {
          component: 'NextcloudService',
          userId
        });
      }
      return result;
    } catch (error) {
      logger.error('Error deleting Nextcloud user tokens', {
        component: 'NextcloudService',
        error
      });
      return false;
    }
  }

  async getTokenExpirationInfo(userId) {
    try {
      const metadata = await tokenStorage.getTokenMetadata(userId, this.serviceName);
      const now = new Date();
      const expiresAt = new Date(metadata.expiresAt);
      const minutesUntilExpiry = Math.floor((expiresAt - now) / (1000 * 60));

      return {
        expiresAt: metadata.expiresAt,
        minutesUntilExpiry,
        isExpiring: minutesUntilExpiry <= 10,
        isExpired: metadata.expired
      };
    } catch {
      return {
        expiresAt: null,
        minutesUntilExpiry: 0,
        isExpiring: true,
        isExpired: true
      };
    }
  }

  /**
   * Resolve the authenticated user's Nextcloud username (used as the
   * path segment in WebDAV URLs). Prefers the cached value from the OAuth
   * token response, falls back to the OCS API.
   */
  async _resolveNextcloudUsername(userId, tokens, provider) {
    if (tokens.nextcloudUserId) return tokens.nextcloudUserId;

    const ocsUrl = `${provider.serverUrl}/ocs/v2.php/cloud/user?format=json`;
    const response = await httpFetch(ocsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'OCS-APIREQUEST': 'true',
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to look up Nextcloud user info: ${response.statusText}`);
    }

    const data = await response.json();
    const username = data?.ocs?.data?.id;
    if (!username) {
      throw new Error('Nextcloud user info response did not include a user id');
    }

    // Cache it so future calls skip this round-trip
    const updated = { ...tokens, nextcloudUserId: username };
    await this.storeUserTokens(userId, updated);
    return username;
  }

  /**
   * Get current user info from Nextcloud's OCS API.
   */
  async getUserInfo(userId) {
    const tokens = await this.getUserTokens(userId);
    const provider = this._getProviderConfig(tokens.providerId);

    const ocsUrl = `${provider.serverUrl}/ocs/v2.php/cloud/user?format=json`;
    const response = await httpFetch(ocsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'OCS-APIREQUEST': 'true',
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get Nextcloud user info: ${response.statusText}`);
    }

    const data = await response.json();
    const ocsData = data?.ocs?.data || {};

    return {
      id: ocsData.id,
      displayName: ocsData['display-name'] || ocsData.displayname || ocsData.id,
      email: ocsData.email || null,
      serverUrl: provider.serverUrl
    };
  }

  async isUserAuthenticated(userId) {
    try {
      const tokens = await this.getUserTokens(userId);
      const provider = this._getProviderConfig(tokens.providerId);

      // Lightweight reachability check — OCS user endpoint
      const response = await httpFetch(`${provider.serverUrl}/ocs/v2.php/cloud/user?format=json`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'OCS-APIREQUEST': 'true',
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        logger.info('Nextcloud auth check returned non-OK status', {
          component: 'NextcloudService',
          userId,
          status: response.status
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.info('User Nextcloud authentication check failed', {
        component: 'NextcloudService',
        userId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Parse a WebDAV PROPFIND multistatus response into a list of items.
   * Uses a minimal regex-based parser — every iHub deployment already
   * controls its dependency tree, so adding an XML parser purely for one
   * endpoint isn't worth it. The Nextcloud PROPFIND response is shallow
   * and predictable, so regex extraction is reliable here.
   *
   * @param {string} xml - The PROPFIND multistatus body
   * @param {string} userRootPrefix - The encoded WebDAV prefix for the
   *   user's storage root (e.g. `/remote.php/dav/files/alice/`). Returned
   *   `path` values are relative to this prefix so each item is
   *   self-contained — callers don't need to remember which folder was
   *   listed to navigate into or download an item.
   */
  _parsePropfindResponse(xml, userRootPrefix) {
    const items = [];
    const responseRegex = /<d:response[\s\S]*?<\/d:response>/g;
    const responses = xml.match(responseRegex) || [];

    // Normalize so the prefix always has a single trailing slash; we
    // compare hrefs in their percent-encoded form (Nextcloud returns
    // them encoded) and only decode when extracting display names.
    const normalizedRoot = userRootPrefix.endsWith('/') ? userRootPrefix : `${userRootPrefix}/`;

    for (const responseXml of responses) {
      const hrefMatch = responseXml.match(/<d:href>([^<]+)<\/d:href>/);
      if (!hrefMatch) continue;

      // Keep `href` percent-encoded for prefix comparison. Decoding it
      // here would break the comparison for any segment containing
      // escaped characters (spaces, `%`, etc.) and could double-decode
      // filenames that happen to contain literal `%`.
      const hrefEncoded = hrefMatch[1];

      if (!hrefEncoded.startsWith(normalizedRoot)) {
        // Skip the user-root entry itself, or anything outside the
        // user's storage (shouldn't happen, but defense in depth).
        continue;
      }

      const isCollection = /<d:resourcetype>[\s\S]*?<d:collection\s*\/>/.test(responseXml);
      const sizeMatch = responseXml.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/);
      const mimeMatch = responseXml.match(/<d:getcontenttype>([^<]+)<\/d:getcontenttype>/);
      const modifiedMatch = responseXml.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/);
      const idMatch = responseXml.match(/<oc:fileid>([^<]+)<\/oc:fileid>/);

      // Trim the user-root prefix and any trailing slash (PROPFIND
      // appends `/` to collection hrefs). Then decode each segment
      // exactly once so display names with `%` round-trip correctly.
      const relativeEncoded = hrefEncoded.slice(normalizedRoot.length).replace(/\/$/, '');
      if (relativeEncoded.length === 0) continue; // user-root entry

      const segments = relativeEncoded.split('/').filter(Boolean);
      let decodedSegments;
      try {
        decodedSegments = segments.map(seg => decodeURIComponent(seg));
      } catch {
        // Malformed encoding — fall back to the raw segments rather
        // than throwing and aborting the entire listing.
        decodedSegments = segments;
      }
      const path = decodedSegments.join('/');
      const name = decodedSegments[decodedSegments.length - 1] || '';

      items.push({
        // Prefer Nextcloud's stable file id when available; fall back
        // to the path (which is unique within the user's storage).
        id: idMatch ? idMatch[1] : path,
        name,
        path,
        size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
        mimeType: mimeMatch ? mimeMatch[1] : null,
        lastModifiedDateTime: modifiedMatch ? new Date(modifiedMatch[1]).toISOString() : null,
        isFolder: isCollection,
        isFile: !isCollection
      });
    }

    return items;
  }

  _buildWebDavPath(username, relativePath = '') {
    // split('/') + filter(Boolean) handles leading/trailing/duplicate
    // slashes without needing a backtracking replace — avoids the
    // polynomial-regex CodeQL warning on user-supplied paths.
    const encoded = (relativePath || '')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
    return `/remote.php/dav/files/${encodeURIComponent(username)}/${encoded}`;
  }

  /**
   * List items in a folder (relative path within the user's files
   * directory; empty / "/" means the root).
   */
  async listItems(userId, folderPath = '') {
    const tokens = await this.getUserTokens(userId);
    const provider = this._getProviderConfig(tokens.providerId);
    const username = await this._resolveNextcloudUsername(userId, tokens, provider);

    const webdavPath = this._buildWebDavPath(username, folderPath);
    const url = `${provider.serverUrl}${webdavPath}`;

    const propfindBody = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <oc:fileid/>
  </d:prop>
</d:propfind>`;

    const response = await httpFetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Depth: '1',
        'Content-Type': 'application/xml'
      },
      body: propfindBody
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Nextcloud authentication required. Please reconnect your account.');
      }
      if (response.status === 404) {
        throw new Error(`Nextcloud folder not found: ${folderPath || '/'}`);
      }
      throw new Error(`Failed to list Nextcloud items: ${response.statusText}`);
    }

    const xml = await response.text();
    // Pass the *user-root* prefix (not the listed-folder path) so each
    // returned item carries its full path relative to the user's
    // storage root — that keeps `item.path` self-contained for the
    // client and avoids surprises when navigating into nested folders.
    const userRootPrefix = this._buildWebDavPath(username, '');
    const items = this._parsePropfindResponse(xml, userRootPrefix);
    // PROPFIND with Depth: 1 also returns the listed folder itself as
    // the first response; strip it out so the client sees only the
    // folder's contents.
    const normalizedFolder = (folderPath || '').split('/').filter(Boolean).join('/');
    return normalizedFolder.length > 0
      ? items.filter(item => item.path !== normalizedFolder)
      : items;
  }

  /**
   * Search for files using Nextcloud's WebDAV SEARCH endpoint.
   * Falls back to filtering the current folder client-side if the
   * server doesn't support DAV search.
   */
  async searchItems(userId, query, folderPath = '') {
    if (!query || query.trim().length === 0) return [];

    // Use a basic recursive PROPFIND + client-side filter. SEARCH (RFC 5323)
    // works on Nextcloud but the response shape varies between major
    // versions; folder listing + filter is portable and good enough for
    // the typical file picker workflow.
    const items = await this.listItems(userId, folderPath);
    const needle = query.trim().toLowerCase();
    return items.filter(item => item.name.toLowerCase().includes(needle));
  }

  /**
   * Download a file by its relative path within the user's Nextcloud
   * storage. Returns the file content as a Buffer plus metadata.
   */
  async downloadFile(userId, filePath) {
    if (!filePath) throw new Error('filePath is required');

    const tokens = await this.getUserTokens(userId);
    const provider = this._getProviderConfig(tokens.providerId);
    const username = await this._resolveNextcloudUsername(userId, tokens, provider);

    const webdavPath = this._buildWebDavPath(username, filePath);
    const url = `${provider.serverUrl}${webdavPath}`;

    const response = await httpFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Nextcloud authentication required. Please reconnect your account.');
      }
      if (response.status === 404) {
        throw new Error(`Nextcloud file not found: ${filePath}`);
      }
      throw new Error(`Failed to download Nextcloud file: ${response.statusText}`);
    }

    const segments = filePath.split('/').filter(Boolean);
    const name = segments[segments.length - 1] || 'download';
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const sizeHeader = response.headers.get('content-length');
    const size = sizeHeader ? parseInt(sizeHeader, 10) : 0;

    return {
      id: filePath,
      name,
      mimeType,
      size,
      content: Buffer.from(await response.arrayBuffer())
    };
  }
}

export default new NextcloudService();

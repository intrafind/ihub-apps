import crypto from 'crypto';
import { findClientById, loadOAuthClients } from '../utils/oauthClientManager.js';
import { generateCode, storeCode } from '../utils/authorizationCodeStore.js';
import { buildServerPath } from '../utils/basePath.js';
import { verifyJwt } from '../utils/tokenService.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { hasConsent, grantConsent } from '../utils/consentStore.js';

/**
 * OAuth 2.0 Authorization Code Flow - Authorization Endpoint
 * Implements RFC 6749 section 4.1 + RFC 7636 (PKCE)
 */

/**
 * Validate redirect URI against client's allowed list.
 * Performs exact string matching only — no wildcards — to prevent open redirect attacks.
 *
 * @param {string} redirectUri - Submitted redirect URI from the OAuth request.
 * @param {Array<string>} allowedUris - Client's registered redirect URI allowlist.
 * @returns {boolean} True if the URI is in the allowlist.
 */
function isValidRedirectUri(redirectUri, allowedUris) {
  if (!redirectUri || !allowedUris || allowedUris.length === 0) {
    return false;
  }
  // Exact match only - no wildcards for security
  return allowedUris.includes(redirectUri);
}

/**
 * Generate a cryptographically random CSRF token for the consent form.
 * The token is single-use and stored in the session, then verified on POST.
 *
 * @returns {string} Random 32-byte hex CSRF token (64 hex characters).
 */
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Render the consent screen HTML.
 * Produces a fully self-contained HTML page (no external CSS/JS dependencies)
 * showing the client's requested scopes and allow/deny buttons.
 *
 * @param {Object} params - Render parameters.
 * @param {Object} params.client - OAuth client object from oauthClientManager.
 * @param {Array<string>} params.scopes - Requested OAuth scopes to display.
 * @param {string} params.csrfToken - CSRF token embedded as a hidden form field.
 * @param {Object} params.oauthParams - Original OAuth query parameters passed through hidden fields.
 * @param {string} params.baseUrl - Absolute base URL of this server instance.
 * @returns {string} Complete HTML string ready to send as a response.
 */
function renderConsentScreen({ client, scopes, csrfToken, oauthParams, baseUrl }) {
  const scopeDescriptions = {
    openid: 'Verify your identity',
    profile: 'Access your name and profile information',
    email: 'Access your email address',
    offline_access: 'Access resources when you are not actively using the app (refresh tokens)'
  };

  const scopeItems = scopes
    .map(
      scope => `
    <li class="scope-item">
      <svg class="scope-icon" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
      </svg>
      <div>
        <strong>${scope}</strong>
        ${scopeDescriptions[scope] ? `<br><small>${scopeDescriptions[scope]}</small>` : ''}
      </div>
    </li>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize ${escapeHtml(client.name)} - iHub</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.12); max-width: 420px; width: 100%; padding: 32px; }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo-text { font-size: 24px; font-weight: 700; color: #1f2937; }
    .app-name { font-size: 20px; font-weight: 600; color: #111827; text-align: center; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: #6b7280; text-align: center; margin-bottom: 24px; }
    .scope-list { list-style: none; margin-bottom: 24px; }
    .scope-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; color: #374151; }
    .scope-item:last-child { border-bottom: none; }
    .scope-icon { width: 18px; height: 18px; color: #10b981; flex-shrink: 0; margin-top: 2px; }
    .scope-item small { color: #6b7280; }
    .actions { display: flex; gap: 12px; margin-top: 24px; }
    .btn { flex: 1; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: #f3f4f6; color: #374151; }
    .btn-secondary:hover { background: #e5e7eb; }
    .client-id { font-size: 12px; color: #9ca3af; text-align: center; margin-top: 16px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><span class="logo-text">iHub</span></div>
    <h1 class="app-name">${escapeHtml(client.name)}</h1>
    <p class="subtitle">wants to access your account</p>

    ${
      scopes.length > 0
        ? `
    <p style="font-size:13px;color:#6b7280;margin-bottom:12px;">This application will be able to:</p>
    <ul class="scope-list">${scopeItems}</ul>`
        : ''
    }

    <form method="POST" action="${escapeHtml(baseUrl + '/api/oauth/authorize/decision')}">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="client_id" value="${escapeHtml(oauthParams.client_id)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(oauthParams.redirect_uri)}">
      <input type="hidden" name="state" value="${escapeHtml(oauthParams.state || '')}">
      <input type="hidden" name="scope" value="${escapeHtml(oauthParams.scope || '')}">
      <input type="hidden" name="nonce" value="${escapeHtml(oauthParams.nonce || '')}">
      <div class="actions">
        <button type="submit" name="decision" value="deny" class="btn btn-secondary">Deny</button>
        <button type="submit" name="decision" value="allow" class="btn btn-primary">Allow</button>
      </div>
    </form>
    <p class="client-id">Client ID: ${escapeHtml(client.clientId)}</p>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters to prevent XSS in rendered HTML output.
 *
 * @param {*} str - Value to escape; non-strings are coerced via String().
 * @returns {string} HTML-safe string, or empty string for null/undefined.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Derive the absolute base URL from an incoming Express request.
 * Uses the same protocol/host detection pattern as wellKnown.js.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} Absolute base URL, e.g. "https://example.com/ihub".
 */
function getBaseUrl(req) {
  const protocol = req.protocol || (req.secure ? 'https' : 'http');
  const host = req.get('host');
  const basePath = buildServerPath('').replace(/\/$/, '');
  return `${protocol}://${host}${basePath}`;
}

/**
 * Register OAuth 2.0 authorization endpoint routes on the Express app.
 *
 * Routes registered:
 *   GET  /api/oauth/authorize          - Authorization endpoint (RFC 6749 §4.1.1)
 *   POST /api/oauth/authorize/decision  - Consent form submission handler
 *
 * Flow summary:
 *   1. Validate all OAuth parameters (response_type, client_id, redirect_uri, PKCE).
 *   2. If user is not logged in, store params in session and redirect to /login.
 *   3. If client is trusted (consentRequired=false), issue code immediately.
 *   4. Otherwise, render the consent screen and wait for the user's POST.
 *   5. On POST /decision, verify CSRF, re-authenticate user, generate and return code.
 *
 * @param {import('express').Application} app - The Express application instance.
 */
export default function registerOAuthAuthorizeRoutes(app) {
  /**
   * GET /api/oauth/authorize
   *
   * Authorization endpoint — validates OAuth parameters, checks the user's
   * login state (via the authToken JWT cookie), then either:
   *   a) redirects to /login (unauthenticated),
   *   b) issues a code directly (trusted client), or
   *   c) shows the consent screen (standard clients).
   *
   * Error responses follow RFC 6749 §4.1.2.1 — errors that can safely be
   * returned via redirect are sent as redirect responses; errors that cannot
   * (invalid client_id, missing redirect_uri) are returned as plain HTTP 400.
   */
  app.get(buildServerPath('/api/oauth/authorize'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return res.status(400).send('OAuth is not enabled on this server');
      }

      // Extract and validate required parameters
      const {
        response_type,
        client_id,
        redirect_uri,
        scope,
        state,
        code_challenge,
        code_challenge_method,
        nonce
      } = req.query;

      // Validate response_type — only "code" is supported (RFC 6749 §4.1)
      if (response_type !== 'code') {
        return res.status(400).send('unsupported_response_type: only "code" is supported');
      }

      // client_id is required before we can validate redirect_uri
      if (!client_id) {
        return res.status(400).send('invalid_request: client_id is required');
      }

      // Load client configuration
      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const clientsConfig = loadOAuthClients(clientsFilePath);
      const client = findClientById(clientsConfig, client_id);

      if (!client) {
        return res.status(400).send('invalid_client: unknown client_id');
      }

      if (!client.active) {
        return res.status(400).send('access_denied: client is suspended');
      }

      // Verify the client is configured to use the authorization_code grant
      if (!(client.grantTypes || []).includes('authorization_code')) {
        return res
          .status(400)
          .send('unauthorized_client: client does not support authorization_code grant');
      }

      // redirect_uri is required and must exactly match a registered value
      if (!redirect_uri) {
        return res.status(400).send('invalid_request: redirect_uri is required');
      }

      if (!isValidRedirectUri(redirect_uri, client.redirectUris || [])) {
        return res.status(400).send('invalid_request: redirect_uri not registered for this client');
      }

      // Public clients MUST use PKCE with S256 (RFC 7636 §4.4.1)
      if (client.clientType === 'public') {
        if (!code_challenge || code_challenge_method !== 'S256') {
          const errorUrl = new URL(redirect_uri);
          errorUrl.searchParams.set('error', 'invalid_request');
          errorUrl.searchParams.set(
            'error_description',
            'PKCE with S256 is required for public clients'
          );
          if (state) errorUrl.searchParams.set('state', state);
          return res.redirect(errorUrl.toString());
        }
      }

      // Parse requested scopes; default to "openid" when absent
      const requestedScopes = scope ? scope.split(' ').filter(Boolean) : ['openid'];

      // Check if user is authenticated via the authToken JWT cookie
      const token = req.cookies?.authToken;
      let currentUser = null;

      if (token) {
        const decoded = verifyJwt(token);
        if (decoded && decoded.sub) {
          currentUser = decoded;
        }
      }

      // If not logged in, persist OAuth params in session and redirect to login
      if (!currentUser) {
        if (req.session) {
          req.session.oauthParams = {
            response_type,
            client_id,
            redirect_uri,
            scope: scope || 'openid',
            state: state || '',
            code_challenge: code_challenge || '',
            code_challenge_method: code_challenge_method || '',
            nonce: nonce || ''
          };
        }

        const basePath = buildServerPath('').replace(/\/$/, '');
        const loginUrl = `${basePath}/login?returnUrl=${encodeURIComponent(req.originalUrl)}`;
        logger.info(
          `[OAuth Authorize] User not logged in, redirecting to login | client=${client_id}`
        );
        return res.redirect(loginUrl);
      }

      // User is authenticated — skip consent for trusted clients
      if (client.trusted || !client.consentRequired) {
        const code = generateCode();
        storeCode(code, {
          clientId: client_id,
          redirectUri: redirect_uri,
          userId: currentUser.sub,
          userEmail: currentUser.email || '',
          userName: currentUser.name || '',
          userGroups: currentUser.groups || [],
          scopes: requestedScopes,
          codeChallenge: code_challenge || '',
          codeChallengeMethod: code_challenge_method || 'S256',
          nonce: nonce || ''
        });

        const callbackUrl = new URL(redirect_uri);
        callbackUrl.searchParams.set('code', code);
        if (state) callbackUrl.searchParams.set('state', state);

        logger.info(
          `[OAuth Authorize] Code issued (trusted client) | client=${client_id} | user=${currentUser.sub}`
        );
        return res.redirect(callbackUrl.toString());
      }

      // Check if the user has already granted consent for this client+scope combination.
      // If so, skip the consent screen entirely and issue the authorization code immediately.
      const oauthConsentMemoryDays = oauthConfig.consentMemoryDays || 90;
      if (hasConsent(client_id, currentUser.sub, requestedScopes, oauthConsentMemoryDays)) {
        const code = generateCode();
        storeCode(code, {
          clientId: client_id,
          redirectUri: redirect_uri,
          userId: currentUser.sub,
          userEmail: currentUser.email || '',
          userName: currentUser.name || '',
          userGroups: currentUser.groups || [],
          scopes: requestedScopes,
          codeChallenge: code_challenge || '',
          codeChallengeMethod: code_challenge_method || 'S256',
          nonce: nonce || ''
        });

        const callbackUrl = new URL(redirect_uri);
        callbackUrl.searchParams.set('code', code);
        if (state) callbackUrl.searchParams.set('state', state);

        logger.info(
          `[OAuth Authorize] Code issued (remembered consent) | client=${client_id} | user=${currentUser.sub}`
        );
        return res.redirect(callbackUrl.toString());
      }

      // Show consent screen — generate CSRF token and persist params in session
      const csrfToken = generateCsrfToken();
      if (req.session) {
        req.session.csrfToken = csrfToken;
        req.session.oauthParams = {
          client_id,
          redirect_uri,
          scope: scope || 'openid',
          state: state || '',
          code_challenge: code_challenge || '',
          code_challenge_method: code_challenge_method || '',
          nonce: nonce || ''
        };
      }

      const baseUrl = getBaseUrl(req);
      const html = renderConsentScreen({
        client,
        scopes: requestedScopes,
        csrfToken,
        oauthParams: {
          client_id,
          redirect_uri,
          state: state || '',
          scope: scope || 'openid',
          nonce: nonce || ''
        },
        baseUrl
      });

      logger.info(
        `[OAuth Authorize] Showing consent screen | client=${client_id} | user=${currentUser.sub}`
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(html);
    } catch (error) {
      logger.error('[OAuth Authorize] Error in GET /authorize:', error);
      res.status(500).send('server_error: An internal error occurred');
    }
  });

  /**
   * POST /api/oauth/authorize/decision
   *
   * Handles the consent form submission from the rendered consent screen.
   *
   * Steps:
   *   1. Verify the CSRF token (constant-time comparison, single-use).
   *   2. If the user denied, redirect with error=access_denied.
   *   3. Re-validate redirect_uri against the client's allowlist.
   *   4. Re-authenticate the user (JWT cookie must still be valid).
   *   5. Retrieve stored PKCE params from session.
   *   6. Generate and store the authorization code, then redirect.
   */
  app.post(buildServerPath('/api/oauth/authorize/decision'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return res.status(400).send('OAuth is not enabled on this server');
      }

      const { _csrf, client_id, redirect_uri, state, scope, decision, nonce } = req.body;

      // Validate CSRF token — both tokens must be present
      const sessionCsrf = req.session?.csrfToken;
      if (!sessionCsrf || !_csrf) {
        return res.status(403).send('invalid_request: CSRF token missing');
      }

      // Constant-time comparison prevents timing-based CSRF bypass
      try {
        const csrfValid = crypto.timingSafeEqual(
          Buffer.from(sessionCsrf, 'utf8'),
          Buffer.from(_csrf, 'utf8')
        );
        if (!csrfValid) {
          return res.status(403).send('invalid_request: CSRF token mismatch');
        }
      } catch {
        return res.status(403).send('invalid_request: CSRF token invalid');
      }

      // Invalidate CSRF token immediately after verification (single-use)
      if (req.session) {
        delete req.session.csrfToken;
      }

      // User denied access — redirect with error per RFC 6749 §4.1.2.1
      if (decision !== 'allow') {
        const errorUrl = new URL(redirect_uri);
        errorUrl.searchParams.set('error', 'access_denied');
        errorUrl.searchParams.set('error_description', 'User denied access');
        if (state) errorUrl.searchParams.set('state', state);
        return res.redirect(errorUrl.toString());
      }

      // Re-validate redirect_uri against the registered client allowlist
      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const clientsConfig = loadOAuthClients(clientsFilePath);
      const client = findClientById(clientsConfig, client_id);

      if (!client || !isValidRedirectUri(redirect_uri, client.redirectUris || [])) {
        return res.status(400).send('invalid_request: Invalid redirect_uri');
      }

      // Re-authenticate: JWT cookie must still be valid after the consent interaction
      const token = req.cookies?.authToken;
      let currentUser = null;
      if (token) {
        const decoded = verifyJwt(token);
        if (decoded && decoded.sub) {
          currentUser = decoded;
        }
      }

      if (!currentUser) {
        return res.status(401).send('login_required: Session expired during consent');
      }

      // Retrieve PKCE parameters stored in session during GET /authorize
      const storedParams = req.session?.oauthParams || {};
      const codeChallenge = storedParams.code_challenge || '';
      const codeChallengeMethod = storedParams.code_challenge_method || '';

      // Parse requested scopes from the consent form hidden field
      const requestedScopes = scope ? scope.split(' ').filter(Boolean) : ['openid'];

      // Generate and persist the authorization code (10-minute TTL, single-use)
      const code = generateCode();
      storeCode(code, {
        clientId: client_id,
        redirectUri: redirect_uri,
        userId: currentUser.sub,
        userEmail: currentUser.email || '',
        userName: currentUser.name || '',
        userGroups: currentUser.groups || [],
        scopes: requestedScopes,
        codeChallenge,
        codeChallengeMethod,
        nonce: nonce || storedParams.nonce || ''
      });

      // Persist consent so the user is not prompted again within the TTL window.
      // Fire-and-forget: a storage failure must not block the authorization response.
      const consentMemoryDays = oauthConfig.consentMemoryDays || 90;
      grantConsent(client_id, currentUser.sub, requestedScopes, consentMemoryDays).catch(err => {
        logger.warn('[OAuth Authorize] Failed to store consent:', err.message);
      });

      const callbackUrl = new URL(redirect_uri);
      callbackUrl.searchParams.set('code', code);
      if (state) callbackUrl.searchParams.set('state', state);

      logger.info(
        `[OAuth Authorize] Authorization code issued | client=${client_id} | user=${currentUser.sub}`
      );
      return res.redirect(callbackUrl.toString());
    } catch (error) {
      logger.error('[OAuth Authorize] Error in POST /authorize/decision:', error);
      res.status(500).send('server_error: An internal error occurred');
    }
  });
}

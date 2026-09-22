import { stampDcrFirstUser } from '../utils/oauthClientManager.js';
import { resolveOAuthClient } from '../utils/oauthClientResolver.js';
import { isUserAllowedByGroups } from '../utils/oauthClientPolicy.js';
import { recordCimdDiscovery } from '../services/oauth/CimdGovernanceService.js';
import { logAudit } from '../services/AuditLogService.js';
import { generateCode, storeCode } from '../utils/authorizationCodeStore.js';
import { buildServerPath } from '../utils/basePath.js';
import { verifyJwt } from '../utils/tokenService.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { hasConsent, grantConsent } from '../utils/consentStore.js';
import { issueConsentTicket, verifyConsentTicket } from '../utils/consentTicket.js';

/**
 * OAuth 2.0 Authorization Code Flow - Authorization Endpoint
 * Implements RFC 6749 section 4.1 + RFC 7636 (PKCE)
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Whether two loopback redirect URIs differ only in their port.
 *
 * RFC 8252 §7.3: a native app listening on the loopback interface cannot
 * reserve a port in advance, so it registers `http://localhost/callback` and
 * calls back on whatever ephemeral port it got. Claude Code does exactly this
 * — its metadata document declares `http://localhost/callback` and
 * `http://127.0.0.1/callback` — so an exact comparison rejects every one of
 * its flows.
 *
 * The exception is narrow on purpose: same scheme, same loopback host, same
 * path, and nothing else. It is not an open redirect, because reaching a
 * loopback address at all requires already running code on the user's machine.
 *
 * @param {URL} registered - A registered redirect URI
 * @param {URL} presented - The redirect URI in the request
 * @returns {boolean} True when the two match under the loopback rule
 */
function loopbackMatches(registered, presented) {
  if (registered.protocol !== 'http:' || presented.protocol !== 'http:') return false;
  if (!LOOPBACK_HOSTS.has(registered.hostname) || !LOOPBACK_HOSTS.has(presented.hostname)) {
    return false;
  }
  // `localhost` and `127.0.0.1` are not interchangeable: they are different
  // hosts to the browser, and a client registers the forms it actually uses.
  if (registered.hostname !== presented.hostname) return false;
  return registered.pathname === presented.pathname && registered.search === presented.search;
}

/**
 * Validate redirect URI against client's allowed list.
 *
 * Exact string matching — no wildcards — with the single RFC 8252 §7.3
 * loopback-port exception described on {@link loopbackMatches}.
 *
 * Exported so the matching rule — the one place an open redirect could be
 * introduced — can be unit-tested directly rather than only through a full
 * authorization flow.
 *
 * @param {string} redirectUri - Submitted redirect URI from the OAuth request.
 * @param {Array<string>} allowedUris - Client's registered redirect URI allowlist.
 * @returns {boolean} True if the URI is in the allowlist.
 */
export function isValidRedirectUri(redirectUri, allowedUris) {
  if (!redirectUri || !allowedUris || allowedUris.length === 0) {
    return false;
  }
  if (allowedUris.includes(redirectUri)) return true;

  let presented;
  try {
    presented = new URL(redirectUri);
  } catch {
    return false;
  }
  if (presented.protocol !== 'http:' || !LOOPBACK_HOSTS.has(presented.hostname)) return false;

  return allowedUris.some(allowed => {
    try {
      return loopbackMatches(new URL(allowed), presented);
    } catch {
      return false;
    }
  });
}

/**
 * Whether every registered redirect URI points at the user's own machine.
 *
 * The MCP specification asks authorization servers to warn on this: any local
 * process can bind a loopback port, so the user is the only one who can tell
 * whether the application asking is the one they started.
 *
 * Exported alongside {@link isValidRedirectUri} for the same reason.
 *
 * @param {Array<string>} allowedUris - Client's registered redirect URIs
 * @returns {boolean} True when all of them are loopback
 */
export function allRedirectUrisAreLoopback(allowedUris) {
  if (!Array.isArray(allowedUris) || allowedUris.length === 0) return false;
  return allowedUris.every(uri => {
    try {
      const parsed = new URL(uri);
      return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
    } catch {
      return false;
    }
  });
}

/**
 * Render a minimal "access denied — group restriction" HTML page for users who
 * are signed in but not in any of the client's allowed groups.
 */
function renderGroupDeniedPage({ client, lang = 'en' }) {
  const name = escapeHtml(client?.name || 'application');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access denied - iHub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.12); max-width: 420px; width: 100%; padding: 32px; text-align: center; }
    h1 { font-size: 20px; color: #111827; margin-bottom: 12px; }
    p { font-size: 14px; color: #4b5563; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>This account is not enabled for ${name}</h1>
    <p>Your iHub account does not belong to any of the groups required to use this application. Please contact your administrator to request access.</p>
  </div>
</body>
</html>`;
}

/**
 * Render a plain "this client is not allowed here" page.
 *
 * A CIMD `client_id` is an arbitrary URL supplied by whoever opened the
 * authorization request, so the failure a user is most likely to hit is a host
 * their administrator has not trusted. Naming the hostname is what makes that
 * actionable — for the user, and for the administrator they forward it to.
 */
function renderClientNotAllowedPage({ host, reason, lang = 'en' }) {
  const safeHost = escapeHtml(host || 'this application');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Client not allowed - iHub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.12); max-width: 420px; width: 100%; padding: 32px; text-align: center; }
    h1 { font-size: 20px; color: #111827; margin-bottom: 12px; }
    p { font-size: 14px; color: #4b5563; line-height: 1.5; }
    code { font-size: 13px; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
    .reason { margin-top: 16px; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="card">
    <h1>This client is not allowed on this server</h1>
    <p>An application identifying itself as <code>${safeHost}</code> asked for access to your iHub account. Your administrator has not listed that host as a trusted client, so the request was refused.</p>
    <p class="reason">${escapeHtml(reason || '')}</p>
  </div>
</body>
</html>`;
}

/**
 * Turn a client that has just completed an authorization into a real, editable
 * row, if it is not one already.
 *
 * Fire-and-forget, and idempotent: the authorization has already been granted
 * by the time this runs, so a write failure must not change its outcome, and a
 * busy client must not rewrite the store on every flow.
 *
 * @param {Object} client - The resolved client
 * @param {Object} user - The user who authorized it
 * @param {Object} platform - Platform configuration
 * @returns {void}
 */
function stampCimdDiscovery(client, user, platform) {
  if (client?.kind !== 'cimd' || client.hasPolicyRecord) return;

  recordCimdDiscovery({
    clientId: client.clientId,
    platform,
    clientName: client.name,
    user
  }).catch(error => {
    logger.warn('Failed to record client discovery', {
      component: 'OAuthAuthorize',
      error: error.message
    });
  });
}

/**
 * Render the refusal page for a client an administrator has blocked.
 *
 * Separate from {@link renderClientNotAllowedPage} because the two say
 * different things to the person reading them: "your administrator has not
 * listed that host" is a configuration gap, while this one is a decision that
 * was taken about this exact software. Naming the client is what makes the
 * difference visible.
 */
function renderClientBlockedPage({ name, host, lang = 'en' }) {
  const safeName = escapeHtml(name || host || 'this application');
  const safeHost = escapeHtml(host || '');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Client blocked - iHub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.12); max-width: 420px; width: 100%; padding: 32px; text-align: center; }
    h1 { font-size: 20px; color: #111827; margin-bottom: 12px; }
    p { font-size: 14px; color: #4b5563; line-height: 1.5; }
    code { font-size: 13px; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeName} is blocked</h1>
    <p>Your administrator has blocked this application${safeHost ? ` (<code>${safeHost}</code>)` : ''} from connecting to iHub. Please contact your administrator if you need access through it.</p>
  </div>
</body>
</html>`;
}

/**
 * Render the refusal page for a client that no administrator has approved yet.
 *
 * This page *is* the feature, not a side effect of the gate: a user who adds
 * the connector in a Claude surface nobody has approved gets a sentence saying
 * exactly what to ask for, and the administrator gets a named, pending row to
 * approve rather than discovering the client later in a connections list.
 */
function renderApprovalPendingPage({ name, host, clientId, lang = 'en' }) {
  const safeName = escapeHtml(name || host || 'This application');
  const safeHost = escapeHtml(host || '');
  const safeClientId = escapeHtml(clientId || '');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Waiting for approval - iHub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.12); max-width: 460px; width: 100%; padding: 32px; text-align: center; }
    h1 { font-size: 20px; color: #111827; margin-bottom: 12px; }
    p { font-size: 14px; color: #4b5563; line-height: 1.5; }
    code { font-size: 12px; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
    .id { margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeName} needs to be approved</h1>
    <p>An application${safeHost ? ` from <code>${safeHost}</code>` : ''} asked for access to your iHub account. Applications have to be approved by an administrator before anyone can connect them.</p>
    <p>Ask your administrator to approve it under <strong>Admin &rarr; OAuth &rarr; Clients</strong>; it is already listed there as waiting. Then try connecting again.</p>
    <p class="id"><code>${safeClientId}</code></p>
  </div>
</body>
</html>`;
}

/**
 * Render the consent screen HTML.
 * Produces a fully self-contained HTML page (no external CSS/JS dependencies)
 * showing the client's requested scopes and allow/deny buttons.
 *
 * @param {Object} params - Render parameters.
 * @param {Object} params.client - OAuth client object from oauthClientManager.
 * @param {Array<string>} params.scopes - Requested OAuth scopes to display.
 * @param {string} params.consentTicket - Signed ticket carrying the consent
 *   context; the only field the decision handler trusts.
 * @param {string} params.baseUrl - Absolute base URL of this server instance.
 * @param {string} params.lang - BCP-47 primary language subtag for the HTML lang attribute (e.g. "en", "de").
 * @returns {string} Complete HTML string ready to send as a response.
 */
function renderConsentScreen({ client, scopes, consentTicket, baseUrl, lang = 'en' }) {
  const scopeDescriptions = {
    openid: 'Verify your identity',
    profile: 'Access your name and profile information',
    email: 'Access your email address',
    offline_access: 'Access resources when you are not actively using the app (refresh tokens)',
    'mcp:tools:read': 'List the iHub tools available to you',
    'mcp:tools:call': 'Run iHub tools on your behalf',
    'mcp:apps:invoke': 'Run iHub apps on your behalf',
    'mcp:workflows:run': 'Run iHub workflows on your behalf',
    'mcp:resources:read': 'Read iHub sources and skills available to you'
  };

  const scopeItems = scopes
    .map(scope => {
      const escapedScope = escapeHtml(scope);
      return `
    <li class="scope-item">
      <svg class="scope-icon" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
      </svg>
      <div>
        <strong>${escapedScope}</strong>
        ${scopeDescriptions[scope] ? `<br><small>${scopeDescriptions[scope]}</small>` : ''}
      </div>
    </li>`;
    })
    .join('');

  // The hostname is the part of a CIMD identity a user can actually judge —
  // "Claude" is a name anyone may publish, `claude.ai` is a host someone has
  // to control — so it is shown next to the name rather than only in the
  // footer.
  const host = client.host || '';
  const loopbackWarning = allRedirectUrisAreLoopback(client.redirectUris)
    ? `
    <p style="font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;margin-bottom:16px;">
      This application runs on your computer and will receive the authorization on a local port. Only continue if you started this sign-in yourself.
    </p>`
    : '';

  return `<!DOCTYPE html>
<html lang="${lang}">
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
    .client-host { font-size: 14px; color: #374151; text-align: center; margin-bottom: 4px; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><span class="logo-text">iHub</span></div>
    <h1 class="app-name">${escapeHtml(client.name)}</h1>
    ${host ? `<p class="client-host">${escapeHtml(host)}</p>` : ''}
    <p class="subtitle">wants to access your account</p>

    ${loopbackWarning}

    ${
      scopes.length > 0
        ? `
    <p style="font-size:13px;color:#6b7280;margin-bottom:12px;">This application will be able to:</p>
    <ul class="scope-list">${scopeItems}</ul>`
        : ''
    }

    <form method="POST" action="${escapeHtml(baseUrl + '/api/oauth/authorize/decision')}">
      <input type="hidden" name="consent_ticket" value="${escapeHtml(consentTicket)}">
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
 * Primary language subtag for the HTML `lang` attribute (WCAG 3.1.1).
 *
 * Only a two-letter code is accepted, so an Accept-Language header cannot
 * inject markup into the pages rendered here.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} A two-letter language code, defaulting to 'en'.
 */
function requestLang(req) {
  const acceptLang = req.headers['accept-language'];
  const raw = acceptLang ? acceptLang.split(',')[0].split('-')[0].trim() : 'en';
  return /^[a-z]{2}$/.test(raw) ? raw : 'en';
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
 *   4. Otherwise, render the consent screen carrying a signed consent ticket
 *      and wait for the user's POST.
 *   5. On POST /decision, verify the ticket, re-authenticate user, generate and
 *      return code.
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

      if (!oauthConfig.enabled?.authz) {
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

      // Resolve the client. A URL-shaped client_id is a Client ID Metadata
      // Document and is fetched here — this is the one place a fetch is
      // allowed, because it is the only step the draft requires to abort when
      // the document is unavailable.
      const resolved = await resolveOAuthClient(client_id, platform, { allowFetch: true });

      if (!resolved.ok) {
        // A client that has never been approved becomes a pending row here, so
        // the administrator the refusal page sends the user to has something
        // named to approve. Awaited: the page promises the row exists.
        if (resolved.code === 'approval_pending') {
          await recordCimdDiscovery({
            clientId: client_id,
            platform,
            clientName: resolved.clientName,
            user: null
          });
          logAudit({
            req,
            action: 'create',
            resource: 'oauthCimdClient',
            resourceId: client_id,
            summary: `Refused ${resolved.clientName || resolved.host}: the client is waiting for an administrator to approve it`,
            result: 'failure',
            source: 'api'
          });
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          return res.status(403).send(
            renderApprovalPendingPage({
              name: resolved.clientName,
              host: resolved.host,
              clientId: client_id,
              lang: requestLang(req)
            })
          );
        }

        if (resolved.code === 'client_blocked' || resolved.code === 'host_blocked') {
          logger.warn('[OAuth Authorize] Blocked client refused', {
            component: 'OAuthAuthorize',
            host: resolved.host,
            code: resolved.code
          });
          logAudit({
            req,
            action: 'delete',
            resource: 'oauthCimdClient',
            resourceId: client_id,
            summary: `Refused ${resolved.clientName || resolved.host}: the client is blocked`,
            result: 'failure',
            source: 'api'
          });
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          return res.status(403).send(
            renderClientBlockedPage({
              name: resolved.clientName,
              host: resolved.host,
              lang: requestLang(req)
            })
          );
        }

        // A rejected CIMD host is the failure a user can act on, so it gets a
        // page naming the host rather than a bare error string.
        if (resolved.host) {
          logger.warn('[OAuth Authorize] Client metadata client rejected', {
            component: 'OAuthAuthorize',
            host: resolved.host,
            reason: resolved.reason
          });
          logAudit({
            req,
            action: 'delete',
            resource: 'oauthCimd',
            resourceId: resolved.host,
            summary: `Rejected client metadata document from ${resolved.host}: ${resolved.reason}`,
            result: 'failure',
            source: 'api'
          });
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          return res.status(403).send(
            renderClientNotAllowedPage({
              host: resolved.host,
              reason: resolved.reason,
              lang: requestLang(req)
            })
          );
        }
        // Only stored-client failures reach here — every CIMD failure carries a
        // host and was answered by the page above. Their reasons are fixed
        // strings, and they stay that way: the resolver's reason is written to
        // the log, never echoed into the response, so no caller-influenced text
        // can reach the body.
        logger.warn('[OAuth Authorize] Client could not be resolved', {
          component: 'OAuthAuthorize',
          error: resolved.error,
          reason: resolved.reason
        });
        if (resolved.error === 'server_error') {
          return res.status(503).send('server_error: OAuth client store unavailable');
        }
        return res.status(400).send('invalid_client: unknown client_id');
      }

      const client = resolved.client;

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

      // Parse requested scopes. When the request carries no scope parameter,
      // fall back to the client's registered scopes (RFC 6749 §3.3 pre-defined
      // default) — MCP clients that skip the parameter still need their mcp:*
      // scopes on the token or the gateway rejects it — and to "openid" for
      // clients registered without scopes.
      const requestedScopes = scope
        ? scope.split(' ').filter(Boolean)
        : (Array.isArray(client.scopes) && client.scopes.length > 0 && client.scopes) || ['openid'];

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
            scope: requestedScopes.join(' '),
            state: state || '',
            code_challenge: code_challenge || '',
            code_challenge_method: code_challenge_method || '',
            nonce: nonce || ''
          };
        }

        const basePath = buildServerPath('').replace(/\/$/, '');
        const loginUrl = `${basePath}/login?returnUrl=${encodeURIComponent(req.originalUrl)}`;
        logger.info('[OAuth Authorize] User not logged in, redirecting to login', {
          component: 'OAuthAuthorize',
          clientId: client_id
        });
        return res.redirect(loginUrl);
      }

      // Enforce per-client group allowlist when configured
      if (!isUserAllowedByGroups(client, currentUser)) {
        logger.info('[OAuth Authorize] User denied by client group allowlist', {
          component: 'OAuthAuthorize',
          clientId: client_id,
          userId: currentUser.sub
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).send(renderGroupDeniedPage({ client, lang: requestLang(req) }));
      }

      // When the request carries MCP scopes and the platform mandates
      // consent for the gateway (mcpServer.requireConsent), force the consent
      // screen even for trusted clients — a delegated MCP token grants an
      // external agent access to the user's tools/apps/workflows, so explicit
      // per-grant consent is warranted.
      const mcpRequireConsent = platform.mcpServer?.requireConsent === true;
      const requestHasMcpScope = requestedScopes.some(s => s.startsWith('mcp:'));
      const forceConsent = mcpRequireConsent && requestHasMcpScope;

      // User is authenticated — skip consent for trusted clients (unless an
      // MCP-scoped request forces it).
      if (!forceConsent && (client.trusted || !client.consentRequired)) {
        const code = generateCode();
        storeCode(code, {
          clientId: client_id,
          redirectUri: redirect_uri,
          userId: currentUser.sub,
          userEmail: currentUser.email || '',
          userName: currentUser.name || '',
          userUsername: currentUser.username || '',
          userGroups: currentUser.groups || [],
          scopes: requestedScopes,
          codeChallenge: code_challenge || '',
          codeChallengeMethod: code_challenge_method || 'S256',
          nonce: nonce || ''
        });

        const callbackUrl = new URL(redirect_uri);
        callbackUrl.searchParams.set('code', code);
        if (state) callbackUrl.searchParams.set('state', state);

        stampCimdDiscovery(client, currentUser, platform);
        logger.info('[OAuth Authorize] Code issued (trusted client)', {
          component: 'OAuthAuthorize',
          clientId: client_id,
          userId: currentUser.sub
        });
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
          userUsername: currentUser.username || '',
          userGroups: currentUser.groups || [],
          scopes: requestedScopes,
          codeChallenge: code_challenge || '',
          codeChallengeMethod: code_challenge_method || 'S256',
          nonce: nonce || ''
        });

        const callbackUrl = new URL(redirect_uri);
        callbackUrl.searchParams.set('code', code);
        if (state) callbackUrl.searchParams.set('state', state);

        stampCimdDiscovery(client, currentUser, platform);
        logger.info('[OAuth Authorize] Code issued (remembered consent)', {
          component: 'OAuthAuthorize',
          clientId: client_id,
          userId: currentUser.sub
        });
        return res.redirect(callbackUrl.toString());
      }

      // Show consent screen. The whole consent context travels inside a signed
      // ticket in the form rather than in a session: the decision POST can land
      // on any worker, and a per-process session store would lose the PKCE
      // challenge and the CSRF token there. See utils/consentTicket.js.
      const consentTicket = issueConsentTicket({
        clientId: client_id,
        redirectUri: redirect_uri,
        scope: requestedScopes.join(' '),
        state: state || '',
        codeChallenge: code_challenge || '',
        codeChallengeMethod: code_challenge_method || '',
        nonce: nonce || '',
        userId: currentUser.sub
      });

      const baseUrl = getBaseUrl(req);
      const html = renderConsentScreen({
        client,
        scopes: requestedScopes,
        consentTicket,
        baseUrl,
        lang: requestLang(req)
      });

      logger.info('[OAuth Authorize] Showing consent screen', {
        component: 'OAuthAuthorize',
        clientId: client_id,
        userId: currentUser.sub
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(html);
    } catch (error) {
      logger.error('[OAuth Authorize] Error in GET /authorize', {
        component: 'OAuthAuthorize',
        error
      });
      res.status(500).send('server_error: An internal error occurred');
    }
  });

  /**
   * POST /api/oauth/authorize/decision
   *
   * Handles the consent form submission from the rendered consent screen.
   *
   * Every consent parameter is read from the signed ticket rather than the POST
   * body, so this handler holds no per-worker state and works on whichever
   * worker the browser's POST happens to reach.
   *
   * Steps:
   *   1. Verify the consent ticket's signature and expiry.
   *   2. Re-authenticate the user (JWT cookie must still be valid).
   *   3. Check the ticket was issued for that user (CSRF binding).
   *   4. Re-validate redirect_uri against the client's allowlist.
   *   5. If the user denied, redirect with error=access_denied.
   *   6. Generate and store the authorization code, then redirect.
   */
  app.post(buildServerPath('/api/oauth/authorize/decision'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled?.authz) {
        return res.status(400).send('OAuth is not enabled on this server');
      }

      const { consent_ticket, decision } = req.body;

      // Every consent parameter comes from the signed ticket, never from the
      // POST body — a tampered redirect_uri, scope or code_challenge breaks the
      // signature instead of being taken at face value.
      const ticket = verifyConsentTicket(consent_ticket);
      if (!ticket) {
        logger.warn('[OAuth Authorize] Rejected consent decision with invalid ticket', {
          component: 'OAuthAuthorize'
        });
        return res.status(403).send('invalid_request: consent ticket missing, invalid or expired');
      }

      const {
        clientId: client_id,
        redirectUri: redirect_uri,
        state,
        scope,
        nonce,
        codeChallenge,
        codeChallengeMethod
      } = ticket;

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

      // The ticket is bound to the user it was issued for. This is what makes
      // the endpoint CSRF-safe: a ticket obtained by an attacker cannot drive
      // consent under a victim's cookie, and one cannot be forged without the
      // signing key.
      if (ticket.userId !== currentUser.sub) {
        logger.warn('[OAuth Authorize] Consent ticket does not match the signed-in user', {
          component: 'OAuthAuthorize',
          clientId: client_id
        });
        return res.status(403).send('invalid_request: consent ticket was issued for another user');
      }

      // Re-validate redirect_uri against the registered client allowlist — the
      // ticket proves the URI passed at GET time, this catches a client whose
      // registration (or metadata document) changed since. A fetch is allowed
      // here for the same reason as on GET: in cluster mode this POST can land
      // on a worker whose document cache is cold.
      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const resolved = await resolveOAuthClient(client_id, platform, { allowFetch: true });
      const client = resolved.ok ? resolved.client : null;

      if (!client || !client.active) {
        return res.status(400).send('invalid_client: unknown or suspended client_id');
      }

      if (!isValidRedirectUri(redirect_uri, client.redirectUris || [])) {
        return res.status(400).send('invalid_request: Invalid redirect_uri');
      }

      // User denied access — redirect with error per RFC 6749 §4.1.2.1
      if (decision !== 'allow') {
        const errorUrl = new URL(redirect_uri);
        errorUrl.searchParams.set('error', 'access_denied');
        errorUrl.searchParams.set('error_description', 'User denied access');
        if (state) errorUrl.searchParams.set('state', state);
        return res.redirect(errorUrl.toString());
      }

      // Re-check group allowlist on the decision step in case membership changed
      if (!isUserAllowedByGroups(client, currentUser)) {
        const errorUrl = new URL(redirect_uri);
        errorUrl.searchParams.set('error', 'access_denied');
        errorUrl.searchParams.set(
          'error_description',
          'User is not in any of the groups required by this client'
        );
        if (state) errorUrl.searchParams.set('state', state);
        return res.redirect(errorUrl.toString());
      }

      // Scopes as granted on the screen the user actually saw
      const requestedScopes = scope ? scope.split(' ').filter(Boolean) : ['openid'];

      // Generate and persist the authorization code (10-minute TTL, single-use)
      const code = generateCode();
      storeCode(code, {
        clientId: client_id,
        redirectUri: redirect_uri,
        userId: currentUser.sub,
        userEmail: currentUser.email || '',
        userName: currentUser.name || '',
        userUsername: currentUser.username || '',
        userGroups: currentUser.groups || [],
        scopes: requestedScopes,
        codeChallenge,
        codeChallengeMethod,
        nonce: nonce || ''
      });

      // Persist consent so the user is not prompted again within the TTL window.
      // Fire-and-forget: a storage failure must not block the authorization response.
      // The display snapshots travel with the grant because there is often
      // nothing left to join against later: a CIMD client has no stored
      // record, and an OIDC or proxy user has no local account.
      const consentMemoryDays = oauthConfig.consentMemoryDays || 90;
      grantConsent(client_id, currentUser.sub, requestedScopes, consentMemoryDays, {
        clientName: client.name,
        clientHost: client.host || '',
        clientKind: client.kind || 'stored',
        userName: currentUser.name || currentUser.username || '',
        userEmail: currentUser.email || ''
      }).catch(err => {
        logger.warn('Failed to store consent', { component: 'OAuthAuthorize', error: err });
      });

      logAudit({
        req,
        action: 'create',
        resource: 'oauthConnection',
        resourceId: `${client_id}:${currentUser.sub}`,
        summary: `${currentUser.name || currentUser.sub} granted ${client.name}${
          client.host ? ` (${client.host})` : ''
        } the scopes ${requestedScopes.join(' ')}`,
        source: 'web'
      });

      // A dynamically registered client has no owner — registration happens
      // before anyone signs in. The first consent is the earliest point the
      // server knows a person, so stamp them for display in the admin list.
      // Fire-and-forget for the same reason as the consent write above.
      if (client.metadata?.dcr === true && !client.metadata?.firstUserId) {
        stampDcrFirstUser(client_id, currentUser, clientsFilePath).catch(err => {
          logger.warn('Failed to stamp first consenting user', {
            component: 'OAuthAuthorize',
            error: err
          });
        });
      }

      // The first consent is also the moment a metadata-document client stops
      // being anonymous to the administrator: it becomes a row with a name, a
      // first-seen date and the person who brought it in.
      stampCimdDiscovery(client, currentUser, platform);

      const callbackUrl = new URL(redirect_uri);
      callbackUrl.searchParams.set('code', code);
      if (state) callbackUrl.searchParams.set('state', state);

      logger.info('[OAuth Authorize] Authorization code issued', {
        component: 'OAuthAuthorize',
        clientId: client_id,
        userId: currentUser.sub
      });
      return res.redirect(callbackUrl.toString());
    } catch (error) {
      logger.error('[OAuth Authorize] Error in POST /authorize/decision', {
        component: 'OAuthAuthorize',
        error
      });
      res.status(500).send('server_error: An internal error occurred');
    }
  });
}

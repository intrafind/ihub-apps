// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sign-in for iHub in a frame of another site. See `utils/embedAuth.js` for why
 * it runs in a popup and ends in a partitioned `HttpOnly` cookie.
 *
 *   1. The framed page makes a PKCE verifier and opens the popup on
 *      `GET /embed-auth/complete?challenge=<S256 of the verifier>`.
 *   2. The popup is a top-level window, so the identity provider can show its
 *      login. When the person is signed in, the page asks
 *      `POST /api/auth/embed-codes/_issue` for a one-time code and hands it to
 *      the page that opened it with `postMessage`.
 *   3. The framed page redeems it with `POST /api/auth/embed-codes/_redeem`
 *      together with the verifier. The response sets the session cookie.
 *
 * The code alone is worth nothing: it lives 60 seconds, works once, and only the
 * page that holds the verifier can redeem it.
 *
 * @module routes/embedAuth
 */

import configCache from '../configCache.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import logger from '../utils/logger.js';
import { generateCode, storeCode, consumeCode } from '../utils/authorizationCodeStore.js';
import { verifyCodeChallenge } from '../utils/pkceUtils.js';
import { isValidId } from '../utils/pathSecurity.js';
import { verifyJwt } from '../utils/tokenService.js';
import { applyFrameAncestorsCsp } from '../utils/frameAncestors.js';
import { createEmbedAuthLimiter } from '../middleware/rateLimiting.js';
import jwtAuthMiddleware from '../middleware/jwtAuth.js';
import { recordAuthEvent } from '../telemetry/metrics.js';
import { logAudit } from '../services/AuditLogService.js';
import {
  EMBED_CODE_PURPOSE,
  EMBED_CODE_TTL_MS,
  isEmbedAuthEnabled,
  isSameOriginRequest,
  isValidCodeChallenge,
  isValidCodeVerifier,
  serializeEmbedSessionCookie
} from '../utils/embedAuth.js';

/** Message the popup page posts to the page that opened it. */
export const EMBED_AUTH_MESSAGE_KIND = 'ihub.embedAuth.code';

const PAGE_TEXT = {
  en: {
    title: 'Signing in…',
    working: 'Signing in…',
    noOpener:
      'This window cannot return to the page that opened it. Close it and try signing in again.',
    failed: 'The sign-in could not be completed. Close this window and try again.',
    disabled: 'Signing in inside another site is not enabled.',
    invalid: 'This sign-in link is not valid.'
  },
  de: {
    title: 'Anmeldung…',
    working: 'Anmeldung…',
    noOpener:
      'Dieses Fenster kann nicht zur aufrufenden Seite zurückkehren. Schließen Sie es und melden Sie sich erneut an.',
    failed:
      'Die Anmeldung konnte nicht abgeschlossen werden. Schließen Sie dieses Fenster und versuchen Sie es erneut.',
    disabled: 'Die Anmeldung innerhalb einer anderen Website ist nicht aktiviert.',
    invalid: 'Dieser Anmeldelink ist nicht gültig.'
  }
};

function pickLanguage(req) {
  return req.acceptsLanguages('de', 'en') === 'de' ? 'de' : 'en';
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/**
 * The page of the popup. It needs no framework: it asks for the code, passes it
 * on and closes. The challenge is checked against a strict pattern before it is
 * put into an attribute; every text is escaped.
 */
function renderCompletePage({ language, challenge, issueUrl }) {
  const text = PAGE_TEXT[language];
  const messages = JSON.stringify({ noOpener: text.noOpener, failed: text.failed }).replaceAll(
    '<',
    '\\u003c'
  );
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${escapeHtml(text.title)}</title>
    <style>
      body { font-family: system-ui, 'Segoe UI', sans-serif; margin: 0; padding: 24px; color: #1f2937; background: #fff; }
      @media (prefers-color-scheme: dark) { body { color: #e5e7eb; background: #111827; } }
    </style>
  </head>
  <body data-challenge="${escapeHtml(challenge)}" data-issue-url="${escapeHtml(issueUrl)}">
    <p id="status" role="status">${escapeHtml(text.working)}</p>
    <script>
      (function () {
        var messages = ${messages};
        var status = document.getElementById('status');
        function fail(message) {
          status.textContent = message;
          status.setAttribute('role', 'alert');
        }
        if (!window.opener) {
          fail(messages.noOpener);
          return;
        }
        var body = document.body;
        fetch(body.getAttribute('data-issue-url'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ codeChallenge: body.getAttribute('data-challenge') })
        })
          .then(function (response) {
            if (!response.ok) throw new Error('issue failed');
            return response.json();
          })
          .then(function (data) {
            // The page that opened this window is iHub itself, so only that origin may receive it.
            window.opener.postMessage(
              { kind: ${JSON.stringify(EMBED_AUTH_MESSAGE_KIND)}, code: data.code },
              window.location.origin
            );
            window.close();
          })
          .catch(function () {
            fail(messages.failed);
          });
      })();
    </script>
  </body>
</html>`;
}

function renderMessagePage(language, message) {
  const text = PAGE_TEXT[language];
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(text.title)}</title></head><body style="font-family: system-ui, sans-serif; padding: 24px"><p>${escapeHtml(message)}</p></body></html>`;
}

/**
 * Register the routes of the sign-in for a framed iHub.
 *
 * @param {import('express').Express} app
 */
export default function registerEmbedAuthRoutes(app) {
  // At registration there is no request, so these are the bare paths the routes match on. The
  // URLs the pages send to the browser are built per request below: behind a reverse proxy under
  // a sub-path (`X-Forwarded-Prefix`) they carry the prefix.
  const completePath = buildServerPath('/embed-auth/complete');
  const issuePath = buildServerPath('/api/auth/embed-codes/_issue');
  const redeemPath = buildServerPath('/api/auth/embed-codes/_redeem');

  // The popup page and the two code endpoints spend one budget per address. `/api/auth` has a
  // limiter of its own; the page is outside it, and a limiter the route mounts itself is what
  // the other sign-in related routes do (routes/oauth.js).
  const limiter = createEmbedAuthLimiter(app.get('platform') || configCache.getPlatform());

  /**
   * The popup lands here. Signed out, it is sent to the normal login (or straight to the
   * `provider` the person picked in the frame) and comes back; signed in, it asks for the code
   * and returns to the page that opened it.
   *
   * Not an API: a page for the person in the popup, so it answers with HTML and
   * may redirect. It changes nothing by itself; the code is issued by the POST
   * the page makes.
   */
  // The auth chain (middleware/setup.js) skips every path without a file extension that is not
  // under /api: those are the pages of the single-page app. This page is one of them, so on its
  // own `req.user` would never be set and a signed-in visitor would be sent to the login, and
  // back here, for ever. It reads the session cookie itself, like the auth chain would.
  app.get(completePath, limiter, jwtAuthMiddleware, (req, res) => {
    const language = pickLanguage(req);
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    // Nobody has a reason to frame this page.
    applyFrameAncestorsCsp(res, []);

    const platform = configCache.getPlatform() || {};
    if (!isEmbedAuthEnabled(platform)) {
      return res
        .status(404)
        .type('html')
        .send(renderMessagePage(language, PAGE_TEXT[language].disabled));
    }

    const challenge = req.query.challenge;
    if (!isValidCodeChallenge(challenge)) {
      return res
        .status(400)
        .type('html')
        .send(renderMessagePage(language, PAGE_TEXT[language].invalid));
    }

    const signedIn = Boolean(req.user && req.user.id !== 'anonymous');
    if (!signedIn) {
      const returnUrl = encodeURIComponent(
        `${buildServerPath('/embed-auth/complete')}?challenge=${challenge}`
      );
      // The person already picked a provider in the frame: go straight to it instead of asking again.
      const provider = req.query.provider;
      if (typeof provider === 'string' && isValidId(provider)) {
        const start = buildServerPath(`/api/auth/oidc/${encodeURIComponent(provider)}`);
        return res.redirect(302, `${start}?returnUrl=${returnUrl}`);
      }
      return res.redirect(302, `${buildServerPath('/login')}?returnUrl=${returnUrl}`);
    }

    res.type('html').send(
      renderCompletePage({
        language,
        challenge,
        issueUrl: buildServerPath('/api/auth/embed-codes/_issue')
      })
    );
  });

  /**
   * @swagger
   * /auth/embed-codes/_issue:
   *   post:
   *     summary: Issue a one-time code for the sign-in of a framed iHub
   *     description: >
   *       Called by the popup page after the person has signed in. The code is bound to the PKCE
   *       challenge, lives 60 seconds and works once. Requires a signed-in session (the `authToken`
   *       cookie) and a request made by an iHub page itself (`Sec-Fetch-Site: same-origin`).
   *     tags:
   *       - Authentication
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [codeChallenge]
   *             properties:
   *               codeChallenge:
   *                 type: string
   *                 description: BASE64URL(SHA-256(codeVerifier)), 43 characters
   *     responses:
   *       200:
   *         description: The code
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 code: { type: string }
   *                 expiresInSeconds: { type: integer }
   *       400:
   *         description: "`BAD_REQUEST`, the challenge is malformed or the sign-in has no iHub session token"
   *       401:
   *         description: "`AUTH_REQUIRED`, not signed in"
   *       403:
   *         description: "`EMBED_SIGN_IN_DISABLED` or `FORBIDDEN` (not a same-origin request)"
   */
  app.post(issuePath, limiter, async (req, res) => {
    const platform = configCache.getPlatform() || {};
    if (!isEmbedAuthEnabled(platform)) {
      throw new ServiceError(
        'EMBED_SIGN_IN_DISABLED',
        'Signing in inside another site is not enabled'
      );
    }
    if (!isSameOriginRequest(req)) {
      throw new ServiceError('FORBIDDEN', 'The code can only be requested by an iHub page');
    }
    if (!req.user || req.user.id === 'anonymous') {
      throw new ServiceError('AUTH_REQUIRED', 'Sign in first');
    }

    const codeChallenge = req.body?.codeChallenge;
    if (!isValidCodeChallenge(codeChallenge)) {
      throw new ServiceError(
        'BAD_REQUEST',
        'codeChallenge must be a 43 character base64url SHA-256'
      );
    }

    // The framed session is the session token the sign-in just set, so it carries
    // exactly the claims of that sign-in. A sign-in that has none (a reverse proxy
    // or an API client names the user on every request) has nothing to hand over,
    // and needs no cookie either.
    const sessionToken = req.cookies?.authToken;
    if (!sessionToken || !verifyJwt(sessionToken)) {
      throw new ServiceError('BAD_REQUEST', 'This sign-in has no iHub session to hand over');
    }

    const code = generateCode();
    storeCode(
      code,
      { purpose: EMBED_CODE_PURPOSE, userId: req.user.id, sessionToken, codeChallenge },
      { ttlMs: EMBED_CODE_TTL_MS }
    );

    res.set('Cache-Control', 'no-store');
    res.json({ code, expiresInSeconds: EMBED_CODE_TTL_MS / 1000 });
  });

  /**
   * @swagger
   * /auth/embed-codes/_redeem:
   *   post:
   *     summary: Redeem the one-time code for the session cookie of a framed iHub
   *     description: >
   *       Called by the framed page with the code from the popup and its PKCE verifier. The
   *       response sets the `authTokenEmbed` cookie (`HttpOnly; Secure; SameSite=None;
   *       Partitioned`); no token is in the body. Unauthenticated: the code is the credential.
   *     tags:
   *       - Authentication
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [code, codeVerifier]
   *             properties:
   *               code: { type: string }
   *               codeVerifier: { type: string, description: 43 to 128 characters }
   *     responses:
   *       200:
   *         description: The session cookie is set
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 expiresInSeconds: { type: integer }
   *       400:
   *         description: "`BAD_REQUEST` (malformed) or `EMBED_CODE_INVALID` (unknown, used, expired, or wrong verifier)"
   *       403:
   *         description: "`EMBED_SIGN_IN_DISABLED` or `FORBIDDEN` (not a same-origin request)"
   */
  app.post(redeemPath, limiter, async (req, res) => {
    const platform = configCache.getPlatform() || {};
    if (!isEmbedAuthEnabled(platform)) {
      throw new ServiceError(
        'EMBED_SIGN_IN_DISABLED',
        'Signing in inside another site is not enabled'
      );
    }
    if (!isSameOriginRequest(req)) {
      throw new ServiceError('FORBIDDEN', 'The code can only be redeemed by an iHub page');
    }

    const { code, codeVerifier } = req.body || {};
    if (typeof code !== 'string' || code.length === 0 || code.length > 256) {
      throw new ServiceError('BAD_REQUEST', 'code is required');
    }
    if (!isValidCodeVerifier(codeVerifier)) {
      throw new ServiceError('BAD_REQUEST', 'codeVerifier must be 43 to 128 base64url characters');
    }

    const invalid = () => new ServiceError('EMBED_CODE_INVALID', 'The code is invalid or expired');

    // Consuming destroys the code, whether or not the verifier fits: one try per code.
    const data = await consumeCode(code);
    if (!data || data.purpose !== EMBED_CODE_PURPOSE) throw invalid();
    if (!verifyCodeChallenge(codeVerifier, data.codeChallenge, 'S256')) throw invalid();

    const payload = verifyJwt(data.sessionToken);
    const maxAgeSeconds = payload?.exp ? payload.exp - Math.floor(Date.now() / 1000) : 0;
    if (maxAgeSeconds <= 0) throw invalid();

    res.append('Set-Cookie', serializeEmbedSessionCookie(data.sessionToken, maxAgeSeconds));
    res.set('Cache-Control', 'no-store');

    recordAuthEvent(payload.authMode || 'unknown', 'embed_login_success');
    logAudit({
      req,
      action: 'login',
      resource: 'auth',
      resourceId: data.userId,
      summary: 'Sign-in inside a frame of another site',
      source: 'web',
      actor: {
        id: data.userId,
        username: payload.username ?? payload.name ?? data.userId,
        name: payload.name ?? payload.username ?? data.userId,
        groups: payload.groups || [],
        authenticated: true
      }
    });
    logger.info('Framed session started', { component: 'EmbedAuth', authMode: payload.authMode });

    res.json({ expiresInSeconds: maxAgeSeconds });
  });
}

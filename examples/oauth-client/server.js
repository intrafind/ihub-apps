import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Global rate limiter to protect all routes, including those that access the filesystem.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // disable the `X-RateLimit-*` headers
});

app.use(globalLimiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiter for the dashboard route to protect file system access
const dashboardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // limit each IP to 100 dashboard requests per windowMs
});

// Simple in-memory session store (for demo only - use redis/express-session in production)
const sessions = new Map();

const IHUB_URL = process.env.IHUB_URL || 'http://localhost:3000';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:8080';
const CLIENT_MODE = process.env.CLIENT_MODE || 'confidential';
const PORT = parseInt(process.env.PORT || '8080', 10);

const REDIRECT_URI = `${APP_URL}/callback`;

if (!CLIENT_ID) {
  console.error('ERROR: CLIENT_ID is required. Copy .env.example to .env and configure it.');
  process.exit(1);
}

/**
 * Generates a cryptographically random base64url-encoded string.
 * Used for PKCE code verifiers, state parameters, and nonces.
 *
 * @param {number} bytes - Number of random bytes to generate (default: 32)
 * @returns {string} Random base64url-encoded string
 */
function randomBase64url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Generates a PKCE S256 code challenge from a code verifier.
 * The challenge is the SHA-256 hash of the verifier, base64url-encoded.
 * See RFC 7636 for the PKCE specification.
 *
 * @param {string} verifier - The PKCE code verifier string
 * @returns {string} The S256 code challenge
 */
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Simple cookie-based session middleware for demo purposes.
 * Reads the session ID from the `session` cookie, loads the session
 * from the in-memory store, and attaches it to `req.session`.
 * Also attaches `req.saveSession()` to persist session changes.
 *
 * NOTE: This is intentionally minimal for demonstration. In production,
 * use a proper session library (e.g., express-session with connect-redis).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function sessionMiddleware(req, res, next) {
  const sessionId = req.headers.cookie?.match(/session=([^;]+)/)?.[1];
  req.session = sessionId ? (sessions.get(sessionId) || {}) : {};
  req.sessionId = sessionId || randomBase64url(16);
  req.saveSession = () => {
    sessions.set(req.sessionId, req.session);
    res.setHeader('Set-Cookie', `session=${req.sessionId}; HttpOnly; Path=/; Max-Age=3600`);
  };
  next();
}

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ---- Routes ----

/**
 * Home page - served from public/index.html.
 * Shows login button if the user is not authenticated.
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Login - initiates the OAuth 2.0 Authorization Code Flow.
 *
 * Generates a CSRF state token and PKCE code verifier/challenge, stores
 * them in the session, then redirects the user to iHub's authorization
 * endpoint. Both confidential and public clients use PKCE in this example
 * (PKCE is recommended for all client types per OAuth 2.1 security best
 * practices). The difference is that confidential clients also present a
 * client_secret at the token endpoint.
 */
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // limit each IP to 30 login attempts per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/login', loginLimiter, (req, res) => {
  const state = randomBase64url(16);
  const nonce = randomBase64url(16);

  // Store state in session for CSRF protection
  req.session.state = state;
  req.session.nonce = nonce;

  // Both modes use PKCE; confidential mode additionally sends client_secret
  // at the token endpoint (see /callback handler below)
  const codeVerifier = randomBase64url(32);
  const codeChallenge = generateCodeChallenge(codeVerifier);
  req.session.codeVerifier = codeVerifier;
  req.saveSession();

  // Confidential clients can request offline_access (refresh tokens);
  // public clients typically do not get long-lived refresh tokens
  const scope =
    CLIENT_MODE === 'public'
      ? 'openid profile email'
      : 'openid profile email offline_access';

  const authUrl = new URL(`${IHUB_URL}/api/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log(`[Login] Redirecting to iHub | mode=${CLIENT_MODE} | state=${state}`);
  res.redirect(authUrl.toString());
});

/**
 * Callback - handles the redirect from iHub after user authorization.
 *
 * Validates the state parameter against the stored session value (CSRF
 * protection), then exchanges the authorization code for tokens at iHub's
 * token endpoint. After a successful exchange, fetches the user profile
 * from the userinfo endpoint and stores everything in the session.
 *
 * Token exchange request:
 *   - All clients: grant_type, code, redirect_uri, client_id, code_verifier
 *   - Confidential clients additionally: client_secret
 */
app.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`OAuth Error: ${error} - ${error_description}`);
  }

  // Verify state to prevent CSRF attacks
  if (state !== req.session.state) {
    return res.status(400).send('State mismatch - possible CSRF attack');
  }

  try {
    // Build token exchange request body
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: req.session.codeVerifier || ''
    });

    // Confidential clients authenticate with client_secret
    if (CLIENT_MODE !== 'public' && CLIENT_SECRET) {
      tokenBody.set('client_secret', CLIENT_SECRET);
    }

    const tokenResponse = await fetch(`${IHUB_URL}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString()
    });

    if (!tokenResponse.ok) {
      const tokenError = await tokenResponse.json();
      console.error('[Callback] Token exchange failed:', tokenError);
      return res.status(400).send(`Token exchange failed: ${JSON.stringify(tokenError)}`);
    }

    const tokens = await tokenResponse.json();
    console.log(
      `[Callback] Tokens received | expires_in=${tokens.expires_in} | has_refresh=${!!tokens.refresh_token}`
    );

    // Fetch user profile using the access token
    const userInfoResponse = await fetch(`${IHUB_URL}/api/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const userInfo = userInfoResponse.ok ? await userInfoResponse.json() : {};

    // Persist tokens and user info in session; clear one-time PKCE/state values
    req.session.tokens = tokens;
    req.session.userInfo = userInfo;
    req.session.state = null;
    req.session.codeVerifier = null;
    req.saveSession();

    console.log(`[Callback] User logged in | sub=${userInfo.sub} | name=${userInfo.name}`);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[Callback] Error:', err);
    res.status(500).send(`Internal error: ${err.message}`);
  }
});

/**
 * Dashboard - protected page shown after successful login.
 * Redirects to home if the user has no active session.
 */
app.get('/dashboard', dashboardLimiter, (req, res) => {
  if (!req.session.tokens) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

/**
 * GET /api/session
 *
 * Returns the current session data for the dashboard page to display.
 * JWT payloads are decoded (without signature verification) for display
 * purposes only. Raw token strings are intentionally omitted from the
 * response to avoid accidental exposure in browser developer tools.
 *
 * @returns {object} Session data including decoded token claims and user info
 */
app.get('/api/session', (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { access_token, id_token, refresh_token, expires_in, scope } = req.session.tokens;

  /**
   * Decodes a JWT payload section without verifying the signature.
   * Used for display purposes only - never trust unverified JWT data
   * for authorization decisions.
   *
   * @param {string} token - JWT string
   * @returns {object|null} Decoded payload or null on failure
   */
  function decodeJwtPayload(token) {
    if (!token) return null;
    try {
      const parts = token.split('.');
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  res.json({
    userInfo: req.session.userInfo,
    tokens: {
      access_token_decoded: decodeJwtPayload(access_token),
      id_token_decoded: decodeJwtPayload(id_token),
      has_refresh_token: !!refresh_token,
      expires_in,
      scope
    },
    clientMode: CLIENT_MODE,
    ihubUrl: IHUB_URL
  });
});

/**
 * POST /api/refresh
 *
 * Exchanges the stored refresh token for a new access token.
 * Updates the session with the new token set on success.
 * Only available when the session contains a refresh_token
 * (requires offline_access scope and confidential client type).
 *
 * @returns {object} Success indicator and new expires_in value
 */
app.post('/api/refresh', async (req, res) => {
  if (!req.session.tokens?.refresh_token) {
    return res.status(400).json({ error: 'No refresh token available' });
  }

  try {
    const tokenBody = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: req.session.tokens.refresh_token,
      client_id: CLIENT_ID
    });

    if (CLIENT_MODE !== 'public' && CLIENT_SECRET) {
      tokenBody.set('client_secret', CLIENT_SECRET);
    }

    const response = await fetch(`${IHUB_URL}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString()
    });

    if (!response.ok) {
      const refreshError = await response.json();
      return res.status(400).json({ error: 'Refresh failed', details: refreshError });
    }

    const newTokens = await response.json();
    req.session.tokens = newTokens;
    req.saveSession();

    console.log('[Refresh] Token refreshed successfully');
    res.json({ success: true, expires_in: newTokens.expires_in });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /logout
 *
 * Revokes the refresh token at iHub's revocation endpoint (RFC 7009),
 * then destroys the local session and clears the session cookie.
 * Best-effort revocation: logout proceeds even if the revocation
 * request fails (e.g., due to a network error).
 */
app.post('/logout', async (req, res) => {
  if (req.session.tokens?.refresh_token) {
    try {
      await fetch(`${IHUB_URL}/api/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: req.session.tokens.refresh_token }).toString()
      });
    } catch (err) {
      console.warn('[Logout] Failed to revoke refresh token:', err.message);
    }
  }

  sessions.delete(req.sessionId);
  res.clearCookie('session');
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`\niHub OAuth Example Client running at http://localhost:${PORT}`);
  console.log(`   Mode: ${CLIENT_MODE}`);
  console.log(`   iHub URL: ${IHUB_URL}`);
  console.log(`   Client ID: ${CLIENT_ID}`);
  console.log(`   Redirect URI: ${REDIRECT_URI}`);
  console.log(`\n   Register this redirect URI in iHub Admin -> OAuth Clients\n`);
});

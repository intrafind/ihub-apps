/**
 * OAuth Client ID Metadata Documents (CIMD).
 *
 * A CIMD client's `client_id` *is* an HTTPS URL pointing at a JSON document the
 * client hosts. The authorization server fetches it, checks that the document's
 * own `client_id` equals the URL it was fetched from, and takes `client_name`,
 * `redirect_uris`, `grant_types` and `token_endpoint_auth_method` from it.
 * Nothing is stored on our side — the URL is the stable identity.
 *
 * This is what stops Claude calling `/api/oauth/register` at all: Claude picks
 * its identity in a fixed order (pre-registered credentials → CIMD, when the
 * authorization-server metadata advertises `client_id_metadata_document_supported`
 * *and* `none` in `token_endpoint_auth_methods_supported` → dynamic
 * registration). The MCP specification (2025-11-25) makes CIMD a SHOULD and
 * DCR a backwards-compatibility MAY.
 *
 * Everything here is deliberately paranoid, because the `client_id` in an
 * authorization request is attacker-controlled:
 *
 *   1. The host allowlist (`oauth.cimd.allowedClientHosts`) is checked BEFORE
 *      any network call, so an unlisted host never causes an outbound request.
 *   2. The fetch goes through `utils/ssrfGuard.js` — a public hostname that
 *      resolves to a private address is refused, and the connection is pinned
 *      to the addresses that passed the check so DNS cannot rebind under it.
 *   3. No redirects are followed, the body is capped, the response must be
 *      JSON, and the request times out.
 *   4. Only structurally valid documents are cached. Failures never are.
 *
 * @module utils/clientIdMetadata
 */
import { validateRedirectUri } from './dcrValidation.js';
import { assertPublicTarget, createPinnedLookup } from './ssrfGuard.js';
import { hostMatchesPattern } from '../services/mcp/safeFetch.js';
import { httpFetch } from './httpConfig.js';
import logger from './logger.js';

/** Hard ceiling on the length of a `client_id` URL. */
const MAX_CLIENT_ID_LENGTH = 2000;

/**
 * Body size cap. The draft recommends 5 KB; Claude's document is ~400 bytes.
 * 8 KB leaves room for a document with several redirect URIs without giving a
 * hostile host a way to make the server buffer anything meaningful.
 */
const MAX_DOCUMENT_BYTES = 8 * 1024;

/** Cache TTL floor, so a `max-age: 0` cannot turn every authorize into a fetch. */
const MIN_CACHE_SECONDS = 300;

/** Default TTL ceiling when `oauth.cimd.cacheMaxSeconds` is unset. */
const DEFAULT_CACHE_MAX_SECONDS = 86400;

/** Default fetch timeout when `oauth.cimd.fetchTimeoutMs` is unset. */
const DEFAULT_FETCH_TIMEOUT_MS = 5000;

/**
 * How long a document that can no longer be refreshed is still served.
 *
 * A hiccup at the client's host must not break a user who is mid-flow, and the
 * document is not a credential — the redirect URI and PKCE are what bind the
 * flow — so trading freshness for availability here is the safer side.
 */
const STALE_GRACE_MS = 24 * 60 * 60 * 1000;

const MAX_NAME_LENGTH = 100;
const CIMD_ALLOWED_GRANT_TYPES = Object.freeze(['authorization_code', 'refresh_token']);

/**
 * Per-worker document cache, keyed by the exact `client_id` URL.
 *
 * Per-worker is fine: the content is derived, every worker can fetch
 * independently, and the TTL floor bounds how often that happens.
 *
 * @type {Map<string, {doc: Object, expiresAt: number, fetchedAt: number}>}
 */
const cache = new Map();

/**
 * Is this `client_id` a CIMD identifier rather than a stored client ID?
 *
 * Deliberately strict, and checked before anything else: a stored client ID
 * must never be mistaken for a URL to fetch, and a URL that carries a fragment
 * or embedded credentials is not an identity we are willing to resolve.
 *
 * @param {*} clientId - Candidate client identifier
 * @returns {boolean} True when the value should be resolved as a CIMD URL
 */
export function isClientIdUrl(clientId) {
  if (typeof clientId !== 'string' || clientId.length === 0) return false;
  if (clientId.length > MAX_CLIENT_ID_LENGTH) return false;

  let url;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  // A bare origin is not a document.
  if (!url.pathname || url.pathname === '/') return false;
  if (url.hash) return false;
  if (url.username || url.password) return false;

  return true;
}

/**
 * Is the host of a `client_id` URL trusted to identify clients here?
 *
 * Uses the pattern semantics of `services/mcp/safeFetch.js`: exact hostname,
 * `*.example.com` or `.example.com` for subdomains only. `*` opens the server
 * to any HTTPS client (the MCP spec's "open server" posture — not recommended).
 * An empty list trusts nobody, which is a deliberate configuration, not a
 * mistake to paper over.
 *
 * @param {string} clientId - CIMD client identifier (an HTTPS URL)
 * @param {Array<string>} allowedHosts - `oauth.cimd.allowedClientHosts`
 * @returns {boolean} True when the host is trusted
 */
export function isHostAllowed(clientId, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return false;

  let hostname;
  try {
    hostname = new URL(clientId).hostname;
  } catch {
    return false;
  }

  return allowedHosts.some(
    pattern => pattern === '*' || hostMatchesPattern(hostname, String(pattern))
  );
}

/**
 * Is the host of a `client_id` URL explicitly blocked?
 *
 * Checked **before** the allowlist and before any network call, so a blocked
 * vendor is cut off without having to edit the allowlist you want to keep —
 * and without the server making a request on its behalf. Same pattern
 * semantics as {@link isHostAllowed}; an empty list blocks nobody, which is
 * the shipped default.
 *
 * @param {string} clientId - CIMD client identifier (an HTTPS URL)
 * @param {Array<string>} blockedHosts - `oauth.cimd.blockedClientHosts`
 * @returns {boolean} True when the host is blocked
 */
export function isHostBlocked(clientId, blockedHosts) {
  if (!Array.isArray(blockedHosts) || blockedHosts.length === 0) return false;

  let hostname;
  try {
    hostname = new URL(clientId).hostname;
  } catch {
    // A value that does not parse as a URL is not a CIMD client at all; the
    // resolver refuses it long before this point.
    return false;
  }

  return blockedHosts.some(
    pattern => pattern === '*' || hostMatchesPattern(hostname, String(pattern))
  );
}

/**
 * The hostname of a `client_id`, for display and logging.
 *
 * @param {string} clientId - CIMD client identifier
 * @returns {string} Hostname, or '' when the value does not parse
 */
export function clientIdHost(clientId) {
  try {
    return new URL(clientId).hostname;
  } catch {
    return '';
  }
}

/**
 * Strip control characters and clamp a display string taken from an untrusted
 * document.
 */
function sanitizeDisplayString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .substring(0, maxLength);
}

/**
 * Validate a fetched metadata document against the CIMD policy.
 *
 * Per draft-ietf-oauth-client-id-metadata-document-00 plus this repo's DCR
 * redirect-URI policy. `token_endpoint_auth_method` must be `none`: the draft
 * forbids shared-secret methods for CIMD clients, and `private_key_jwt`
 * (`jwks_uri`) is out of scope for this version.
 *
 * @param {*} doc - Parsed JSON document
 * @param {string} url - The `client_id` URL it was fetched from
 * @returns {{ ok: true, metadata: Object } | { ok: false, reason: string }}
 */
export function validateClientMetadata(doc, url) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'document is not a JSON object' };
  }

  // The document must claim the URL it was served from. Without this a host
  // could serve one document that impersonates a client identified elsewhere.
  if (doc.client_id !== url) {
    return { ok: false, reason: 'document client_id does not match the requested URL' };
  }

  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return { ok: false, reason: 'redirect_uris must be a non-empty array' };
  }
  for (const uri of redirectUris) {
    const result = validateRedirectUri(uri);
    if (!result.ok) {
      return { ok: false, reason: `invalid redirect URI: ${result.reason}` };
    }
  }

  let grantTypes = ['authorization_code'];
  if (doc.grant_types !== undefined) {
    if (!Array.isArray(doc.grant_types) || doc.grant_types.length === 0) {
      return { ok: false, reason: 'grant_types must be a non-empty array' };
    }
    const invalid = doc.grant_types.filter(g => !CIMD_ALLOWED_GRANT_TYPES.includes(g));
    if (invalid.length > 0) {
      return { ok: false, reason: `unsupported grant types: ${invalid.join(', ')}` };
    }
    if (!doc.grant_types.includes('authorization_code')) {
      return { ok: false, reason: 'the authorization_code grant is required' };
    }
    grantTypes = [...new Set(doc.grant_types)];
  }

  if (doc.response_types !== undefined) {
    if (
      !Array.isArray(doc.response_types) ||
      doc.response_types.length === 0 ||
      doc.response_types.some(r => r !== 'code')
    ) {
      return { ok: false, reason: 'only the "code" response type is supported' };
    }
  }

  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
    return {
      ok: false,
      reason: 'token_endpoint_auth_method must be "none" for client metadata documents'
    };
  }

  return {
    ok: true,
    metadata: {
      clientId: url,
      name: sanitizeDisplayString(doc.client_name, MAX_NAME_LENGTH) || clientIdHost(url),
      clientUri: sanitizeDisplayString(doc.client_uri, MAX_CLIENT_ID_LENGTH),
      redirectUris,
      grantTypes
    }
  };
}

/**
 * Derive the cache TTL for a response, clamped into `[300s, cacheMaxSeconds]`.
 */
function cacheTtlMs(response, cacheMaxSeconds) {
  const ceiling = Number.isFinite(cacheMaxSeconds) ? cacheMaxSeconds : DEFAULT_CACHE_MAX_SECONDS;
  const header = response?.headers?.get?.('cache-control') || '';
  const match = /max-age\s*=\s*(\d+)/i.exec(header);
  const requested = match ? Number(match[1]) : MIN_CACHE_SECONDS;
  const clamped = Math.min(
    Math.max(requested, MIN_CACHE_SECONDS),
    Math.max(ceiling, MIN_CACHE_SECONDS)
  );
  return clamped * 1000;
}

/**
 * Read at most `MAX_DOCUMENT_BYTES` from a response body.
 *
 * `Content-Length` is a claim, not a fact, so the text is length-checked after
 * reading too — but the header check short-circuits the obvious case.
 *
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string}>}
 */
async function readBoundedBody(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
    return { ok: false, reason: `document exceeds ${MAX_DOCUMENT_BYTES} bytes` };
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
    return { ok: false, reason: `document exceeds ${MAX_DOCUMENT_BYTES} bytes` };
  }
  return { ok: true, text };
}

/**
 * Fetch and validate a client metadata document, honouring the cache.
 *
 * The caller has already decided the host is allowed — this function performs
 * the network call, so calling it for an untrusted host is the one mistake it
 * cannot defend against.
 *
 * @param {string} url - The `client_id` URL
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] - Fetch timeout
 * @param {number} [options.cacheMaxSeconds] - TTL ceiling
 * @returns {Promise<{ok: true, metadata: Object, stale?: boolean} |
 *           {ok: false, reason: string}>}
 */
export async function fetchClientMetadata(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;
  const cacheMaxSeconds = options.cacheMaxSeconds;

  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, metadata: cached.doc };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, reason: 'client_id is not a valid URL' };
  }

  // Resolve and verify every address is public, then pin the connection to
  // exactly those addresses so the fetch cannot re-resolve to a private one.
  const ssrfCheck = await assertPublicTarget(parsedUrl);
  if (!ssrfCheck.ok) {
    return { ok: false, reason: `SSRF guard: ${ssrfCheck.reason}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await httpFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // A redirect would escape the host allowlist and the pinned lookup, so
      // the document must be served at the client_id URL itself.
      redirect: 'manual',
      signal: controller.signal,
      lookup: createPinnedLookup(ssrfCheck.addresses)
    });
  } catch (error) {
    return serveStale(url, cached, `fetch failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    return serveStale(url, cached, 'document must not redirect');
  }
  if (!response.ok) {
    return serveStale(url, cached, `document responded ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/(\w+\+)?json\b/i.test(contentType)) {
    // Bounded and stripped: this reason reaches a user-visible error page, and
    // the header is whatever the far end chose to send.
    const seen = sanitizeDisplayString(contentType, 60) || 'none';
    return serveStale(url, cached, `unexpected content type: ${seen}`);
  }

  const body = await readBoundedBody(response);
  if (!body.ok) {
    return serveStale(url, cached, body.reason);
  }

  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return serveStale(url, cached, 'document is not valid JSON');
  }

  const validation = validateClientMetadata(parsed, url);
  if (!validation.ok) {
    // A document that is served but invalid is a hard no, not a reason to fall
    // back on an older one: the client's own publisher changed it.
    cache.delete(url);
    return { ok: false, reason: validation.reason };
  }

  cache.set(url, {
    doc: validation.metadata,
    expiresAt: Date.now() + cacheTtlMs(response, cacheMaxSeconds),
    fetchedAt: Date.now()
  });

  return { ok: true, metadata: validation.metadata };
}

/**
 * Serve a cached document past its TTL when a refresh failed.
 *
 * Only transport-level and shape-level failures land here — an *invalid*
 * document is rejected outright by the caller.
 */
function serveStale(url, cached, reason) {
  if (cached && Date.now() - cached.fetchedAt < STALE_GRACE_MS) {
    logger.warn('[OAuth CIMD] Serving stale client metadata', {
      component: 'ClientIdMetadata',
      host: clientIdHost(url),
      reason
    });
    return { ok: true, metadata: cached.doc, stale: true };
  }
  return { ok: false, reason };
}

/**
 * Read a document from the cache without fetching.
 *
 * The token endpoint uses this: the authorization code (or refresh entry)
 * already binds `client_id`, `redirect_uri` and the PKCE verifier, so a token
 * exchange must not fail because the client's host is briefly unreachable.
 * The draft's "abort on fetch failure" rule applies to the *authorization*
 * request, where it is still enforced.
 *
 * @param {string} url - The `client_id` URL
 * @returns {Object|null} Cached metadata, or null
 */
export function getCachedClientMetadata(url) {
  const cached = cache.get(url);
  return cached ? cached.doc : null;
}

/**
 * Drop every cached document. Exported for tests.
 */
export function clearClientMetadataCache() {
  cache.clear();
}

export const CIMD_LIMITS = Object.freeze({
  MAX_CLIENT_ID_LENGTH,
  MAX_DOCUMENT_BYTES,
  MIN_CACHE_SECONDS,
  DEFAULT_CACHE_MAX_SECONDS,
  DEFAULT_FETCH_TIMEOUT_MS,
  STALE_GRACE_MS
});

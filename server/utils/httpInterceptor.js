/**
 * HTTP request/response interceptor — the low-level wire log.
 *
 * Some problems only show up in the raw traffic: a provider that rejects a
 * header we thought we were sending, a proxy that rewrites a path, an
 * integration that answers 200 with an error body. Neither the audit log
 * (mutating, authenticated requests only) nor OpenTelemetry (spans, not wire
 * data) shows that. This module does, for both directions:
 *
 *   inbound   every HTTP request Express serves (middleware/httpInterceptor.js)
 *   outbound  every request the server makes (utils/httpConfig.js httpFetch,
 *             services/mcp/safeFetch.js safeFetch)
 *
 * Records go to `logger.debug` under component `HttpInterceptor`, so they land
 * in whatever transports are already configured and can be filtered with the
 * existing tooling (`jq 'select(.component == "HttpInterceptor")'`). Note the
 * level: the platform log level has to be `debug` (or `silly`) for records to
 * be emitted at all — the admin UI warns when it is not.
 *
 * ## Correlation
 *
 * Every record carries the `requestId` from the per-request AsyncLocalStorage
 * context (utils/requestContext.js). An outbound LLM call therefore joins to
 * the inbound `/api/chat` request that caused it:
 *
 *   jq 'select(.component == "HttpInterceptor" and .requestId == "…")'
 *
 * Outbound calls made outside a request (startup model discovery, scheduled
 * jobs) simply have no `requestId`.
 *
 * ## What is deliberately not captured
 *
 * Streamed response bodies. `/api/chat`, `/api/inference`, agent and workflow
 * runs are all `text/event-stream` and run to megabytes; capturing them would
 * put a memory amplifier in the chat hot path. Status, headers and timing are
 * still recorded for those responses, with `responseBody: '[STREAM]'` marking
 * why the body itself is absent.
 *
 * ## Cost when disabled
 *
 * The normalised settings are memoised on the identity of the raw config
 * object (configCache hands back the same object until a reload), so the
 * disabled path is an identity check and a boolean read.
 */

import configCache from '../configCache.js';
import logger from './logger.js';
import { getContext } from './requestContext.js';

const REDACTED = '[REDACTED]';

/** Marker used in place of a body we refuse to buffer. */
export const STREAM_BODY_MARKER = '[STREAM]';

/**
 * Upper bound on the body size we are willing to redact structurally (parse
 * JSON, walk it, re-serialise). Above this a body is capped first and gets
 * pattern-based redaction instead — see redactBody().
 */
const STRUCTURED_REDACTION_LIMIT = 256 * 1024;

/** Response content types whose bodies are safe and useful to capture. */
const CAPTURABLE_BODY_TYPES =
  /^(?:application\/(?:json|[\w.+-]*\+json|xml|x-www-form-urlencoded|javascript)|text\/(?!event-stream)[\w.+-]+)/i;

/**
 * Header names whose values are credentials, matched case-insensitively.
 * Written as patterns rather than a vendor list so `anthropic-api-key`,
 * `x-goog-api-key` and `proxy-authorization` are all covered.
 *
 * `token` is deliberately not a bare substring match: providers send
 * `anthropic-ratelimit-tokens-remaining` and friends, and masking a rate-limit
 * counter helps nobody.
 */
const SENSITIVE_HEADER_RE = new RegExp(
  [
    '(?:^|[-_])(?:authorization|cookie)(?:$|[-_])',
    'secret',
    'password',
    'passwd',
    'credential',
    'api[-_]?key',
    '(?:^|[-_])(?:auth|access|refresh|id|session|csrf|xsrf|security|bearer)[-_]tokens?(?:$|[-_])',
    '(?:^|[-_])token$'
  ].join('|'),
  'i'
);

/** Object/JSON keys whose values are credentials (substring match). */
const SENSITIVE_KEY_RE =
  /secret|password|passwd|credential|api[-_]?key|private[-_]?key|authorization|cookie/i;

/**
 * Auth-token-shaped keys. Anchored so LLM bookkeeping — `maxTokens`,
 * `promptTokens`, `tokenCount`, `totalTokens` — survives untouched; masking
 * those would make the wire log useless for the thing it is most often used
 * for.
 */
const SENSITIVE_TOKEN_KEY_RE =
  /^(?:(?:access|refresh|id|bearer|auth|session|csrf|xsrf|client|api|jwt|sso|oauth|reset|invite|magic)[-_]?)?tokens?$|^jwt$|^session[-_]?id$/i;

/** Keys whose string values are URLs and should be redacted as such. */
const URL_KEY_RE = /^(?:url|uri|href|endpoint)$/i;

const DEFAULT_PATH_DENYLIST = ['/api/health'];
const DEFAULT_MAX_BODY_BYTES = 8192;
const DEFAULT_AUTO_DISABLE_MINUTES = 60;

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/** Memoised normalisation, keyed on the raw config object's identity. */
let cachedRaw;
let cachedSettings = null;

/**
 * When the interceptor became active on this worker. Anchors the
 * `autoDisableAfterMinutes` guard: an operator who flips capture on and walks
 * away gets it turned off again instead of filling a disk with prompt bodies.
 *
 * Worker-local by design. A config save reaches every worker within
 * milliseconds (configSync), so the windows stay aligned in practice, and a
 * restart re-arms the timer rather than silently extending it. Any change to
 * the `logging.http` block while capture is on also re-arms it, which is the
 * obvious reading of pressing Save again.
 */
let enabledSince = 0;
let expiryLogged = false;
let failureLogged = false;
/**
 * Serialisation of the settings last announced at info level. Deduplicating on
 * content rather than on the config object's identity keeps the announcement to
 * one line per real change: at boot the settings are applied once directly and
 * again by the first cluster-wide config announcement, and every unrelated
 * `platform.json` save reloads the object without changing this block.
 */
let announcedSignature = null;

function normalizeList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.map(entry => String(entry).trim()).filter(Boolean);
}

function normalizeDirection(raw, listDefaults) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = {
    enabled: source.enabled === true,
    includeHeaders: source.includeHeaders !== false,
    includeRequestBody: source.includeRequestBody === true,
    includeResponseBody: source.includeResponseBody === true
  };
  for (const [key, fallback] of Object.entries(listDefaults)) {
    result[key] = normalizeList(source[key], fallback);
  }
  // Compared upper-case so `["post"]` in the config still matches.
  if (result.methods) result.methods = result.methods.map(m => m.toUpperCase());
  return result;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

/**
 * Resolve `platform.logging.http` into its normalised form, re-using the
 * previous result while the underlying config object is unchanged.
 */
function resolveSettings() {
  let raw;
  try {
    raw = configCache.getPlatform()?.logging?.http;
  } catch {
    // configCache not hydrated yet (very early startup) — behave as disabled.
    raw = undefined;
  }

  if (raw === cachedRaw && cachedSettings !== null) return cachedSettings;

  cachedRaw = raw;
  const source = raw && typeof raw === 'object' ? raw : {};
  const settings = {
    inbound: normalizeDirection(source.inbound, {
      methods: [],
      pathAllowlist: [],
      pathDenylist: [...DEFAULT_PATH_DENYLIST]
    }),
    outbound: normalizeDirection(source.outbound, {
      hostAllowlist: [],
      hostDenylist: []
    }),
    maxBodyBytes: Math.floor(positiveNumber(source.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)),
    rawBodies: source.rawBodies === true,
    autoDisableAfterMinutes: positiveNumber(
      source.autoDisableAfterMinutes,
      DEFAULT_AUTO_DISABLE_MINUTES
    )
  };

  if (settings.inbound.enabled || settings.outbound.enabled) {
    enabledSince = Date.now();
  } else {
    enabledSince = 0;
  }
  expiryLogged = false;

  cachedSettings = settings;
  return settings;
}

function isExpired(settings) {
  const ttlMinutes = settings.autoDisableAfterMinutes;
  if (!ttlMinutes || !enabledSince) return false;
  if (Date.now() - enabledSince <= ttlMinutes * 60_000) return false;
  if (!expiryLogged) {
    expiryLogged = true;
    logger.info('HTTP interceptor auto-disabled after its configured window elapsed', {
      component: 'HttpInterceptor',
      autoDisableAfterMinutes: ttlMinutes,
      hint: 'Re-save the logging configuration to capture again'
    });
  }
  return true;
}

/**
 * The resolved `logging.http` settings plus whether the auto-disable window
 * has elapsed. Exposed for tests and diagnostics; the request path uses the
 * predicates below so the disabled case stays allocation-free.
 */
export function getHttpLoggingSettings() {
  const settings = resolveSettings();
  return { ...settings, expired: isExpired(settings) };
}

/**
 * Re-read the config and leave an info-level trace of the current capture
 * state.
 *
 * Called at startup and registered as a config-reload watcher (see
 * configReloadHooks.js) for two reasons. It anchors the auto-disable window the
 * moment the config lands on each worker rather than whenever the next request
 * happens to arrive; and turning wire capture on is a privacy-relevant act, so
 * it should be visible in the log at the default level — not only at `debug`,
 * where the records themselves live. That matters most for the case the admin UI
 * cannot warn about: capture enabled by hand-editing `platform.json`.
 *
 * Announcing is once per config state, so the startup call and a subsequent
 * admin save do not each add a line for the same settings.
 */
export function applyHttpInterceptorConfig() {
  const settings = resolveSettings();
  const signature = JSON.stringify(settings);
  if (signature === announcedSignature) return settings;
  announcedSignature = signature;

  if (!(settings.inbound.enabled || settings.outbound.enabled)) {
    // Nothing to say at the default level when capture is off; a line here on
    // every platform.json save would be pure noise.
    logger.debug('HTTP interceptor disabled', { component: 'HttpInterceptor' });
    return settings;
  }
  logger.info('HTTP interceptor enabled', {
    component: 'HttpInterceptor',
    inbound: settings.inbound.enabled,
    outbound: settings.outbound.enabled,
    bodies:
      settings.inbound.includeRequestBody ||
      settings.inbound.includeResponseBody ||
      settings.outbound.includeRequestBody ||
      settings.outbound.includeResponseBody,
    rawBodies: settings.rawBodies,
    maxBodyBytes: settings.maxBodyBytes,
    autoDisableAfterMinutes: settings.autoDisableAfterMinutes,
    note: 'Records are written at the debug level; set logging.level to debug to see them'
  });
  return settings;
}

/**
 * Match a path against a list of prefixes. `/api/health` matches
 * `/api/health` and `/api/health/live` but not `/api/healthcheck`.
 */
function pathMatches(path, patterns) {
  return patterns.some(pattern => {
    if (path === pattern) return true;
    const prefix = pattern.endsWith('/') ? pattern : `${pattern}/`;
    return path.startsWith(prefix);
  });
}

/**
 * Match a hostname against a list of patterns using the same semantics as
 * `ssl.domainWhitelist`: `*.example.com` and `.example.com` mean subdomains
 * only, anything else is an exact match.
 */
function hostMatches(hostname, patterns) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return patterns.some(pattern => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return Boolean(base) && host.endsWith(`.${base}`);
    }
    if (p.startsWith('.')) {
      const base = p.slice(1);
      return Boolean(base) && host.endsWith(p);
    }
    return host === p;
  });
}

/**
 * Should this inbound request be recorded?
 *
 * @param {{method?: string, path?: string, url?: string}} req - Express request.
 * @returns {object|null} The resolved settings when capture is on, else null.
 */
export function isInboundEnabled(req) {
  const settings = resolveSettings();
  if (!settings.inbound.enabled) return null;
  if (isExpired(settings)) return null;

  const { methods, pathAllowlist, pathDenylist } = settings.inbound;
  if (methods.length > 0 && !methods.includes(String(req?.method || '').toUpperCase())) return null;

  const path = req?.path || req?.url || '';
  if (pathDenylist.length > 0 && pathMatches(path, pathDenylist)) return null;
  if (pathAllowlist.length > 0 && !pathMatches(path, pathAllowlist)) return null;

  return settings;
}

/**
 * Should this outbound request be recorded?
 *
 * @param {string|URL} url - Target URL.
 * @returns {object|null} The resolved settings when capture is on, else null.
 */
export function isOutboundEnabled(url) {
  const settings = resolveSettings();
  if (!settings.outbound.enabled) return null;
  if (isExpired(settings)) return null;

  const { hostAllowlist, hostDenylist } = settings.outbound;
  if (hostAllowlist.length === 0 && hostDenylist.length === 0) return settings;

  let hostname = '';
  try {
    hostname = (typeof url === 'string' ? new URL(url) : url).hostname;
  } catch {
    // An unparseable URL can't be matched against either list. Record it —
    // a malformed outbound URL is exactly the kind of thing this is for.
    return settings;
  }

  if (hostDenylist.length > 0 && hostMatches(hostname, hostDenylist)) return null;
  if (hostAllowlist.length > 0 && !hostMatches(hostname, hostAllowlist)) return null;

  return settings;
}

// ---------------------------------------------------------------------------
// Redaction — implements the contract documented in logRedactor.README.md
// ---------------------------------------------------------------------------

function maskSecret(secret) {
  const value = String(secret);
  // Below ~8 characters a 4-character prefix gives away most of the value, so
  // mask those entirely; longer ones keep a prefix so two different keys stay
  // distinguishable in a log.
  if (value.length <= 8) return REDACTED;
  return `${value.slice(0, 4)}...${REDACTED}`;
}

/**
 * Redact secrets embedded in a URL: basic-auth userinfo and the query
 * parameters that carry credentials (Google's `?key=`, `access_token`, …).
 *
 * @param {string} url
 * @returns {string} URL with secrets masked; non-strings are returned as-is.
 */
export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  return url
    .replace(/(\/\/)[^/@\s]+@/, `$1${REDACTED}@`)
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|signature|key|token|password|secret|code)=)[^&#\s]*/gi,
      `$1${REDACTED}`
    );
}

/**
 * Mask cookie values while keeping the names — the names are the useful part.
 *
 * `Set-Cookie` is a different grammar from `Cookie`: only its first pair is a
 * cookie, everything after is attributes (`Path`, `SameSite`, `Max-Age`).
 * Those attributes are frequently the answer to "why isn't this cookie
 * sticking", so they are left intact.
 */
function redactCookieHeader(value, { setCookie = false } = {}) {
  return String(value)
    .split(/;\s*/)
    .map((pair, index) => {
      if (setCookie && index > 0) return pair;
      const eq = pair.indexOf('=');
      if (eq <= 0) return pair;
      return `${pair.slice(0, eq)}=${REDACTED}`;
    })
    .join('; ');
}

function maskHeaderValue(name, value) {
  if (Array.isArray(value)) return value.map(entry => maskHeaderValue(name, entry));
  if (value === undefined || value === null) return value;
  const lower = name.toLowerCase();
  if (lower === 'cookie') return redactCookieHeader(value);
  if (lower === 'set-cookie') return redactCookieHeader(value, { setCookie: true });
  const text = String(value);
  // "Bearer <token>" / "Basic <blob>" — keep the scheme, mask the credential.
  const scheme = /^(\S+)\s+(\S.*)$/.exec(text);
  if (scheme) return `${scheme[1]} ${maskSecret(scheme[2])}`;
  return maskSecret(text);
}

/**
 * Normalise anything header-shaped (plain object, `Headers`, `Map`, array of
 * pairs) into a plain object.
 */
export function toHeaderObject(headers) {
  if (!headers) return undefined;
  try {
    // Arrays before the entries() branch: Array.prototype.entries() yields
    // [index, value] pairs, which would key the result by 0, 1, 2…
    if (Array.isArray(headers)) {
      const out = {};
      for (const entry of headers) {
        if (Array.isArray(entry) && entry.length >= 2) out[entry[0]] = entry[1];
      }
      return out;
    }
    if (typeof headers.entries === 'function') {
      const out = {};
      for (const [key, value] of headers.entries()) out[key] = value;
      return out;
    }
    if (typeof headers === 'object') return { ...headers };
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Mask credential-carrying header values. Header *names* are always kept — a
 * missing or misspelled header is half the reason to look at a wire log.
 *
 * @param {object|Headers|Array} headers
 * @param {{raw?: boolean}} [options] - `raw: true` returns values unmasked.
 * @returns {object|undefined}
 */
export function redactHeaders(headers, options = {}) {
  const normalized = toHeaderObject(headers);
  if (!normalized) return undefined;
  if (options.raw) return normalized;

  const out = {};
  for (const [name, value] of Object.entries(normalized)) {
    out[name] = SENSITIVE_HEADER_RE.test(name) ? maskHeaderValue(name, value) : value;
  }
  return out;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(key) || SENSITIVE_TOKEN_KEY_RE.test(key);
}

/**
 * Recursively mask values whose key names look like credentials. Returns a new
 * structure; the input is never mutated.
 */
function redactObject(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(entry => redactObject(entry, depth + 1));

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = entry === null || typeof entry === 'object' ? REDACTED : maskSecret(entry);
    } else if (typeof entry === 'string' && URL_KEY_RE.test(key)) {
      out[key] = redactUrl(entry);
    } else if (entry && typeof entry === 'object') {
      out[key] = redactObject(entry, depth + 1);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

/** Key-name fragments that mark a value as a credential in free text. */
const SECRET_NAME_FRAGMENT = 'secret|token|password|passwd|credential|api[-_]?key|apikey';

/**
 * Pattern-based fallback for text we could not parse structurally (a capped
 * JSON body, form-encoded data, an XML or SOAP payload).
 */
function redactBodyText(text) {
  return text
    .replace(
      new RegExp(
        `("[\\w-]*(?:${SECRET_NAME_FRAGMENT})[\\w-]*"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`,
        'gi'
      ),
      `$1${REDACTED}$2`
    )
    .replace(
      // <token>…</token>, <ns:clientSecret>…</ns:clientSecret>
      new RegExp(
        `(<\\s*([\\w:.-]*(?:${SECRET_NAME_FRAGMENT})[\\w:.-]*)\\s*>)[^<]*(<\\s*/\\s*\\2\\s*>)`,
        'gi'
      ),
      `$1${REDACTED}$3`
    )
    .replace(
      /\b([\w-]*(?:secret|token|password|passwd|credential|api[-_]?key|apikey)[\w-]*=)[^&\s;]*/gi,
      `$1${REDACTED}`
    )
    .replace(/\b(Bearer|Basic)\s+[\w\-._~+/=]{8,}/gi, `$1 ${REDACTED}`);
}

/**
 * Describe a body we will not try to serialise. Request bodies are not always
 * text: file uploads arrive as multipart streams, and some callers pass typed
 * arrays. Stringifying those yields `[object Object]` or a megabyte of base64,
 * so name the shape instead.
 */
function describeOpaqueBody(body) {
  if (!body || typeof body !== 'object') return undefined;
  if (Buffer.isBuffer(body)) return undefined;
  if (typeof body.pipe === 'function' || typeof body.getReader === 'function') return '[STREAM]';
  if (typeof body.getBoundary === 'function' || body.constructor?.name === 'FormData') {
    return '[FORM-DATA]';
  }
  if (body instanceof ArrayBuffer) return `[BINARY ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[BINARY ${body.byteLength} bytes]`;
  return undefined;
}

function isPlainBodyObject(body) {
  return (
    body !== null &&
    typeof body === 'object' &&
    !Buffer.isBuffer(body) &&
    !(body instanceof URLSearchParams)
  );
}

function stringifyBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === 'object') {
    try {
      return JSON.stringify(body) ?? '';
    } catch {
      return '[UNSERIALIZABLE]';
    }
  }
  return String(body);
}

/** Cap `text` at `maxBytes` (0 = uncapped), noting what was dropped. */
function truncate(text, maxBytes) {
  if (!maxBytes || maxBytes <= 0) return text;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  const clipped = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${clipped}...[TRUNCATED ${maxBytes} of ${bytes} bytes]`;
}

/**
 * Prepare a body for logging: mask credentials, then cap the size.
 *
 * Redaction quality depends on size. Up to STRUCTURED_REDACTION_LIMIT the body
 * is redacted structurally (keys matched, values masked), which is precise.
 * Above that it is capped first and the remainder gets pattern-based redaction
 * — a deliberate trade so a 50 MB upload is not parsed and re-serialised
 * inside the request path.
 *
 * @param {*} body - String, Buffer, URLSearchParams or parsed object.
 * @param {{raw?: boolean, maxBytes?: number}} [options] - `raw` skips masking
 *   and capping entirely; `maxBytes: 0` means uncapped.
 * @returns {string|undefined} The loggable body, or undefined when empty.
 */
export function redactBody(body, options = {}) {
  const { raw = false, maxBytes = DEFAULT_MAX_BODY_BYTES } = options;

  if (body === undefined || body === null) return undefined;
  const opaque = describeOpaqueBody(body);
  if (opaque) return opaque;
  // express.json() leaves `{}` on every request without a JSON body.
  if (isPlainBodyObject(body) && Object.keys(body).length === 0) return undefined;

  if (raw) {
    const text = stringifyBody(body);
    return text === '' ? undefined : text;
  }

  let text;
  if (isPlainBodyObject(body)) {
    text = stringifyBody(redactObject(body));
  } else {
    text = stringifyBody(body);
    if (text === '') return undefined;
    if (Buffer.byteLength(text, 'utf8') <= STRUCTURED_REDACTION_LIMIT) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      text =
        parsed !== null && typeof parsed === 'object'
          ? stringifyBody(redactObject(parsed))
          : redactBodyText(text);
    } else {
      // Too large to reparse: cap what we will actually emit, then pattern-match.
      return redactBodyText(truncate(text, maxBytes)) || undefined;
    }
  }

  if (text === '') return undefined;
  return truncate(text, maxBytes);
}

// ---------------------------------------------------------------------------
// Body capture helpers
// ---------------------------------------------------------------------------

/**
 * Is this response body worth (and safe) to capture?
 *
 * Streams are refused outright: SSE bodies run to megabytes and buffering them
 * would put a memory amplifier in the chat hot path. Binary payloads are
 * refused because a base64 blob in a log helps nobody.
 *
 * @param {string} contentType - Raw `Content-Type` header value.
 * @returns {boolean}
 */
export function isCapturableContentType(contentType) {
  if (!contentType) return false;
  return CAPTURABLE_BODY_TYPES.test(String(contentType).trim());
}

/** True when the content type marks a streamed (server-sent events) response. */
export function isStreamContentType(contentType) {
  return /text\/event-stream/i.test(String(contentType || ''));
}

/** How long to wait for a peeked response body before giving up on it. */
const PEEK_TIMEOUT_MS = 5000;

/**
 * Read at most `maxBytes` from a response body without disturbing the original
 * response. Used for outbound responses, whose body the caller still needs.
 *
 * Only ever call this for non-stream content types, and never `await` it before
 * handing the response back to the caller. `clone()` tees the body by piping it
 * into two PassThroughs, and `pipe` stalls the source as soon as *either* side
 * fills its buffer — so a peek that blocks the caller from reading its own
 * branch deadlocks both. Kick it off, return the response, let the caller drain
 * its branch, and log when the peek resolves.
 *
 * The timeout covers the other half of the same problem: a caller that never
 * reads the body at all (checks `response.ok` and moves on) would otherwise
 * stall the source forever and the record would never be written.
 *
 * @param {Response} response - node-fetch/undici response, body untouched.
 * @param {number} maxBytes - 0 for unlimited.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<string|undefined>}
 */
export async function peekResponseBody(response, maxBytes, options = {}) {
  if (typeof response?.clone !== 'function') return undefined;
  let clone;
  try {
    clone = response.clone();
  } catch {
    return undefined; // body already consumed — nothing safe to read
  }

  const limit = maxBytes && maxBytes > 0 ? maxBytes : Infinity;
  const chunks = [];
  let received = 0;
  let reader;
  let timedOut = false;

  const release = () => {
    try {
      if (reader) reader.cancel().catch(() => {});
      else clone.body?.destroy?.();
    } catch {
      /* already closed */
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    release();
  }, options.timeoutMs ?? PEEK_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const body = clone.body;
    if (!body) return undefined;
    if (typeof body.getReader === 'function') {
      reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        received += buf.length;
        if (received >= limit) break;
      }
    } else if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buf);
        received += buf.length;
        if (received >= limit) break;
      }
    } else {
      return undefined;
    }
  } catch {
    // A partial read is still worth logging.
  } finally {
    clearTimeout(timer);
    release();
  }

  if (chunks.length === 0) return timedOut ? '[UNREAD]' : undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  return timedOut ? `${text}...[UNREAD]` : text;
}

/**
 * Wrap one outbound fetch call so it lands in the wire log.
 *
 * Takes the fetch implementation as an argument so both transports can share
 * this: `httpFetch` uses node-fetch with proxy/SSL agents, `safeFetch` uses
 * `globalThis.fetch` with an SSRF-pinned dispatcher.
 *
 * The record is emitted after the call resolves. When response-body capture is
 * on for a capturable content type, the record is emitted once the peek
 * finishes — the response itself is returned to the caller straight away, so
 * that log line simply arrives a little later than its neighbours.
 *
 * @param {Function} fetchFn - `(url, options) => Promise<Response>`.
 * @param {string|URL} url
 * @param {object} options - Fetch options, already transport-prepared.
 * @param {object} settings - Resolved settings from isOutboundEnabled().
 * @param {string} transport - `httpFetch` or `safeFetch`.
 * @returns {Promise<Response>}
 */
export async function interceptedFetch(fetchFn, url, options, settings, transport) {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
  const base = {
    settings,
    transport,
    method: String(options?.method || 'GET').toUpperCase(),
    url: typeof url === 'string' ? url : String(url),
    headers: options?.headers,
    body: options?.body
  };

  let response;
  try {
    response = await fetchFn(url, options);
  } catch (error) {
    recordOutbound({
      ...base,
      error: error?.message || String(error),
      durationMs: elapsedMs()
    });
    throw error;
  }

  const finish = responseBody =>
    recordOutbound({
      ...base,
      status: response?.status,
      responseHeaders: response?.headers,
      responseBody,
      durationMs: elapsedMs()
    });

  if (!settings.outbound.includeResponseBody) {
    finish(undefined);
    return response;
  }

  let contentType;
  try {
    contentType = response?.headers?.get?.('content-type');
  } catch {
    contentType = undefined;
  }

  if (isStreamContentType(contentType)) {
    finish(STREAM_BODY_MARKER);
    return response;
  }
  if (!isCapturableContentType(contentType)) {
    finish(undefined);
    return response;
  }

  // Detached on purpose — see peekResponseBody().
  peekResponseBody(response, settings.rawBodies ? 0 : settings.maxBodyBytes)
    .then(finish)
    .catch(() => finish(undefined));
  return response;
}

// ---------------------------------------------------------------------------
// Recorders
// ---------------------------------------------------------------------------

function currentRequestId() {
  try {
    return getContext()?.requestId;
  } catch {
    return undefined;
  }
}

function prepareBody(value, settings) {
  if (value === STREAM_BODY_MARKER) return STREAM_BODY_MARKER;
  return redactBody(value, {
    raw: settings.rawBodies,
    maxBytes: settings.rawBodies ? 0 : settings.maxBodyBytes
  });
}

/**
 * Emit one inbound request/response record.
 *
 * Never throws: a logging failure must not fail the request it describes.
 *
 * @param {object} record
 * @param {object} record.settings - Resolved settings from isInboundEnabled().
 * @param {string} record.method
 * @param {string} record.url - Original request URL (redacted before logging).
 * @param {object} [record.headers] - Request headers.
 * @param {*} [record.body] - Parsed or raw request body.
 * @param {number} [record.status]
 * @param {object} [record.responseHeaders]
 * @param {*} [record.responseBody] - Captured text, or STREAM_BODY_MARKER.
 * @param {number} [record.durationMs]
 * @param {boolean} [record.aborted] - Client disconnected before the response
 *   finished (an abandoned SSE stream, a cancelled upload).
 */
export function recordInbound(record) {
  try {
    const settings = record?.settings;
    if (!settings) return;
    const raw = settings.rawBodies;

    const entry = {
      component: 'HttpInterceptor',
      direction: 'inbound',
      requestId: currentRequestId(),
      method: record.method,
      url: raw ? record.url : redactUrl(record.url),
      status: record.status,
      durationMs: record.durationMs
    };
    if (record.aborted) entry.aborted = true;

    if (settings.inbound.includeHeaders) {
      entry.requestHeaders = redactHeaders(record.headers, { raw });
      entry.responseHeaders = redactHeaders(record.responseHeaders, { raw });
    }
    if (settings.inbound.includeRequestBody) {
      entry.requestBody = prepareBody(record.body, settings);
    }
    if (settings.inbound.includeResponseBody) {
      entry.responseBody = prepareBody(record.responseBody, settings);
    }

    logger.debug('HTTP inbound', entry);
  } catch (error) {
    logFailure(error);
  }
}

/**
 * Emit one outbound request/response record.
 *
 * Never throws: a logging failure must not fail the call it describes.
 *
 * @param {object} record
 * @param {object} record.settings - Resolved settings from isOutboundEnabled().
 * @param {string} record.transport - `httpFetch` or `safeFetch`.
 * @param {string} [record.method]
 * @param {string} record.url
 * @param {object} [record.headers]
 * @param {*} [record.body]
 * @param {number} [record.status]
 * @param {object} [record.responseHeaders]
 * @param {*} [record.responseBody] - Captured text, or STREAM_BODY_MARKER.
 * @param {number} [record.durationMs]
 * @param {string} [record.error] - Message when the call threw.
 */
export function recordOutbound(record) {
  try {
    const settings = record?.settings;
    if (!settings) return;
    const raw = settings.rawBodies;

    const entry = {
      component: 'HttpInterceptor',
      direction: 'outbound',
      requestId: currentRequestId(),
      transport: record.transport,
      method: record.method || 'GET',
      url: raw ? record.url : redactUrl(record.url),
      status: record.status,
      durationMs: record.durationMs
    };
    if (record.error) entry.error = record.error;

    if (settings.outbound.includeHeaders) {
      entry.requestHeaders = redactHeaders(record.headers, { raw });
      entry.responseHeaders = redactHeaders(record.responseHeaders, { raw });
    }
    if (settings.outbound.includeRequestBody) {
      entry.requestBody = prepareBody(record.body, settings);
    }
    if (settings.outbound.includeResponseBody) {
      entry.responseBody = prepareBody(record.responseBody, settings);
    }

    logger.debug('HTTP outbound', entry);
  } catch (error) {
    logFailure(error);
  }
}

function logFailure(error) {
  if (failureLogged) return;
  failureLogged = true;
  try {
    logger.warn('HTTP interceptor failed to record a request; capture continues', {
      component: 'HttpInterceptor',
      error: error?.message || String(error)
    });
  } catch {
    /* logging is what failed — give up quietly */
  }
}

/** Test seam: drop the memoised config and the auto-disable anchor. */
export function resetHttpInterceptorForTests() {
  cachedRaw = undefined;
  cachedSettings = null;
  enabledSince = 0;
  expiryLogged = false;
  failureLogged = false;
  announcedSignature = null;
}

/** Test seam: move the auto-disable anchor to an arbitrary point in time. */
export function setEnabledSinceForTests(timestamp) {
  enabledSince = timestamp;
  expiryLogged = false;
}

export default {
  getHttpLoggingSettings,
  isInboundEnabled,
  isOutboundEnabled,
  recordInbound,
  recordOutbound,
  redactUrl,
  redactHeaders,
  redactBody,
  isCapturableContentType,
  isStreamContentType,
  peekResponseBody,
  interceptedFetch,
  STREAM_BODY_MARKER
};

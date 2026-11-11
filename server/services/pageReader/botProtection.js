// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Telling a bot-protection block from a real "log in first".
 *
 * A site behind a WAF / bot manager (Akamai, Cloudflare, Imperva, DataDome,
 * PerimeterX, Sucuri) answers an automated page read with a 403 (or a
 * challenge page), which looks exactly like "authentication required" to a
 * status-only check. Nothing the reader does can fix it, and retrying — or
 * trying other URLs on the same host — only wastes tool calls, so the reader
 * reports it as its own, non-retryable error and the model is told to stop and
 * say so (see {@link botProtectionToolResult}).
 *
 * Detection only: this never tries to get past the protection.
 *
 * @module services/pageReader/botProtection
 */

export const BOT_PROTECTION_CODE = 'BOT_PROTECTION';
export const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';
export const ACCESS_DENIED_CODE = 'ACCESS_DENIED';

/** How much of an error page is read to look for a vendor's block page. */
export const BODY_PREFIX_CHARS = 4096;

/** Statuses a block or challenge page comes with. */
const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

/** Block pages carry a reference id the site's owner can look the request up by. */
const REFERENCE_PATTERNS = [
  /Reference\s+(?:Error:\s*|#\s*)(\d+\.[0-9a-f.]+)/i, // Akamai
  /Incapsula incident ID:\s*([\w-]+)/i, // Imperva
  /Ray ID:\s*(?:<[^>]*>)?\s*([0-9a-f]{8,})/i // Cloudflare
];

/**
 * Vendor signatures. `headers` match response headers (name → optional value
 * pattern); `body` matches the first characters of the page. A vendor counts
 * as detected when `strong` matches, or when `weak` matches together with a
 * `bodyHint`/`headerHint` — a CDN's own `server` header alone does not prove
 * that the 403 came from its bot manager rather than from the site behind it.
 */
const VENDORS = [
  {
    vendor: 'Akamai',
    // AkamaiGHost / AkamaiNetStorage: the server header of Akamai's own edge errors.
    strong: ({ header, body }) =>
      /^akamai/i.test(header('server')) ||
      /WAFfailoverassets|errors\.edgesuite\.net|Reference\s+(?:Error:\s*|#\s*)\d+\.[0-9a-f.]+/i.test(
        body
      )
  },
  {
    vendor: 'Cloudflare',
    strong: ({ header, body }) =>
      header('cf-mitigated') !== '' ||
      ((header('cf-ray') !== '' || /^cloudflare/i.test(header('server'))) &&
        /Just a moment|challenge-platform|cf-chl-|Attention Required!|Sorry, you have been blocked|cf-error-details|Enable JavaScript and cookies to continue/i.test(
          body
        ))
  },
  {
    vendor: 'Imperva',
    strong: ({ header, body }) =>
      header('x-iinfo') !== '' ||
      /^(incapsula|imperva)/i.test(header('x-cdn')) ||
      /visid_incap_|incap_ses_/i.test(header('set-cookie')) ||
      /_Incapsula_Resource|Incapsula incident ID|Request unsuccessful\. Incapsula/i.test(body)
  },
  {
    vendor: 'DataDome',
    strong: ({ header, body }) =>
      header('x-datadome') !== '' ||
      header('x-datadome-response') !== '' ||
      /^datadome/i.test(header('server')) ||
      /datadome=/i.test(header('set-cookie')) ||
      /captcha-delivery\.com|geo\.captcha-delivery/i.test(body)
  },
  {
    vendor: 'PerimeterX',
    strong: ({ header, body }) =>
      /(^|[\s;,])_px[a-z0-9]*=/i.test(header('set-cookie')) ||
      /px-captcha|_pxAppId|perimeterx|Press\s*(?:&amp;|&)\s*Hold/i.test(body)
  },
  {
    vendor: 'Sucuri',
    strong: ({ header, body }) =>
      header('x-sucuri-id') !== '' ||
      /^sucuri/i.test(header('server')) ||
      /Sucuri WebSite Firewall/i.test(body)
  }
];

/**
 * @param {{get?: (name: string) => string|null}|undefined} headers
 * @returns {(name: string) => string} header lookup that answers '' when absent
 */
function headerReader(headers) {
  return name => {
    try {
      const value = headers?.get?.(name);
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  };
}

/**
 * Which bot-protection vendor (if any) produced a response.
 *
 * @param {Object} response
 * @param {number} response.status
 * @param {Object} [response.headers] - Headers-like object with `get(name)`
 * @param {string} [response.body] - The first characters of the body
 * @returns {{vendor: string, reference: string|null}|null} null when the
 *   response is not a bot-protection block (or status is not a block status)
 */
export function detectBotProtection({ status, headers, body = '' } = {}) {
  if (!BLOCK_STATUSES.has(Number(status))) return null;
  const header = headerReader(headers);
  const text = String(body).slice(0, BODY_PREFIX_CHARS);
  const match = VENDORS.find(entry => entry.strong({ header, body: text }));
  if (!match) return null;
  let reference = null;
  for (const pattern of REFERENCE_PATTERNS) {
    const found = pattern.exec(text);
    if (found) {
      reference = found[1];
      break;
    }
  }
  return { vendor: match.vendor, reference };
}

/** Longest an error body may take to arrive before the classification goes on without it. */
export const BODY_READ_TIMEOUT_MS = 3000;

/** Stop reading a body: Node streams are destroyed, web streams cancelled. */
function releaseBody(body) {
  try {
    if (typeof body?.destroy === 'function') body.destroy();
    else if (typeof body?.cancel === 'function') void body.cancel().catch(() => {});
  } catch {
    // Already closed.
  }
}

/**
 * The first {@link BODY_PREFIX_CHARS} characters of a response body, without
 * downloading the rest of a large one or waiting on a slow one. Reads a web
 * stream (`getReader`) or a Node stream (what node-fetch, the page reader's
 * HTTP client, returns) and falls back to `text()` for a body that is neither.
 * Never throws: an unreadable body is whatever arrived, or ''.
 *
 * @param {Object} response - A fetch response
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] - Give up waiting after this long
 * @returns {Promise<string>}
 */
export async function readBodyPrefix(response, { timeoutMs = BODY_READ_TIMEOUT_MS } = {}) {
  const body = response?.body;
  const decoder = new TextDecoder('utf-8');
  let text = '';
  /** @returns {boolean} true once enough has been read */
  const append = chunk => {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    return text.length >= BODY_PREFIX_CHARS;
  };
  const read = async () => {
    if (typeof body?.getReader === 'function') {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || append(value)) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) {
        if (append(chunk)) break;
      }
    } else if (typeof response?.text === 'function') {
      append(String(await response.text()));
    }
  };
  let timer;
  try {
    await Promise.race([
      read(),
      new Promise(resolve => {
        timer = setTimeout(resolve, timeoutMs);
      })
    ]);
  } catch {
    // An unreadable error body only means no vendor can be named.
  } finally {
    clearTimeout(timer);
    // Stops a read that is still waiting (timeout) or has the rest to send.
    releaseBody(body);
  }
  return text.slice(0, BODY_PREFIX_CHARS);
}

/**
 * What a failed page response means, for 401/403 and the challenge statuses
 * 429/503.
 *
 * - `BOT_PROTECTION`: a known WAF / bot manager answered. Not retryable.
 * - `AUTH_REQUIRED`: a real login is asked for: a 401, or a 403 that carries
 *   `WWW-Authenticate`.
 * - `ACCESS_DENIED`: any other 403 — the site refuses, for a reason we cannot
 *   name.
 * - `null`: nothing to say beyond the status (e.g. a plain 429/503); the
 *   caller keeps its generic error.
 *
 * A `WWW-Authenticate` header wins over vendor detection: a real login
 * challenge is not a bot block, even behind a CDN.
 *
 * @param {Object} response - A fetch response (its body is read, bounded)
 * @param {string} [url] - The requested URL, for the host
 * @returns {Promise<{code: string, status: number, host: string, vendor?: string, reference?: string|null, message: string}|null>}
 */
export async function classifyBlockedResponse(response, url = '') {
  const status = Number(response?.status);
  if (!BLOCK_STATUSES.has(status)) return null;
  const header = headerReader(response.headers);
  const host = hostOf(url);

  if ((status === 401 || status === 403) && header('www-authenticate')) {
    return {
      code: AUTH_REQUIRED_CODE,
      status,
      host,
      message: `Authentication required to access this page (HTTP ${status})`
    };
  }

  const body = await readBodyPrefix(response);
  const detected = detectBotProtection({ status, headers: response.headers, body });
  if (detected) {
    return {
      code: BOT_PROTECTION_CODE,
      status,
      host,
      vendor: detected.vendor,
      reference: detected.reference,
      message: `Blocked by bot protection (${detected.vendor}) – the site does not allow automated access (HTTP ${status})`
    };
  }

  if (status === 401) {
    return {
      code: AUTH_REQUIRED_CODE,
      status,
      host,
      message: `Authentication required to access this page (HTTP ${status})`
    };
  }
  if (status === 403) {
    return {
      code: ACCESS_DENIED_CODE,
      status,
      host,
      message: `Access to this page was denied by the site (HTTP ${status})`
    };
  }
  return null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * An Error for a blocked response, carrying what {@link classifyBlockedResponse}
 * found (`code`, `status`, `host`, `vendor`, `reference`).
 *
 * @param {NonNullable<Awaited<ReturnType<typeof classifyBlockedResponse>>>} blocked
 * @returns {Error}
 */
export function blockedResponseError(blocked) {
  const err = new Error(blocked.message);
  err.code = blocked.code;
  err.status = blocked.status;
  err.host = blocked.host;
  if (blocked.vendor) err.vendor = blocked.vendor;
  if (blocked.reference) err.reference = blocked.reference;
  return err;
}

/** What the model is told to do about a bot-protection block. */
export function botProtectionGuidance(host) {
  const where = host ? ` (${host})` : '';
  return (
    `This site${where} blocks automated access. Do not retry or try other URLs on this host. ` +
    'Tell the user the page could not be read and suggest they upload it (PDF or text) or ' +
    'that you use the search snippets instead.'
  );
}

/**
 * The tool result the model gets for a bot-protection block: an unambiguous,
 * non-retryable signal, not only an error string.
 *
 * `message` is a top-level copy of `error.message` because the run loop reads
 * the failure text from there (`services/loop/toolClassify.js`).
 *
 * @param {Error & {vendor?: string, host?: string, status?: number, reference?: string}} error
 * @param {string} url - The URL the model asked for
 * @returns {Object}
 */
export function botProtectionToolResult(error, url) {
  return {
    url,
    error: {
      code: BOT_PROTECTION_CODE,
      message: error.message,
      retryable: false,
      ...(error.vendor ? { vendor: error.vendor } : {}),
      host: error.host || hostOf(url),
      ...(error.status ? { status: error.status } : {})
    },
    message: error.message,
    instruction: botProtectionGuidance(error.host || hostOf(url))
  };
}

/** Whether an error is a bot-protection block raised by the reader. */
export function isBotProtectionError(error) {
  return error?.code === BOT_PROTECTION_CODE;
}

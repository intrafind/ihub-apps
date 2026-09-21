/**
 * Office.js source resolution.
 *
 * Office.js is a bootstrapper, not the library itself. At runtime it locates
 * its own `<script>` element (`document.currentScript`, falling back to a scan
 * of every `<script>` tag), derives a base path from that element's `src`, and
 * loads everything else relative to it — the mapping table, MicrosoftAjax, the
 * host payload (e.g. `outlook-win32-16.01.js`) and the locale strings under
 * `<locale>/outlook_strings.js`. The host payload does the same for its own
 * dependencies, so the entire chain follows whichever origin served office.js.
 *
 * No Microsoft hostname is baked into any file in that chain. The library can
 * therefore be served from this server, from a customer's own CDN, or from an
 * artifact proxy — with one constraint: the URL must still end in `/office.js`
 * (or `/office.debug.js`), optionally followed by a query string, because that
 * suffix is how the bootstrapper recognises its own `<script>` tag. If it does
 * not match, the derived base path is the empty string and every subsequent
 * load resolves against the page root instead, which 404s.
 *
 * See `concepts/2026-09-21 Office.js Base Path and Proxy Modes.md`.
 */

import logger from './logger.js';

/**
 * How the add-in obtains Office.js.
 *
 * - `cdn`      load directly from Microsoft's CDN (default)
 * - `proxy`    this server pulls from the CDN and caches; clients never
 *              contact Microsoft, only the server needs egress
 * - `bundled`  serve the `@microsoft/office-js` npm snapshot shipped in the build
 * - `custom`   an absolute URL the admin supplies (own CDN, artifact proxy, …)
 */
export const OFFICE_JS_MODES = ['cdn', 'proxy', 'bundled', 'custom'];

export const DEFAULT_OFFICE_JS_MODE = 'cdn';

/**
 * Microsoft's current documented CDN URL. The `appsforoffice.microsoft.com`
 * host is the older one and still works; this domain is what Microsoft Learn
 * documents today and — being under `*.static.microsoft` rather than
 * `microsoft.com` — it is not caught by a suffix block on `microsoft.com`.
 * Both are `required: true` endpoints in the Microsoft 365 endpoint list.
 */
export const DEFAULT_OFFICE_JS_CDN_URL =
  'https://officeapis.public.onecdn.static.microsoft/1/office.js';

/** The pre-unified-domain CDN URL, still served and still valid. */
export const LEGACY_OFFICE_JS_CDN_URL =
  'https://appsforoffice.microsoft.com/lib/1/hosted/office.js';

/**
 * The Office.js CDN URLs Microsoft documents, offered in the admin UI so an
 * operator picks one rather than transcribing it.
 *
 * Which of these a network allows varies: a block written as a `microsoft.com`
 * suffix rule catches `appsforoffice.microsoft.com` but not
 * `*.static.microsoft`, so the legacy host and the current one can have
 * different reachability on the same network. That is what the reachability
 * probe is for.
 *
 * Labels live in the client i18n bundle; only the ids and URLs belong here.
 */
export const OFFICE_JS_CDN_PRESETS = [
  { id: 'worldwide', url: DEFAULT_OFFICE_JS_CDN_URL },
  { id: 'worldwideLegacy', url: LEGACY_OFFICE_JS_CDN_URL },
  {
    // 21Vianet operates Office 365 in China; tenants there must use this CDN.
    id: 'china',
    url: 'https://appsforoffice.cdn.partner.office365.cn/appsforoffice/lib/1/hosted/office.js'
  },
  {
    // Preview APIs. Microsoft states these are not for production use.
    id: 'preview',
    url: 'https://officeapis.public.onecdn.static.microsoft/beta/office.js'
  }
];

/**
 * Relative URL used for `proxy` and `bundled` modes. Relative (not
 * `/office/office-js/office.js`) so that subpath deployments keep working —
 * the add-in pages are served from `/office/`, so this resolves to
 * `<base>/office/office-js/office.js` wherever the app is mounted.
 */
export const OFFICE_JS_LOCAL_URL = './office-js/office.js';

/** Filenames the Office.js bootstrapper will recognise as itself. */
const OFFICE_JS_FILENAMES = ['office.js', 'office.debug.js'];

const MAX_URL_LENGTH = 2048;

/**
 * Validate a URL that will be used as the `src` of the Office.js script tag.
 *
 * Enforces the bootstrapper's own constraint (path ends in `/office.js` or
 * `/office.debug.js`) so a misconfiguration is rejected at save time rather
 * than surfacing as a cascade of 404s inside the task pane.
 *
 * @param {string} rawUrl
 * @returns {{ value: string } | { error: string }}
 */
export function validateOfficeJsUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return { error: 'Office.js URL must be a string' };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { error: 'Office.js URL must not be empty' };
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { error: `Office.js URL must not exceed ${MAX_URL_LENGTH} characters` };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'Office.js URL must be an absolute URL' };
  }

  // Office refuses to load add-in scripts over plain HTTP. Localhost is the
  // one exception, because that is how the add-in is developed.
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    return { error: 'Office.js URL must use https (http is allowed only for localhost)' };
  }

  // A fragment breaks the bootstrapper's suffix match just as surely as a
  // wrong filename does, and it is never meaningful on a script URL.
  if (parsed.hash) {
    return { error: 'Office.js URL must not contain a fragment' };
  }

  const matchesFilename = OFFICE_JS_FILENAMES.some(name => parsed.pathname.endsWith(`/${name}`));
  if (!matchesFilename) {
    return {
      error:
        'Office.js URL must end in /office.js or /office.debug.js — Office.js derives its base path from this filename and cannot find its other files without it'
    };
  }

  return { value: trimmed };
}

/**
 * Strip the filename off an Office.js URL to get the base path its sibling
 * files are served from. Returns a URL ending in `/`.
 *
 * @param {string} officeJsUrl - A URL that has passed `validateOfficeJsUrl`
 * @returns {string|null}
 */
export function deriveOfficeJsBaseUrl(officeJsUrl) {
  const validated = validateOfficeJsUrl(officeJsUrl);
  if (validated.error) return null;
  const parsed = new URL(validated.value);
  // Drop the query too: it applies to office.js only, not to its siblings.
  parsed.search = '';
  parsed.pathname = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);
  return parsed.toString();
}

/**
 * Resolve the effective Office.js source from platform configuration.
 *
 * @param {Object} platform - The platform config (as returned by configCache)
 * @returns {{ mode: string, scriptUrl: string, upstreamBaseUrl: string|null }}
 *   `scriptUrl` is what goes into the HTML. `upstreamBaseUrl` is the CDN base
 *   the proxy pulls from, and is null for modes that do not proxy.
 */
export function resolveOfficeJsSource(platform) {
  const officeConfig = platform?.officeIntegration || {};

  const mode = OFFICE_JS_MODES.includes(officeConfig.officeJsMode)
    ? officeConfig.officeJsMode
    : DEFAULT_OFFICE_JS_MODE;

  // A stored CDN URL that no longer validates falls back to the default rather
  // than leaving the add-in with no library at all.
  const cdnCandidate = validateOfficeJsUrl(officeConfig.officeJsCdnUrl);
  const cdnUrl = cdnCandidate.value || DEFAULT_OFFICE_JS_CDN_URL;

  if (mode === 'proxy' || mode === 'bundled') {
    return {
      mode,
      scriptUrl: OFFICE_JS_LOCAL_URL,
      upstreamBaseUrl: mode === 'proxy' ? deriveOfficeJsBaseUrl(cdnUrl) : null
    };
  }

  if (mode === 'custom') {
    const custom = validateOfficeJsUrl(officeConfig.officeJsCustomUrl);
    if (custom.error) {
      // Only reachable if platform.json was hand-edited — the admin API
      // validates this field on save.
      logger.warn('Invalid officeJsCustomUrl, falling back to the Microsoft CDN', {
        component: 'OfficeJsSource',
        reason: custom.error
      });
      return { mode: 'cdn', scriptUrl: cdnUrl, upstreamBaseUrl: null };
    }
    return { mode: 'custom', scriptUrl: custom.value, upstreamBaseUrl: null };
  }

  return { mode: 'cdn', scriptUrl: cdnUrl, upstreamBaseUrl: null };
}

/**
 * Matches the `src` of an Office.js `<script>` tag in the add-in HTML,
 * whatever origin it currently points at. Capturing the URL rather than
 * matching one hard-coded constant means the HTML and this module do not have
 * to agree on a default.
 */
const OFFICE_JS_SCRIPT_SRC_PATTERN =
  /(<script[^>]*\ssrc=")([^"]*\/office(?:\.debug)?\.js(?:\?[^"]*)?)(")/gi;

/**
 * Rewrite the Office.js `<script src="...">` in an add-in HTML document to the
 * configured source.
 *
 * @param {string} html
 * @param {string} scriptUrl
 * @returns {string}
 */
export function rewriteOfficeJsScriptSrc(html, scriptUrl) {
  if (typeof html !== 'string' || !scriptUrl) return html;
  return html.replace(OFFICE_JS_SCRIPT_SRC_PATTERN, (_match, prefix, _url, suffix) => {
    return `${prefix}${scriptUrl}${suffix}`;
  });
}

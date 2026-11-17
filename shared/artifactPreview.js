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

/** `type` of the message an artifact posts to its host to ask a follow-up question. */
export const ARTIFACT_SEND_PROMPT_MESSAGE = 'ihub-artifact:send-prompt';

/** Longest follow-up question an artifact may hand the chat, in characters. */
export const ARTIFACT_PROMPT_MAX_LENGTH = 2000;

/**
 * The script that gives an artifact `sendPrompt(text)`: a click in the page
 * asks the chat a follow-up question. It only posts a message to the parent;
 * the frame stays without `allow-same-origin`, and the host decides what
 * happens (the chat asks the user to confirm before anything is sent). Where
 * no chat is around (a shared link, the standalone page) `sendPrompt` exists
 * but does nothing and `sendPrompt.available` is `false`, so a page can hide
 * its "ask" controls.
 *
 * @param {boolean} available - Whether the host listens.
 * @returns {string} One inline `<script>` element.
 */
function promptBridgeScript(available) {
  const body = available
    ? 'var t=String(text==null?"":text).trim();' +
      `if(!t)return false;parent.postMessage({type:'${ARTIFACT_SEND_PROMPT_MESSAGE}',text:t.slice(0,${ARTIFACT_PROMPT_MAX_LENGTH})},'*');return true;`
    : 'return false;';
  return (
    `<script>(function(){function sendPrompt(text){${body}}` +
    `sendPrompt.available=${available ? 'true' : 'false'};` +
    'window.sendPrompt=sendPrompt;})()</script>'
  );
}

/**
 * The text of a follow-up question an artifact posted, or `null` when the
 * message is not one (a library's own `postMessage`, a malformed payload).
 *
 * @param {unknown} data - `MessageEvent.data`.
 * @returns {string|null}
 */
export function artifactPromptFromMessage(data) {
  if (!data || typeof data !== 'object' || data.type !== ARTIFACT_SEND_PROMPT_MESSAGE) return null;
  if (typeof data.text !== 'string') return null;
  // Control characters other than line breaks and tabs have no place in a question.

  const text = data.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, ARTIFACT_PROMPT_MAX_LENGTH) : null;
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
 * `sendPrompt` is defined in every preview (see `promptBridgeScript`); with
 * `promptBridge` it posts to the parent, without it it is a no-op.
 *
 * @param {unknown} html - Artifact markup.
 * @param {{scriptHosts?: string[], theme?: 'light'|'dark', promptBridge?: boolean}} [options]
 * @returns {string}
 */
export function prepareHtmlPreview(html, { scriptHosts = [], theme, promptBridge = false } = {}) {
  const source = String(html ?? '');
  let head = `<meta http-equiv="Content-Security-Policy" content="${artifactPreviewCsp(scriptHosts)}">`;
  if (theme === 'dark' || theme === 'light') {
    head += `<script>document.documentElement.setAttribute('data-theme','${theme}')</script>`;
  }
  head += promptBridgeScript(promptBridge === true);
  const doctype = source.match(/^\s*<!doctype[^>]*>/i);
  if (!doctype) return head + source;
  return doctype[0] + head + source.slice(doctype[0].length);
}

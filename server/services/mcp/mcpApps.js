/**
 * MCP Apps (SEP-1865, extension `io.modelcontextprotocol/ui`) — the pieces of
 * the host side that live on the server.
 *
 * An MCP server that supports MCP Apps declares a `ui://` resource holding an
 * HTML page and points a tool at it via `_meta.ui.resourceUri`. When the model
 * calls that tool, iHub renders the page in a sandboxed iframe next to the
 * answer and relays JSON-RPC between the page and the MCP server.
 *
 * This module holds the pure, transport-free rules:
 *   - the capability iHub advertises when it connects to an MCP server
 *   - reading `_meta.ui` off a tool (resource URI + visibility)
 *   - validating a `resources/read` result as an MCP App resource
 *   - building the Content-Security-Policy the sandbox is served with
 *   - bounding the tool payload that is handed to the browser
 *
 * @see https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 * @module services/mcp/mcpApps
 */

/** Extension identifier negotiated in `initialize` capabilities. */
export const MCP_UI_EXTENSION = 'io.modelcontextprotocol/ui';

/** The only UI resource MIME type the 2026-01-26 specification defines. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Visibility values the specification defines for `_meta.ui.visibility`. */
const VISIBILITY_VALUES = new Set(['model', 'app']);

/** Default when a tool declares no visibility. */
const DEFAULT_VISIBILITY = Object.freeze(['model', 'app']);

/**
 * Upper bound on a UI resource. Apps are usually a single bundled HTML file;
 * the reference apps (Excalidraw, draw.io) are a few hundred KB.
 */
export const MAX_UI_RESOURCE_BYTES = 5 * 1024 * 1024;

/**
 * Upper bound on the tool input + result handed to the browser for one view.
 * Beyond this the view is still rendered, but without the payload it would
 * need to redraw after a reload.
 */
export const MAX_VIEW_PAYLOAD_BYTES = 1024 * 1024;

/** Permission-policy features an app may request, mapped to `allow` tokens. */
const PERMISSION_FEATURES = Object.freeze({
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'geolocation',
  clipboardWrite: 'clipboard-write'
});

/**
 * Client capabilities iHub sends in `initialize`. Servers such as draw.io check
 * this to decide between rendering inline and returning a fallback link.
 *
 * @param {boolean} appsEnabled - Whether MCP Apps are enabled for the server
 * @returns {Object} ClientCapabilities
 */
export function buildClientCapabilities(appsEnabled) {
  if (!appsEnabled) return {};
  return { extensions: { [MCP_UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } };
}

/**
 * Whether MCP Apps are enabled for a server config. Defaults to on — the
 * server has to declare UI resources for anything to render.
 *
 * @param {Object} serverConfig
 * @returns {boolean}
 */
export function appsEnabledFor(serverConfig) {
  return serverConfig?.apps?.enabled !== false;
}

/**
 * Read the MCP Apps metadata off a tool from `tools/list`.
 *
 * Accepts the current nested form (`_meta.ui.resourceUri`) and the deprecated
 * flat key (`_meta["ui/resourceUri"]`) the specification still mentions.
 *
 * @param {Object} tool - Raw MCP Tool
 * @returns {{resourceUri: string|null, visibility: string[]}|null} null when
 *   the tool carries no MCP Apps metadata at all
 */
export function readToolUiMeta(tool) {
  const meta = tool?._meta;
  if (!meta || typeof meta !== 'object') return null;
  const ui = meta.ui && typeof meta.ui === 'object' ? meta.ui : null;
  const rawUri = ui?.resourceUri ?? meta['ui/resourceUri'];
  const resourceUri = isUiResourceUri(rawUri) ? rawUri : null;

  let visibility = DEFAULT_VISIBILITY;
  if (Array.isArray(ui?.visibility)) {
    const filtered = ui.visibility.filter(v => VISIBILITY_VALUES.has(v));
    // An explicit but empty/unknown list is treated as the default rather
    // than hiding the tool from everyone — a malformed server should degrade
    // to "ordinary tool", not disappear.
    if (filtered.length > 0) visibility = filtered;
  }

  if (!resourceUri && visibility === DEFAULT_VISIBILITY) return null;
  return { resourceUri, visibility: [...visibility] };
}

/**
 * @param {unknown} uri
 * @returns {boolean} true for a `ui://` URI of sane length
 */
export function isUiResourceUri(uri) {
  return typeof uri === 'string' && uri.startsWith('ui://') && uri.length <= 2048;
}

/**
 * @param {{visibility?: string[]}|null} ui
 * @returns {boolean} true when the model may see and call the tool
 */
export function isModelVisible(ui) {
  return !ui || ui.visibility.includes('model');
}

/**
 * @param {{visibility?: string[]}|null} ui
 * @returns {boolean} true when an app (view) may call the tool
 */
export function isAppCallable(ui) {
  return !ui || ui.visibility.includes('app');
}

/**
 * True when the tool is callable by apps only — never offered to the model.
 * @param {{visibility?: string[]}|null} ui
 * @returns {boolean}
 */
export function isAppOnly(ui) {
  return !!ui && ui.visibility.includes('app') && !ui.visibility.includes('model');
}

/**
 * Keep only string domain entries that cannot break out of a CSP source list:
 * `;` and newlines start a new directive, quotes smuggle keywords such as
 * `'unsafe-eval'`, a space smuggles a second source, `*` alone would allow
 * everything, and a scheme-only entry (`https:`) is just as broad.
 *
 * Accepts `https://host`, `https://*.host`, `wss://host:port` and the like.
 *
 * @param {unknown} domains
 * @returns {string[]}
 */
export function sanitizeCspDomains(domains) {
  if (!Array.isArray(domains)) return [];
  const out = [];
  for (const d of domains) {
    if (typeof d !== 'string') continue;
    const value = d.trim();
    if (!value || value.length > 253 + 16) continue;
    if (!/^(https?|wss?):\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?(\/[^\s;,'"]*)?$/i.test(value)) continue;
    if (!out.includes(value)) out.push(value);
    if (out.length >= 32) break;
  }
  return out;
}

/**
 * Normalise a resource's `_meta.ui.csp` into sanitized domain lists.
 * @param {unknown} csp
 * @returns {{connectDomains:string[], resourceDomains:string[], frameDomains:string[], baseUriDomains:string[]}}
 */
export function normalizeCsp(csp) {
  const src = csp && typeof csp === 'object' ? csp : {};
  return {
    connectDomains: sanitizeCspDomains(src.connectDomains),
    resourceDomains: sanitizeCspDomains(src.resourceDomains),
    frameDomains: sanitizeCspDomains(src.frameDomains),
    baseUriDomains: sanitizeCspDomains(src.baseUriDomains)
  };
}

/**
 * Normalise `_meta.ui.permissions` to the features the specification knows.
 * @param {unknown} permissions
 * @returns {Object<string, {}>}
 */
export function normalizePermissions(permissions) {
  const out = {};
  if (!permissions || typeof permissions !== 'object') return out;
  for (const key of Object.keys(PERMISSION_FEATURES)) {
    if (permissions[key]) out[key] = {};
  }
  return out;
}

/**
 * Permission-policy `allow` attribute value for the requested permissions.
 * @param {Object} permissions - Output of `normalizePermissions`
 * @returns {string}
 */
export function buildAllowAttribute(permissions) {
  return Object.keys(PERMISSION_FEATURES)
    .filter(key => permissions?.[key])
    .map(key => PERMISSION_FEATURES[key])
    .join('; ');
}

/**
 * Content-Security-Policy for the sandbox page, built from the resource's
 * declared domains. The view is written into the sandbox's inner frame, which
 * inherits this policy, so the header — not anything in the view's HTML — is
 * what bounds where the view may load from and connect to.
 *
 * Follows the specification's construction (and its reference host): inline
 * scripts and styles are allowed because apps ship as single bundled files,
 * everything external needs a declared origin, plugins are always blocked.
 *
 * Unlike the reference host there is no `'self'`: the sandbox page is served
 * from iHub's own URL (its document runs in an opaque origin), so `'self'`
 * would name iHub and let a view reach iHub's API. A view gets exactly the
 * origins its resource declares and nothing else.
 *
 * `frame-ancestors` limits who may embed the sandbox page: only iHub itself,
 * so another site cannot use it as a gadget on iHub's origin.
 *
 * @param {Object} [csp] - Declared domains (sanitized again here)
 * @param {Object} [options]
 * @param {string[]} [options.frameAncestors] - Extra embedding origins
 * @returns {string}
 */
export function buildSandboxCsp(csp, { frameAncestors = [] } = {}) {
  const { connectDomains, resourceDomains, frameDomains, baseUriDomains } = normalizeCsp(csp);
  const res = resourceDomains.join(' ');
  const join = (...parts) => parts.filter(Boolean).join(' ');
  const ancestors = ["'self'", ...sanitizeCspDomains(frameAncestors)].join(' ');
  return [
    "default-src 'none'",
    join("script-src 'unsafe-inline' 'unsafe-eval' blob: data:", res),
    join("style-src 'unsafe-inline' blob: data:", res),
    join('img-src data: blob:', res),
    join('font-src data: blob:', res),
    join('media-src data: blob:', res),
    connectDomains.length ? `connect-src ${connectDomains.join(' ')}` : "connect-src 'none'",
    join('worker-src blob:', res),
    frameDomains.length ? `frame-src ${frameDomains.join(' ')}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains.length ? `base-uri ${baseUriDomains.join(' ')}` : "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`
  ].join('; ');
}

/**
 * Pick the MCP App entry out of a `resources/read` result and validate it.
 *
 * @param {Object} readResult - `{ contents: [...] }` from resources/read
 * @param {string} uri - The URI that was read
 * @returns {{uri:string, html:string, csp:Object, permissions:Object, prefersBorder:(boolean|null)}}
 * @throws {Error} when the result holds no usable MCP App HTML
 */
export function extractUiResource(readResult, uri) {
  const contents = Array.isArray(readResult?.contents) ? readResult.contents : [];
  const entry = contents.find(c => c?.uri === uri) || contents[0];
  if (!entry) throw new Error(`UI resource ${uri} returned no contents`);

  const mimeType = String(entry.mimeType || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  if (mimeType !== MCP_APP_MIME_TYPE) {
    throw new Error(`UI resource ${uri} has unsupported MIME type "${entry.mimeType || ''}"`);
  }

  let html;
  if (typeof entry.text === 'string') {
    html = entry.text;
  } else if (typeof entry.blob === 'string') {
    html = Buffer.from(entry.blob, 'base64').toString('utf8');
  } else {
    throw new Error(`UI resource ${uri} carries neither text nor blob`);
  }
  if (!html.trim()) throw new Error(`UI resource ${uri} is empty`);
  if (Buffer.byteLength(html, 'utf8') > MAX_UI_RESOURCE_BYTES) {
    throw new Error(`UI resource ${uri} exceeds ${MAX_UI_RESOURCE_BYTES} bytes`);
  }

  const ui = entry._meta?.ui && typeof entry._meta.ui === 'object' ? entry._meta.ui : {};
  return {
    uri,
    html,
    csp: normalizeCsp(ui.csp),
    permissions: normalizePermissions(ui.permissions),
    prefersBorder: typeof ui.prefersBorder === 'boolean' ? ui.prefersBorder : null
  };
}

/**
 * The browser-facing copy of a tool result: the standard CallToolResult
 * fields only, so iHub-internal data never rides along.
 *
 * @param {Object} result - Raw CallToolResult from the MCP server
 * @returns {Object}
 */
export function toViewToolResult(result) {
  if (!result || typeof result !== 'object') {
    return { content: [{ type: 'text', text: result == null ? '' : String(result) }] };
  }
  const out = { content: Array.isArray(result.content) ? result.content : [] };
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    out.structuredContent = result.structuredContent;
  }
  if (result._meta && typeof result._meta === 'object') out._meta = result._meta;
  if (result.isError === true) out.isError = true;
  return out;
}

/**
 * Size of a value once serialized, or Infinity when it cannot be serialized.
 * @param {unknown} value
 * @returns {number}
 */
export function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return Infinity;
  }
}

/**
 * Build the view descriptor carried on the SSE frames and stored with the
 * assistant message: what to render (server + resource) and the data to
 * render it with (tool input + result), dropping the payload when it is too
 * large to ship to the browser.
 *
 * @param {Object} params
 * @param {string} params.callId - Tool call id (the view's identity)
 * @param {string} params.toolId - iHub tool id (prefixed)
 * @param {Object} params.mcp - The tool's `_mcp` marker
 * @param {Object} [params.args] - Tool input
 * @param {Object} [params.toolResult] - Browser-facing CallToolResult
 * @param {boolean} [params.cancelled] - Tool failed / was cancelled
 * @returns {Object}
 */
export function buildViewDescriptor({ callId, toolId, mcp, args, toolResult, cancelled }) {
  const view = {
    callId: String(callId),
    toolId: String(toolId),
    serverId: mcp.serverId,
    toolName: mcp.originalName,
    resourceUri: mcp.ui.resourceUri
  };
  const payload = { args: args && typeof args === 'object' ? args : {} };
  if (toolResult) payload.toolResult = toolResult;
  if (cancelled) payload.cancelled = true;
  if (jsonByteLength(payload) <= MAX_VIEW_PAYLOAD_BYTES) {
    Object.assign(view, payload);
  } else {
    view.payloadOmitted = true;
    if (cancelled) view.cancelled = true;
  }
  return view;
}

/** Upper bound on all MCP App views stored with one assistant message. */
export const MAX_STORED_VIEWS_BYTES = 2 * 1024 * 1024;

/** At most this many views are stored with one assistant message. */
export const MAX_STORED_VIEWS = 20;

/**
 * Bound the views stored with an answer. Views keep their order; once the
 * budget is spent the remaining views are stored without their payload
 * (`payloadOmitted`), so the chat still shows where they were.
 *
 * @param {Object[]} views - View descriptors from `buildViewDescriptor`
 * @param {number} [maxBytes]
 * @returns {Object[]}
 */
export function boundStoredViews(views, maxBytes = MAX_STORED_VIEWS_BYTES) {
  if (!Array.isArray(views)) return [];
  let budget = maxBytes;
  return views.slice(0, MAX_STORED_VIEWS).map(view => {
    const size = jsonByteLength(view);
    if (size <= budget) {
      budget -= size;
      return view;
    }
    const { args: _args, toolResult: _result, ...ref } = view;
    return { ...ref, payloadOmitted: true };
  });
}

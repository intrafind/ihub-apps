/**
 * Which HTML an MCP App view renders: the tool's declared `ui://` resource as
 * `resources/read` returns it, or — for servers that bake the call's data into
 * the page — the copy of that same resource embedded in the tool result. A
 * tool that declares no view at all but embeds a `ui://` page in its result
 * (mcp-ui servers) is rendered from that page alone (`embeddedViewResource`).
 *
 * Some MCP servers (the Langdock cookbook's ServiceNow `render_ticket`, and
 * mcp-ui servers in general) declare `_meta.ui.resourceUri` and then return,
 * in the CallToolResult, an embedded resource content item
 * `{ type: 'resource', resource: { uri, mimeType, text } }` for the very same
 * URI whose HTML carries the render data inline
 * (`<script>window.TICKET_DATA = …</script>`). The static copy from
 * `resources/read` has no data, so such a view renders empty unless the host
 * uses the embedded copy.
 *
 * The embedded copy is only used when its URI is exactly the one the tool
 * declared (so it comes from the same server and names the same resource — no
 * new trust boundary) and it is inline HTML text within the size cap that
 * applies to `resources/read`. Everything else about the view — CSP,
 * permissions, sandbox, bridge — still comes from the `resources/read` copy;
 * the embedded item's own `_meta` is ignored.
 *
 * @module features/chat/mcpApps/embeddedViewHtml
 */

/**
 * Largest view HTML rendered, in UTF-8 bytes. Mirrors the server's
 * `MAX_UI_RESOURCE_BYTES` (server/services/mcp/mcpApps.js), the cap on the
 * HTML `resources/read` hands a view.
 */
export const MAX_VIEW_HTML_BYTES = 5 * 1024 * 1024;

/** The MCP Apps profile parameter (`text/html;profile=mcp-app`). */
const MCP_APP_PROFILE = 'mcp-app';

/**
 * Whether a MIME type names HTML a view can render: `text/html`, optionally
 * with the MCP Apps profile (`text/html;profile=mcp-app`). Other profiles and
 * other HTML dialects (`text/html+skybridge`, written for another host's
 * runtime API) are not rendered.
 *
 * @param {unknown} mimeType
 * @returns {boolean}
 */
export function isViewHtmlMimeType(mimeType) {
  if (typeof mimeType !== 'string') return false;
  const [type, ...params] = mimeType.toLowerCase().replace(/\s+/g, '').split(';');
  if (type !== 'text/html') return false;
  return params.every(param => {
    const [name, value] = param.split('=');
    if (name === 'charset') return true;
    return name === 'profile' && value?.replace(/"/g, '') === MCP_APP_PROFILE;
  });
}

/**
 * Size of a string in UTF-8 bytes.
 * @param {string} text
 * @returns {number}
 */
function utf8ByteLength(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * UTF-8 text of a base64 `blob`, or null when it does not decode.
 * @param {string} blob
 * @returns {string|null}
 */
function decodeBase64Utf8(blob) {
  try {
    const binary = atob(blob);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The embedded resource item for `uri` in a tool result with usable view
 * HTML — inline `text`, or a base64 `blob` — within the size cap.
 *
 * @param {Object} [toolResult]
 * @param {string} uri
 * @returns {{resource: Object, html: string}|null}
 */
function findEmbeddedViewItem(toolResult, uri) {
  const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
  for (const item of content) {
    if (item?.type !== 'resource') continue;
    const resource = item.resource;
    if (!resource || typeof resource !== 'object' || resource.uri !== uri) continue;
    if (!isViewHtmlMimeType(resource.mimeType)) continue;
    const html =
      typeof resource.text === 'string'
        ? resource.text
        : typeof resource.blob === 'string'
          ? decodeBase64Utf8(resource.blob)
          : null;
    if (typeof html !== 'string' || !html.trim()) continue;
    if (utf8ByteLength(html) > MAX_VIEW_HTML_BYTES) continue;
    return { resource, html };
  }
  return null;
}

/**
 * The inline HTML of the embedded resource item in a tool result whose URI is
 * the tool's declared view resource, or null when there is none to use.
 *
 * @param {Object} [toolResult] - Browser-facing CallToolResult (`view.toolResult`)
 * @param {string} [declaredUri] - The tool's `_meta.ui.resourceUri` (`view.resourceUri`)
 * @returns {string|null}
 *
 * @example
 * embeddedViewHtml(
 *   { content: [{ type: 'resource', resource: { uri: 'ui://sn/ticket', mimeType: 'text/html;profile=mcp-app', text: '<html>…' } }] },
 *   'ui://sn/ticket'
 * ); // → '<html>…'
 */
export function embeddedViewHtml(toolResult, declaredUri) {
  if (typeof declaredUri !== 'string' || !declaredUri.startsWith('ui://')) return null;
  return findEmbeddedViewItem(toolResult, declaredUri)?.html ?? null;
}

/**
 * The view resource of a tool that declares no view, built from the page its
 * result embeds (`view.embedded`, see server/services/mcp/mcpApps.js
 * `findEmbeddedView`): the HTML, and the CSP domains the item's own
 * `_meta.ui.csp` declares — the sandbox page's server sanitizes them into
 * its CSP header, as it does for a `resources/read` copy. Device permissions
 * (camera, microphone, geolocation, clipboard) are never granted to such a
 * view: only a declared resource can ask for them.
 *
 * @param {Object} view - View descriptor (`{ resourceUri, toolResult, toolName, … }`)
 * @returns {Object|null} Shaped like the `GET /api/mcp-apps/resource` response,
 *   or null when the result holds no usable page
 */
export function embeddedViewResource(view) {
  const uri = view?.resourceUri;
  if (typeof uri !== 'string' || !uri.startsWith('ui://')) return null;
  const found = findEmbeddedViewItem(view?.toolResult, uri);
  if (!found) return null;
  const ui =
    found.resource._meta?.ui && typeof found.resource._meta.ui === 'object'
      ? found.resource._meta.ui
      : {};
  return {
    uri,
    html: found.html,
    csp: ui.csp && typeof ui.csp === 'object' ? ui.csp : {},
    permissions: {},
    allow: '',
    prefersBorder: typeof ui.prefersBorder === 'boolean' ? ui.prefersBorder : null,
    tool: {
      name: view.toolName || view.toolId || '',
      description: '',
      inputSchema: { type: 'object', properties: {} }
    },
    serverId: view.serverId
  };
}

/**
 * The HTML a view renders and where it came from.
 *
 * The embedded copy is chosen only when the `resources/read` copy was loaded
 * for the same declared URI. When both are identical the result says
 * `'resource'`, so a view that is already showing that HTML is not reloaded.
 *
 * @param {Object|null} resource - `GET /api/mcp-apps/resource` response (`{ uri, html, … }`)
 * @param {Object} view - View descriptor (`{ resourceUri, toolResult, … }`)
 * @returns {{html: string, source: 'embedded'|'resource'}|null} null until the resource is loaded
 */
export function selectViewHtml(resource, view) {
  if (!resource || typeof resource.html !== 'string') return null;
  const declaredUri = view?.resourceUri;
  if (resource.uri === declaredUri) {
    const embedded = embeddedViewHtml(view?.toolResult, declaredUri);
    if (embedded && embedded !== resource.html) return { html: embedded, source: 'embedded' };
  }
  return { html: resource.html, source: 'resource' };
}

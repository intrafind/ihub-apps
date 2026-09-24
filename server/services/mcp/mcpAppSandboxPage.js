/**
 * The MCP Apps sandbox proxy page (SEP-1865, "Sandbox proxy").
 *
 * A web host must not load a view's HTML into its own document. iHub embeds
 * this page in an iframe with `sandbox="allow-scripts allow-forms"` — no
 * `allow-same-origin` — so the page, and the view it writes into its inner
 * frame, run in an opaque origin: no access to iHub's DOM, cookies or storage,
 * and every exchange with iHub goes through `postMessage`.
 *
 * The specification asks for a sandbox on a separate origin with
 * `allow-same-origin`. A self-hosted iHub has one origin, so the separation
 * comes from the opaque origin instead; the page refuses to run anywhere else
 * (`window.origin !== 'null'`), and the route serves it with
 * `frame-ancestors 'self'` so no other site can embed it.
 *
 * Protocol, per the specification:
 *   1. page → host   `ui/notifications/sandbox-proxy-ready`
 *   2. host → page   `ui/notifications/sandbox-resource-ready` { html, permissions }
 *   3. the page writes the HTML into its inner frame, which inherits the CSP
 *      header the route computed from the resource's declared domains
 *   4. from then on every other message is relayed verbatim both ways;
 *      `ui/notifications/sandbox-*` methods are never relayed from the view
 *
 * @module services/mcp/mcpAppSandboxPage
 */

const PROXY_SCRIPT = String.raw`(function () {
  'use strict';
  var PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
  var RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';
  var RESERVED_PREFIX = 'ui/notifications/sandbox-';
  // The page is only ever embedded by iHub itself (frame-ancestors 'self'), so
  // the host is the origin this page was served from.
  var HOST_ORIGIN = window.location.origin;
  var FEATURES = {
    camera: 'camera',
    microphone: 'microphone',
    geolocation: 'geolocation',
    clipboardWrite: 'clipboard-write'
  };

  function fail(message) {
    document.body.textContent = message;
    throw new Error(message);
  }

  if (window.self === window.top) {
    fail('This page only runs inside the iHub MCP App sandbox.');
  }
  // Served from iHub's own URL, this page is only safe in an opaque origin.
  if (window.origin !== 'null') {
    fail('The MCP App sandbox must be embedded without allow-same-origin.');
  }

  var inner = null;

  function allowAttribute(permissions) {
    if (!permissions || typeof permissions !== 'object') return '';
    var list = [];
    for (var key in FEATURES) {
      if (Object.prototype.hasOwnProperty.call(FEATURES, key) && permissions[key]) {
        list.push(FEATURES[key]);
      }
    }
    return list.join('; ');
  }

  function load(params) {
    inner = document.createElement('iframe');
    // allow-same-origin keeps the inner frame in this page's (opaque) origin
    // so the HTML can be written into it; it cannot gain a real origin, since
    // the outer frame's sandbox flags carry over.
    inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    var allow = allowAttribute(params.permissions);
    if (allow) inner.setAttribute('allow', allow);
    inner.setAttribute('title', typeof params.title === 'string' ? params.title : 'MCP App');
    document.body.appendChild(inner);

    var html = typeof params.html === 'string' ? params.html : '';
    var doc = null;
    try {
      doc = inner.contentDocument;
    } catch (e) {
      doc = null;
    }
    if (doc) {
      doc.open();
      doc.write(html);
      doc.close();
    } else {
      inner.srcdoc = html;
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    var method = data && typeof data.method === 'string' ? data.method : '';
    if (event.source === window.parent) {
      if (event.origin !== HOST_ORIGIN) return;
      if (method === RESOURCE_READY) {
        if (!inner) load((data && data.params) || {});
        return;
      }
      if (inner && inner.contentWindow) inner.contentWindow.postMessage(data, '*');
      return;
    }
    if (inner && event.source === inner.contentWindow) {
      if (method.indexOf(RESERVED_PREFIX) === 0) return;
      window.parent.postMessage(data, HOST_ORIGIN);
    }
  });

  window.parent.postMessage({ jsonrpc: '2.0', method: PROXY_READY, params: {} }, HOST_ORIGIN);
})();`;

/** The complete sandbox page. Static: everything per-view arrives by message. */
export const SANDBOX_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>MCP App</title>
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
iframe { display: block; border: 0; width: 100%; height: 100%; background: transparent; color-scheme: inherit; }
</style>
</head>
<body>
<script>${PROXY_SCRIPT}</script>
</body>
</html>
`;

import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import react from '@vitejs/plugin-react';
import authGatePlugin from './vite-plugins/vite-plugin-auth-gate.js';
import vadAssetsPlugin from './vite-plugins/vite-plugin-vad-assets.js';

// Windows sign-in (NTLM) authenticates a TCP connection, not a request: the
// server's challenge and the browser's answer must travel over the same
// connection. Vite's proxy defaults to a fresh upstream connection per request
// (agent: false, "Connection: close"), so through :5173 the answer always
// arrives on a new connection and the server rejects it with a 500.
//
// This agent keeps upstream connections alive and pools them per browser
// connection: requests from one browser connection reuse one upstream
// connection, and the upstream connection is closed with it. HTTP/2 requests
// are not tagged and share an ordinary keep-alive pool; browsers fall back to
// HTTP/1.1 for NTLM on their own.
const CLIENT_CONN_HEADER = 'x-ihub-dev-client-conn';
const clientConnIds = new WeakMap();
let nextClientConnId = 0;
let affineAgent;

function createConnectionAffineAgent() {
  class ConnectionAffineAgent extends http.Agent {
    getName(options) {
      const conn = options.headers?.[CLIENT_CONN_HEADER];
      return conn ? `${super.getName(options)}|conn-${conn}` : super.getName(options);
    }
  }
  affineAgent = new ConnectionAffineAgent({ keepAlive: true });
  return affineAgent;
}

function tagClientConnection(req) {
  if (req.httpVersionMajor !== 1) return;
  const socket = req.socket;
  let id = clientConnIds.get(socket);
  if (id === undefined) {
    id = String(++nextClientConnId);
    clientConnIds.set(socket, id);
    socket.once('close', () => {
      const suffix = `|conn-${id}`;
      for (const pool of [affineAgent.freeSockets, affineAgent.sockets]) {
        for (const name of Object.keys(pool)) {
          if (name.endsWith(suffix)) pool[name].forEach(s => s.destroy());
        }
      }
    });
  }
  req.headers[CLIENT_CONN_HEADER] = id;
}

// Plugin that copies @microsoft/office-js/dist to dist/office/office-js after build.
// This backs the `bundled` Office.js mode (see server/utils/officeJsSource.js) for
// deployments with no outbound access at all. The package is no longer maintained
// upstream, so the copy never updates — the `proxy` and `custom` modes are the
// preferred way to serve Office.js from somewhere other than Microsoft's CDN.
function copyOfficeJsPlugin() {
  return {
    name: 'copy-office-js',
    closeBundle() {
      const src = resolve(__dirname, 'node_modules/@microsoft/office-js/dist');
      const dest = resolve(__dirname, 'dist/office/office-js');
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    }
  };
}

// Use office-addin-dev-certs if available — these are OS-trusted and required for
// Office add-in development (WebView2/WKWebView rejects untrusted self-signed certs).
// Run `npx office-addin-dev-certs install` once to generate and trust them.
function loadOfficeDevCerts() {
  const certDir = `${os.homedir()}/.office-addin-dev-certs`;
  try {
    return {
      key: fs.readFileSync(`${certDir}/localhost.key`),
      cert: fs.readFileSync(`${certDir}/localhost.crt`)
    };
  } catch {
    return undefined;
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  // vadAssetsPlugin publishes voice mode's VAD model + WebAssembly runtime under /vad/
  plugins: [react(), authGatePlugin(), copyOfficeJsPlugin(), vadAssetsPlugin()],
  base: './', // Use relative paths for all assets - works with dynamic base tag
  envDir: '../',
  build: {
    modulePreload: {
      resolveDependencies: (_filename, deps) => {
        // Only preload critical vendor chunks needed on initial render.
        // Heavy lazy-loaded chunks (mermaid, teams, pdf, babel, monaco, vendor-forms)
        // will load on-demand when actually needed.
        const lazyChunks = ['mermaid', 'teams', 'pdf', 'babel', 'monaco', 'vendor-forms', 'xlsx'];
        return deps.filter(dep => !lazyChunks.some(chunk => dep.includes(chunk)));
      }
    },
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'office-taskpane': resolve(__dirname, 'office/taskpane.html'),
        'office-commands': resolve(__dirname, 'office/commands.html'),
        // Browser-extension surfaces — built into client/dist/extension/
        // and packaged by /api/admin/browser-extension/download.{zip,crx}.
        'extension-sidepanel': resolve(__dirname, 'extension/sidepanel.html'),
        'extension-options': resolve(__dirname, 'extension/options.html'),
        // Nextcloud embed — built into client/dist/nextcloud/ and served by
        // server/routes/nextcloudEmbedPages.js with a frame-ancestors CSP
        // derived from the admin-configured allowedHostOrigins. The
        // Nextcloud-side scaffold (`nextcloud-app/src/shared.ts::buildEmbedUrl`)
        // points users at this entry, which mounts the standard <App /> with
        // an OAuth gate in front of it.
        'nextcloud-full-embed': resolve(__dirname, 'nextcloud/full-embed.html')
      },
      output: {
        // Keep a copyright banner in the entry chunks of the shipped JavaScript.
        // `postBanner` is added after minification; a plain `banner` is stripped
        // together with the other comments.
        postBanner: chunk =>
          chunk.isEntry
            ? '/*! SPDX-FileCopyrightText: IntraFind Software AG | SPDX-License-Identifier: LicenseRef-iHub-Apps */'
            : '',
        // Function form (object form is rejected by the rolldown-based Vite 8).
        // Maps a module id to its vendor chunk by package name; anything not
        // listed falls through to the default chunking.
        //
        // Only small, startup-critical packages belong here. Rolldown pulls every
        // dependency of a captured module into the same chunk
        // (`includeDependenciesRecursively` defaults to true), so a group for a
        // heavy lazy library (mermaid, pdfjs, teams, monaco, ...) also captures
        // the shared packages it depends on (DOMPurify, lodash, ...). Startup
        // code then imports those from the heavy chunk, which drags the whole
        // library into the initial load (this once put 4.8 MB of mermaid on the
        // start page). Lazy libraries are reached through dynamic import(), so
        // the default chunking already keeps them out of the startup bundle.
        manualChunks(id) {
          // Match top-level packages only: copies nested under another package
          // (e.g. mermaid/node_modules/marked) stay with their parent.
          const parts = id.split('node_modules/');
          if (parts.length !== 2) return undefined;
          const chunkMap = {
            'vendor-react': ['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'],
            'vendor-ui': ['@heroicons/react', 'react-icons', 'tailwindcss'],
            'vendor-utils': ['axios', 'uuid', 'file-saver', 'fuse.js', 'marked', 'turndown']
          };
          for (const [chunk, pkgs] of Object.entries(chunkMap)) {
            if (pkgs.some(pkg => parts[1].startsWith(`${pkg}/`))) {
              return chunk;
            }
          }
          return undefined;
        }
      }
    },
    chunkSizeWarningLimit: 1000
  },
  server: {
    https: loadOfficeDevCerts(),
    // Disable Vite's built-in CORS middleware. Otherwise Vite intercepts
    // every cross-origin OPTIONS preflight and answers it itself with a
    // wildcard "Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE"
    // and no Access-Control-Allow-Credentials — which silently breaks any
    // request whose preflight isn't covered by Vite's defaults (e.g. POST
    // /api/oauth/token from a chrome-extension:// origin). With cors: false
    // Vite forwards OPTIONS through the proxy to Express on :3000, where
    // our configurable CORS middleware (driven by /api/admin/cors/config)
    // is the single source of truth.
    cors: false,
    proxy: (() => {
      const basePath = process.env.VITE_BASE_PATH || '';
      const proxyConfig = {};
      const upstreamAgent = createConnectionAffineAgent();

      // Define the paths that need proxying
      const pathsToProxy = [
        '/api/',
        '/s/',
        '/docs',
        '/uploads',
        '/manifest.json',
        '/sw.js'
        // /office/ is intentionally NOT proxied:
        // Vite serves office HTML entries (taskpane.html, commands.html) as MPA pages
        // and serves client/public/office/assets/* from its public dir in dev mode.
      ];

      pathsToProxy.forEach(path => {
        // Handle both root paths and subpath
        const patterns = basePath ? [`${basePath}${path}`, path] : [path];

        patterns.forEach(pattern => {
          proxyConfig[pattern] = {
            target: 'http://localhost:3000',
            changeOrigin: true,
            xfwd: true,
            // Proxy WebSocket upgrades for the API (e.g. the realtime
            // speech-to-text endpoint at /api/voice/realtime). Scoped to /api
            // so Vite's own HMR socket is untouched.
            ws: path === '/api/',
            // Keep-alive agent that gives each browser connection its own
            // upstream connection (see createConnectionAffineAgent). bypass runs
            // before the request is proxied and tags it with its browser
            // connection; returning undefined lets the proxy continue.
            agent: upstreamAgent,
            bypass: req => {
              tagClientConnection(req);
              return undefined;
            },
            configure: proxy => {
              // xfwd adds X-Forwarded-For/Port/Proto but NOT X-Forwarded-Host.
              // changeOrigin replaces Host with the target, so Express can't see
              // the original browser-facing host without this header.
              proxy.on('proxyReq', (proxyReq, req) => {
                // The tag only selects the upstream socket; Express never sees it.
                proxyReq.removeHeader(CLIENT_CONN_HEADER);
                if (req.headers.host) {
                  proxyReq.setHeader('X-Forwarded-Host', req.headers.host);
                }
              });
              // The proxyReq handler above fires for HTTP only. WebSocket
              // upgrades (e.g. /api/voice/realtime) need the same header set via
              // proxyReqWs, otherwise the server sees the rewritten target host
              // and can't verify the browser-facing origin.
              proxy.on('proxyReqWs', (proxyReq, req) => {
                if (req.headers.host) {
                  proxyReq.setHeader('X-Forwarded-Host', req.headers.host);
                }
              });
            },
            rewrite: requestPath => {
              // For subpath requests like /ihub/api/..., rewrite to /ihub/api/...
              // For root requests like /api/..., rewrite to /ihub/api/... (if basePath is set)
              if (basePath && !requestPath.startsWith(basePath)) {
                return basePath + requestPath;
              }
              return requestPath;
            }
          };
        });
      });

      return proxyConfig;
    })()
  }
});

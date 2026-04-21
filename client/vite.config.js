import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';
import os from 'os';
import react from '@vitejs/plugin-react';
import authGatePlugin from './vite-plugins/vite-plugin-auth-gate.js';

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
  plugins: [react(), authGatePlugin()],
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
        'office-commands': resolve(__dirname, 'office/commands.html')
      },
      output: {
        manualChunks: {
          // Vendor chunks
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-ui': ['@heroicons/react', 'react-icons', 'tailwindcss'],
          'vendor-forms': ['react-quill', 'ajv', 'ajv-formats'],
          'vendor-utils': ['axios', 'uuid', 'file-saver', 'fuse.js', 'marked', 'turndown'],

          // Heavy dependencies that should be separate
          mermaid: ['mermaid'],
          monaco: ['@monaco-editor/react'],
          teams: ['@microsoft/teams-js', 'microsoft-cognitiveservices-speech-sdk'],
          pdf: ['pdfjs-dist'],
          babel: ['@babel/standalone'],
          office: ['react-markdown'],
          xlsx: ['xlsx']
        }
      }
    },
    chunkSizeWarningLimit: 1000
  },
  server: {
    https: loadOfficeDevCerts(),
    proxy: (() => {
      const basePath = process.env.VITE_BASE_PATH || '';
      const proxyConfig = {};

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
            configure: proxy => {
              // xfwd adds X-Forwarded-For/Port/Proto but NOT X-Forwarded-Host.
              // changeOrigin replaces Host with the target, so Express can't see
              // the original browser-facing host without this header.
              proxy.on('proxyReq', (proxyReq, req) => {
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

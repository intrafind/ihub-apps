import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import authGatePlugin from './vite-plugins/vite-plugin-auth-gate.js';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), authGatePlugin()],
  base: './', // Use relative paths for all assets - works with dynamic base tag
  envDir: '../',
  build: {
    modulePreload: {
      resolveDependencies: (_filename, deps) => {
        // Only preload the vendor chunks needed on initial render.
        // Everything else loads on-demand via dynamic import / React.lazy.
        return deps.filter(
          dep =>
            dep.includes('vendor-react') ||
            dep.includes('vendor-ui') ||
            dep.includes('vendor-utils')
        );
      }
    },
    rollupOptions: {
      output: {
        manualChunks: {
          // Only eagerly-loaded shared vendor code.
          // Heavy/lazy deps (mermaid, teams, pdf, babel, monaco, react-quill)
          // are NOT listed here — they split naturally via import() / React.lazy.
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-ui': ['@heroicons/react', 'react-icons', 'tailwindcss'],
          'vendor-utils': ['axios', 'uuid', 'file-saver', 'fuse.js', 'marked', 'turndown']
        }
      }
    },
    chunkSizeWarningLimit: 1000
  },
  server: {
    proxy: (() => {
      const basePath = process.env.VITE_BASE_PATH || '';
      const proxyConfig = {};

      // Define the paths that need proxying
      const pathsToProxy = ['/api/', '/s/', '/docs', '/uploads', '/manifest.json', '/sw.js'];

      pathsToProxy.forEach(path => {
        // Handle both root paths and subpath
        const patterns = basePath ? [`${basePath}${path}`, path] : [path];

        patterns.forEach(pattern => {
          proxyConfig[pattern] = {
            target: 'http://localhost:3000',
            changeOrigin: true,
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

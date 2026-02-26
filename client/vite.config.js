import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import authGatePlugin from './vite-plugins/vite-plugin-auth-gate.js';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), authGatePlugin()],
  base: './', // Use relative paths for all assets - works with dynamic base tag
  envDir: '../',
  build: {
    rollupOptions: {
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
          babel: ['@babel/standalone']
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

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // Use relative paths for all assets - works with dynamic base tag
  envDir: '../',
  server: {
    proxy: (() => {
      const basePath = process.env.VITE_BASE_PATH || '';
      const proxyConfig = {};

      // Define the paths that need proxying
      const pathsToProxy = ['/api/', '/s/', '/docs', '/uploads'];

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

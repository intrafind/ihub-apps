import { buildServerPath } from '../utils/basePath.js';
import configCache from '../configCache.js';
import {
  buildManifest,
  buildServiceWorkerScript,
  computePwaETag,
  resolvePwaConfig
} from '../services/pwa/PwaService.js';
import logger from '../utils/logger.js';

export default function registerPwaRoutes(app) {
  /**
   * Web App Manifest — dynamically built from ui.pwa config.
   * ETag-based cache: the browser always revalidates but gets a 304 if nothing changed.
   * When the admin changes PWA config, the ETag changes and the browser fetches a fresh manifest.
   */
  app.get(buildServerPath('/manifest.json'), (req, res) => {
    try {
      const uiConfig = configCache.getUI();
      const rawPwaConfig = uiConfig?.data?.pwa;

      if (!rawPwaConfig?.enabled) {
        return res.status(404).json({ error: 'PWA not enabled' });
      }

      const pwaConfig = resolvePwaConfig(rawPwaConfig);
      const etag = `"${computePwaETag(pwaConfig)}"`;

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.set({
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'no-cache',
        ETag: etag
      });

      res.json(buildManifest(pwaConfig));
    } catch (err) {
      logger.error('Error serving manifest.json', {
        component: 'PwaRoutes',
        error: err.message
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * Service Worker — generated dynamically so BASE_PATH is always correct.
   * Cache-Control: no-cache forces the browser's SW update check to always fetch,
   * which is the correct behaviour for service workers.
   * When PWA is disabled, a no-op SW is returned to cleanly replace any existing SW.
   */
  app.get(buildServerPath('/sw.js'), (req, res) => {
    try {
      const uiConfig = configCache.getUI();
      const rawPwaConfig = uiConfig?.data?.pwa;

      const script = rawPwaConfig?.enabled
        ? buildServiceWorkerScript(resolvePwaConfig(rawPwaConfig))
        : `// iHub Apps — PWA not enabled. No-op service worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
`;

      res.set({
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-cache'
      });

      res.send(script);
    } catch (err) {
      logger.error('Error serving sw.js', {
        component: 'PwaRoutes',
        error: err.message
      });
      res.status(500).send('// Service worker error');
    }
  });
}

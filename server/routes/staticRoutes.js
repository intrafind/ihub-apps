import express from 'express';
import path from 'path';
import config from '../config.js';
import { authRequired } from '../middleware/authRequired.js';
import logger from '../utils/logger.js';
import {
  buildServerPath,
  buildUploadsPath,
  buildDocsPath,
  getRelativeRequestPath
} from '../utils/basePath.js';
import configCache from '../configCache.js';
import { buildIndexWithPwaTags, resolvePwaConfig } from '../services/pwa/PwaService.js';

export default function registerStaticRoutes(app, { isPackaged, rootDir, basePath }) {
  // Only serve static files in production or packaged mode
  // In development, Vite serves the frontend directly
  if (isPackaged || config.NODE_ENV === 'production') {
    const staticPath = path.join(rootDir, 'public');
    logger.info(`Serving static files from: ${staticPath}`, { component: 'StaticRoutes' });

    // Serve static files at base path
    if (basePath) {
      app.use(basePath, express.static(staticPath));
    } else {
      app.use(express.static(staticPath));
    }
  } else {
    logger.info('Development mode: Static files served by Vite on port 5173', {
      component: 'StaticRoutes'
    });
  }

  // Serve uploaded assets
  const uploadsPath = path.join(rootDir, 'contents/uploads');
  logger.info(`Serving uploaded assets from: ${uploadsPath} at ${buildUploadsPath('/')}`, {
    component: 'StaticRoutes'
  });
  app.use(buildUploadsPath('/'), express.static(uploadsPath));

  // Serve documentation with authentication
  const docsPath = path.join(rootDir, 'docs/book');
  logger.info(`Serving documentation from: ${docsPath} at ${buildDocsPath('/')}`, {
    component: 'StaticRoutes'
  });
  app.use(buildDocsPath('/'), authRequired, express.static(docsPath));

  // Only set up SPA routing in production or packaged mode
  // In development, Vite handles all frontend routing
  if (isPackaged || config.NODE_ENV === 'production') {
    const indexPath = path.join(rootDir, 'public/index.html');
    logger.info(`SPA will be served from: ${indexPath}`, { component: 'StaticRoutes' });

    // SPA routing handler
    const spaHandler = (req, res, next) => {
      const relativePath = getRelativeRequestPath(req.path);

      // Don't serve SPA for API routes
      if (relativePath.startsWith('/api')) {
        return next();
      }

      // Don't serve SPA for docs routes if they weren't handled by static middleware
      if (relativePath.startsWith('/docs')) {
        return res.status(404).send('Documentation not found');
      }

      // Don't serve SPA for requests that look like static assets (have file extensions)
      // If they weren't served by the static middleware above, they don't exist
      if (relativePath.match(/\.[a-z0-9]+$/i)) {
        return res.status(404).send('File not found');
      }

      const uiConfig = configCache.getUI();
      const rawPwaConfig = uiConfig?.data?.pwa;

      if (rawPwaConfig?.enabled) {
        const pwaConfig = resolvePwaConfig(rawPwaConfig);
        const html = buildIndexWithPwaTags(indexPath, pwaConfig);
        if (html !== null) {
          res.set('Content-Type', 'text/html; charset=utf-8');
          res.set('Cache-Control', 'no-cache');
          return res.send(html);
        }
        // buildIndexWithPwaTags logged the error; fall through to sendFile
      }

      res.sendFile(indexPath);
    };

    // Catch-all for SPA routing (but exclude API and docs paths)
    // Register under basePath if configured, otherwise at root
    if (basePath) {
      app.get(`${basePath}/*`, spaHandler);
    } else {
      app.get('*', spaHandler);
    }
  } else {
    logger.info('Development mode: SPA routing handled by Vite on port 5173', {
      component: 'StaticRoutes'
    });
  }
}

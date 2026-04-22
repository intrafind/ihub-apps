// Office Add-in HTML Page Routes
// Serves the Office add-in HTML pages (taskpane, callback, commands) and static assets.
// These pages live outside the main SPA and need their own dedicated routes.

import path from 'path';
import express from 'express';
import { buildServerPath } from '../utils/basePath.js';
import { getRootDir } from '../pathUtils.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

export default function registerOfficeRoutes(app) {
  const rootDir = getRootDir();
  const isDevMode = process.env.NODE_ENV !== 'production' && process.pkg === undefined;

  // In production/packaged mode, serve from the built dist output (rootDir/public/office).
  // In development mode, the built output does not exist yet — serve static assets
  // (icons, callback.html) from the client source tree instead. The HTML entry points
  // (taskpane.html, commands.html) that need Vite processing are served natively by the
  // Vite dev server at http://localhost:5173 in dev mode.
  const officePath = isDevMode
    ? path.join(rootDir, 'client', 'public', 'office')
    : path.join(rootDir, 'public', 'office');
  const officeSourceHtmlPath = isDevMode ? path.join(rootDir, 'client', 'office') : null;

  // Serve office static assets (icons, bundled JS) — always available so the
  // browser can cache icon files even when the integration is toggled.
  app.use(buildServerPath('/office/assets'), express.static(path.join(officePath, 'assets')));

  // Serve the Office add-in service worker without the requireOfficeEnabled guard so
  // that it can be fetched for unregistration even after the integration is disabled.
  // Cache-Control: no-cache forces the browser to revalidate on every load so SW updates
  // are picked up promptly.
  app.get(buildServerPath('/office/office-sw.js'), (req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(officePath, 'office-sw.js'));
  });

  // Guard middleware: return 404 when the integration is not enabled
  function requireOfficeEnabled(req, res, next) {
    const enabled = configCache.getPlatform()?.officeIntegration?.enabled;
    if (!enabled) {
      logger.debug('Office integration not enabled, returning 404', {
        component: 'OfficeRoutes',
        path: req.path
      });
      return res.status(404).send('Office integration is not enabled');
    }
    next();
  }

  app.get(buildServerPath('/office/taskpane.html'), requireOfficeEnabled, (req, res) => {
    // In dev mode, serve the source HTML from client/office/ (requires Vite for full functionality)
    const htmlDir = isDevMode ? officeSourceHtmlPath : officePath;
    res.sendFile(path.join(htmlDir, 'taskpane.html'));
  });

  app.get(buildServerPath('/office/callback.html'), requireOfficeEnabled, (req, res) => {
    // callback.html is a static file; in dev mode it lives in client/public/office/
    res.sendFile(path.join(officePath, 'callback.html'));
  });

  app.get(buildServerPath('/office/commands.html'), requireOfficeEnabled, (req, res) => {
    // In dev mode, serve the source HTML from client/office/
    const htmlDir = isDevMode ? officeSourceHtmlPath : officePath;
    res.sendFile(path.join(htmlDir, 'commands.html'));
  });
}

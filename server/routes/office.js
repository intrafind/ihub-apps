// Office Add-in HTML Page Routes
// Serves the Office add-in HTML pages (taskpane, callback, commands) and static assets.
// These pages live outside the main SPA and need their own dedicated routes.

import path from 'path';
import { readFileSync } from 'fs';
import express from 'express';
import { buildServerPath } from '../utils/basePath.js';
import { getRootDir } from '../pathUtils.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

// CDN URL used in the source HTML files — replaced at serve-time when offline mode is on.
const OFFICE_JS_CDN = 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js';
// Local path served under /office/office-js/office.js (relative to the add-in origin).
const OFFICE_JS_LOCAL = './office-js/office.js';

/**
 * Read an HTML file from disk and, when offline mode is enabled, swap the
 * hard-coded CDN office.js URL for the locally-served copy.
 */
function renderOfficeHtml(filePath) {
  const html = readFileSync(filePath, 'utf-8');
  const platform = configCache.getPlatform();
  const useLocal = platform?.officeIntegration?.useLocalOfficejs === true;
  if (useLocal) {
    return html.replaceAll(OFFICE_JS_CDN, OFFICE_JS_LOCAL);
  }
  return html;
}

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

  // Path where @microsoft/office-js dist files live.
  // Dev: served from the client node_modules package directly.
  // Production: copied there by the Vite copyOfficeJsPlugin during `npm run build`.
  const officeJsDistPath = isDevMode
    ? path.join(rootDir, 'client', 'node_modules', '@microsoft', 'office-js', 'dist')
    : path.join(rootDir, 'public', 'office', 'office-js');

  // Serve office static assets (icons, bundled JS) — always available so the
  // browser can cache icon files even when the integration is toggled.
  app.use(buildServerPath('/office/assets'), express.static(path.join(officePath, 'assets')));

  // Serve local @microsoft/office-js files so that environments that cannot
  // reach appsforoffice.microsoft.com can still load the add-in.
  // The files are only needed when useLocalOfficejs is enabled, but we expose
  // the route unconditionally so the admin can test the path without restarting
  // the server, and so that Vite in dev mode serves from the installed package.
  app.use(buildServerPath('/office/office-js'), express.static(officeJsDistPath));

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
    try {
      const html = renderOfficeHtml(path.join(htmlDir, 'taskpane.html'));
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      logger.error('Failed to serve taskpane.html', { component: 'OfficeRoutes', error: err });
      res.status(500).send('Internal server error');
    }
  });

  app.get(buildServerPath('/office/callback.html'), requireOfficeEnabled, (req, res) => {
    // callback.html is a static file; in dev mode it lives in client/public/office/
    try {
      const html = renderOfficeHtml(path.join(officePath, 'callback.html'));
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      logger.error('Failed to serve callback.html', { component: 'OfficeRoutes', error: err });
      res.status(500).send('Internal server error');
    }
  });

  app.get(buildServerPath('/office/commands.html'), requireOfficeEnabled, (req, res) => {
    // In dev mode, serve the source HTML from client/office/
    const htmlDir = isDevMode ? officeSourceHtmlPath : officePath;
    try {
      const html = renderOfficeHtml(path.join(htmlDir, 'commands.html'));
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      logger.error('Failed to serve commands.html', { component: 'OfficeRoutes', error: err });
      res.status(500).send('Internal server error');
    }
  });
}

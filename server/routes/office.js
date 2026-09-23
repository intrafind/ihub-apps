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
import { resolveOfficeJsSource, rewriteOfficeJsScriptSrc } from '../utils/officeJsSource.js';
import { getOfficeJsAsset, isSafeOfficeJsAssetPath } from '../services/OfficeJsProxyService.js';

/**
 * Read an add-in HTML file and point its Office.js `<script>` at the
 * configured source (Microsoft's CDN, this server's proxy or bundle, or a
 * custom URL). See `utils/officeJsSource.js` for how Office.js resolves the
 * rest of the library from that one URL.
 */
function renderOfficeHtml(filePath) {
  const html = readFileSync(filePath, 'utf-8');
  const { scriptUrl } = resolveOfficeJsSource(configCache.getPlatform());
  return rewriteOfficeJsScriptSrc(html, scriptUrl);
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
  // Bundle filenames are content-hashed by Vite, so a long immutable cache is
  // safe: a changed file gets a new name, a deploy never serves stale JS.
  // Without this, express.static's default max-age=0 forces a revalidation
  // round trip for every asset on every task-pane open — painful on slow links.
  app.use(
    buildServerPath('/office/assets'),
    express.static(path.join(officePath, 'assets'), { maxAge: '1y', immutable: true })
  );

  // Serve the Office.js library from this origin for the `proxy` and `bundled`
  // modes, so environments that cannot reach Microsoft's CDN can still load the
  // add-in. Mounted unconditionally: an admin can then verify the path works
  // before switching a mode on, and Vite serves from the installed package in
  // dev. Office.js loads every one of its other files relative to this mount.
  const bundledOfficeJs = express.static(officeJsDistPath, { maxAge: '1y', immutable: true });

  app.use(buildServerPath('/office/office-js'), (req, res, next) => {
    const { mode, upstreamBaseUrl } = resolveOfficeJsSource(configCache.getPlatform());
    if (mode !== 'proxy') {
      return bundledOfficeJs(req, res, next);
    }

    // `req.path` is relative to the mount point; strip the leading slash so the
    // allowlist sees the same shape it validates.
    let relPath;
    try {
      relPath = decodeURIComponent(req.path).replace(/^\/+/, '');
    } catch {
      return res.status(400).send('Invalid path');
    }

    if (!isSafeOfficeJsAssetPath(relPath)) {
      logger.debug('Rejected Office.js proxy path', { component: 'OfficeRoutes', relPath });
      return res.status(404).send('Not found');
    }

    getOfficeJsAsset(relPath, upstreamBaseUrl)
      .then(({ body, contentType, source }) => {
        res.set('Content-Type', contentType);
        // Office clients re-request these on every pane load; let the webview
        // cache them for the same window the CDN itself advertises.
        res.set('Cache-Control', 'public, max-age=14400');
        res.set('X-Office-Js-Source', source);
        res.send(body);
      })
      .catch(error => {
        logger.error('Failed to serve Office.js asset via proxy', {
          component: 'OfficeRoutes',
          relPath,
          error: error.message
        });
        res.status(error.status === 400 ? 400 : 502).send('Failed to load Office.js');
      });
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
    try {
      const html = renderOfficeHtml(path.join(htmlDir, 'taskpane.html'));
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-cache');
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
      res.set('Cache-Control', 'no-cache');
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
      res.set('Cache-Control', 'no-cache');
      res.send(html);
    } catch (err) {
      logger.error('Failed to serve commands.html', { component: 'OfficeRoutes', error: err });
      res.status(500).send('Internal server error');
    }
  });
}

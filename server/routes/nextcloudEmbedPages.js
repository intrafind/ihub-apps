// Nextcloud Embed HTML Page Routes
// Serves the embedded iHub UI for use as an iframe inside Nextcloud. The
// runtime API config + appinfo/info.xml live in
// `routes/integrations/nextcloudEmbed.js`; this file only serves HTML.
//
// Every HTML response carries a `Content-Security-Policy: frame-ancestors`
// header derived from the admin-configured `allowedHostOrigins`, so a
// non-allowlisted Nextcloud (or any other site) cannot embed iHub in an
// iframe. `'self'` is always included so the integration tester opened
// inside iHub itself works.

import path from 'path';
import express from 'express';
import { buildServerPath } from '../utils/basePath.js';
import { getRootDir } from '../pathUtils.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

function sanitizeFrameAncestors(allowedHostOrigins) {
  const sources = ["'self'"];
  if (Array.isArray(allowedHostOrigins)) {
    for (const item of allowedHostOrigins) {
      if (typeof item !== 'string') continue;
      try {
        const u = new URL(item);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        sources.push(u.origin);
      } catch {
        /* ignore */
      }
    }
  }
  return sources.join(' ');
}

function applyCsp(res, allowedHostOrigins) {
  const frameAncestors = sanitizeFrameAncestors(allowedHostOrigins);
  // Drop any prior X-Frame-Options the global middleware may have set —
  // it can't express a multi-origin allowlist and overrides
  // frame-ancestors in some user agents.
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
}

export default function registerNextcloudEmbedPageRoutes(app) {
  const rootDir = getRootDir();
  const isDevMode = process.env.NODE_ENV !== 'production' && process.pkg === undefined;

  const nextcloudPublicPath = isDevMode
    ? path.join(rootDir, 'client', 'public', 'nextcloud')
    : path.join(rootDir, 'public', 'nextcloud');
  const nextcloudSourceHtmlPath = isDevMode ? path.join(rootDir, 'client', 'nextcloud') : null;

  // Serve embed static assets (icons, bundled JS) — always available so the
  // browser can cache asset files even when the integration is toggled.
  app.use(
    buildServerPath('/nextcloud/assets'),
    express.static(path.join(nextcloudPublicPath, 'assets'))
  );

  function requireEmbedEnabled(req, res, next) {
    const enabled = configCache.getPlatform()?.nextcloudEmbed?.enabled;
    if (!enabled) {
      logger.debug('Nextcloud embed not enabled, returning 404', {
        component: 'NextcloudEmbedPages',
        path: req.path
      });
      return res.status(404).send('Nextcloud embed integration is not enabled');
    }
    next();
  }

  app.get(buildServerPath('/nextcloud/taskpane.html'), requireEmbedEnabled, (req, res) => {
    const allowedHostOrigins = configCache.getPlatform()?.nextcloudEmbed?.allowedHostOrigins;
    applyCsp(res, allowedHostOrigins);
    const htmlDir = isDevMode ? nextcloudSourceHtmlPath : nextcloudPublicPath;
    res.sendFile(path.join(htmlDir, 'taskpane.html'));
  });

  app.get(buildServerPath('/nextcloud/callback.html'), requireEmbedEnabled, (req, res) => {
    // The OAuth callback is loaded inside the iHub popup window, not the
    // Nextcloud iframe, so it doesn't need the host-allowlist; keep
    // `'self'` only to avoid accidental clickjacking.
    applyCsp(res, []);
    res.sendFile(path.join(nextcloudPublicPath, 'callback.html'));
  });
}

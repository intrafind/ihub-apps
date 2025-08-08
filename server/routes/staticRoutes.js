import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { authRequired } from '../middleware/authRequired.js';
import {
  buildServerPath,
  buildUploadsPath,
  buildDocsPath,
  getRelativeRequestPath
} from '../utils/basePath.js';

export default function registerStaticRoutes(app, { isPackaged, rootDir, basePath = '' }) {
  fileURLToPath(import.meta.url);

  let staticPath;
  if (isPackaged) {
    staticPath = path.join(rootDir, 'public');
  } else if (config.NODE_ENV === 'production') {
    staticPath = path.join(rootDir, 'public');
  } else {
    staticPath = path.join(rootDir, 'client/dist');
  }

  console.log(`Serving static files from: ${staticPath}`);

  // Serve static files at base path
  if (basePath) {
    app.use(basePath, express.static(staticPath));
  } else {
    app.use(express.static(staticPath));
  }

  // Serve uploaded assets
  const uploadsPath = path.join(rootDir, 'contents/uploads');
  console.log(`Serving uploaded assets from: ${uploadsPath} at ${buildUploadsPath('/')}`);
  app.use(buildUploadsPath('/'), express.static(uploadsPath));

  // Serve documentation with authentication
  const docsPath = path.join(rootDir, 'docs/book');
  console.log(`Serving documentation from: ${docsPath} at ${buildDocsPath('/')}`);
  app.use(buildDocsPath('/'), authRequired, express.static(docsPath));

  // Determine index path once during setup
  let indexPath;
  if (isPackaged) {
    indexPath = path.join(rootDir, 'public/index.html');
  } else if (config.NODE_ENV === 'production') {
    indexPath = path.join(rootDir, 'public/index.html');
  } else {
    indexPath = path.join(rootDir, 'client/dist/index.html');
  }
  console.log(`SPA will be served from: ${indexPath}`);

  // Catch-all for SPA routing (but exclude API and docs paths)
  app.get('*', (req, res, next) => {
    const relativePath = getRelativeRequestPath(req.path);

    // Don't serve SPA for API routes
    if (relativePath.startsWith('/api')) {
      return next();
    }

    // Don't serve SPA for docs routes if they weren't handled by static middleware
    if (relativePath.startsWith('/docs')) {
      return res.status(404).send('Documentation not found');
    }

    res.sendFile(indexPath);
  });
}

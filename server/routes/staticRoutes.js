import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { authRequired } from '../middleware/authRequired.js';

export default function registerStaticRoutes(app, { isPackaged, rootDir }) {
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
  app.use(express.static(staticPath));

  // Serve uploaded assets
  const uploadsPath = path.join(rootDir, 'contents/uploads');
  console.log(`Serving uploaded assets from: ${uploadsPath}`);
  app.use('/uploads', express.static(uploadsPath));

  // Serve documentation with authentication
  const docsPath = path.join(rootDir, 'docs/book');
  console.log(`Serving documentation from: ${docsPath}`);
  app.use('/docs', authRequired, express.static(docsPath));

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

  // Catch-all for SPA routing (but exclude docs paths)
  app.get('*', (req, res, next) => {
    // Don't serve SPA for docs routes if they weren't handled by static middleware
    if (req.path.startsWith('/docs')) {
      return res.status(404).send('Documentation not found');
    }
    res.sendFile(indexPath);
  });
}

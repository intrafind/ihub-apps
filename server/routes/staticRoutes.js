import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

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

  app.get('*', (req, res) => {
    let indexPath;
    if (isPackaged) {
      indexPath = path.join(rootDir, 'public/index.html');
    } else if (config.NODE_ENV === 'production') {
      indexPath = path.join(rootDir, 'public/index.html');
    } else {
      indexPath = path.join(rootDir, 'client/dist/index.html');
    }
    console.log(`Serving SPA from: ${indexPath}`);
    res.sendFile(indexPath);
  });
}

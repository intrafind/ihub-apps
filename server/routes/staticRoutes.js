import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

export default function registerStaticRoutes(app, { isPackaged, rootDir }) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  let staticPath;
  if (isPackaged) {
    staticPath = path.join(rootDir, 'public');
  } else if (process.env.NODE_ENV === 'production') {
    staticPath = path.join(__dirname, '../public');
  } else {
    staticPath = path.join(__dirname, '../client/dist');
  }

  console.log(`Serving static files from: ${staticPath}`);
  app.use(express.static(staticPath));

  app.get('*', (req, res) => {
    let indexPath;
    if (isPackaged) {
      indexPath = path.join(rootDir, 'public/index.html');
    } else if (process.env.NODE_ENV === 'production') {
      indexPath = path.join(__dirname, '../public/index.html');
    } else {
      indexPath = path.join(__dirname, '../client/dist/index.html');
    }
    console.log(`Serving SPA from: ${indexPath}`);
    res.sendFile(indexPath);
  });
}

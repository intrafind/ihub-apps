import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';

export function getRootDir() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const isPackaged = process.pkg !== undefined || config.APP_ROOT_DIR !== undefined;
  return isPackaged
    ? config.APP_ROOT_DIR || path.dirname(process.execPath)
    : path.join(__dirname, '..');
}

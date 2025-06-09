import path from 'path';
import { fileURLToPath } from 'url';

export function getRootDir() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const isPackaged = process.pkg !== undefined || process.env.APP_ROOT_DIR !== undefined;
  return isPackaged
    ? (process.env.APP_ROOT_DIR || path.dirname(process.execPath))
    : path.join(__dirname, '..');
}

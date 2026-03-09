/**
 * Path resolution utilities for the CLI
 * Detects root directory in development and packaged binary contexts
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find the root directory of the iHub installation.
 * Checks (in order):
 *  1. APP_ROOT_DIR env var (set by packaged binary)
 *  2. Parent of cli/ directory (development)
 *  3. CWD (if it has a server/ subdirectory)
 *  4. Dir of running binary
 */
export function getRootDir() {
  if (process.env.APP_ROOT_DIR) {
    return process.env.APP_ROOT_DIR;
  }

  // Development: cli/ lives inside the repo root
  const repoRoot = path.join(__dirname, '..', '..');
  if (fs.existsSync(path.join(repoRoot, 'server', 'server.js'))) {
    return repoRoot;
  }

  // Packaged binary context
  const binDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(binDir, 'server', 'server.js'))) {
    return binDir;
  }

  // Fallback to CWD
  if (fs.existsSync(path.join(process.cwd(), 'server', 'server.js'))) {
    return process.cwd();
  }

  return repoRoot;
}

export function getContentsDir() {
  return process.env.CONTENTS_DIR || path.join(getRootDir(), 'contents');
}

export function getServerDir() {
  return path.join(getRootDir(), 'server');
}

export function getDefaultsDir() {
  return path.join(getServerDir(), 'defaults');
}

export function getLogFile() {
  return path.join(getRootDir(), 'server.log');
}

export function getPidFile() {
  return path.join(os.tmpdir(), 'ihub-server.pid');
}

export function getEnvFile() {
  return path.join(getRootDir(), '.env');
}

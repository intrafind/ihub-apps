import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';
import logger from './logger.js';

/**
 * Get application version from various sources
 *
 * Priority order:
 * 1. Environment variable APP_VERSION
 * 2. Version file (for binary builds)
 * 3. package.json (for development)
 * 4. Fallback default
 */
export function getAppVersion() {
  // 1. Check environment variable first
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION;
  }

  const rootDir = getRootDir();

  // 2. Check for version file (created during build)
  const versionFilePath = join(rootDir, 'version.txt');
  if (existsSync(versionFilePath)) {
    try {
      const version = readFileSync(versionFilePath, 'utf8').trim();
      if (version) {
        return version;
      }
    } catch (error) {
      logger.warn('Could not read version from version.txt:', {
        component: 'Version',
        error: error.message
      });
    }
  }

  // 3. Try to read from package.json (development mode)
  const packageJsonPath = join(rootDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.version) {
        return packageJson.version;
      }
    } catch (error) {
      logger.warn('Could not read version from package.json:', {
        component: 'Version',
        error: error.message
      });
    }
  }

  // 4. Fallback version
  return '1.0.0';
}

/**
 * Log version information during startup
 */
export function logVersionInfo() {
  const version = getAppVersion();
  const source = process.env.APP_VERSION
    ? 'environment variable'
    : existsSync(join(getRootDir(), 'version.txt'))
      ? 'version.txt'
      : existsSync(join(getRootDir(), 'package.json'))
        ? 'package.json'
        : 'default';

  logger.info(`📦 Application version: ${version} (source: ${source})`, { component: 'Version' });
  return version;
}

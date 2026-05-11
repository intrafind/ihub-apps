/**
 * Update Service
 * Handles in-place updates for binary/standalone installations.
 * Downloads new versions from GitHub Releases, verifies checksums,
 * creates backups, swaps application files, and supports rollback.
 */
import { promises as fs } from 'fs';
import {
  createWriteStream,
  existsSync,
  createReadStream,
  readdirSync,
  readFileSync,
  statSync
} from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getRootDir } from '../pathUtils.js';
import { getAppVersion } from '../utils/versionHelper.js';
import { httpFetch } from '../utils/httpConfig.js';
import logger from '../utils/logger.js';

const execAsync = promisify(execFile);

const GITHUB_REPO = 'intrafind/ihub-apps';
const UPDATE_TMP_DIR = '.update-tmp';
const UPDATE_STAGING_DIR = '.update-staging';
const UPDATE_BACKUP_DIR = '.update-backup';
const UPDATE_LOCK_FILE = '.update-lock';
const UPDATE_RESTART_CODE = 75;

/**
 * Returns the list of files/directories that should be replaced during updates.
 * The Node binary name is platform-specific (node.exe on Windows, node elsewhere).
 */
function getReplacePaths() {
  const platform = detectPlatform();
  const nodeBinary = platform === 'windows' ? 'node.exe' : 'node';
  return ['server', 'shared', 'public', 'docs', 'launcher.cjs', nodeBinary, 'version.txt'];
}

/**
 * Detect the current platform from the launcher script filename
 */
function detectPlatform() {
  const rootDir = getRootDir();
  try {
    const files = readdirSync(rootDir);
    const launcher = files.find(f => /^ihub-apps-v.*-(linux|macos|win\.bat)$/.test(f));
    if (launcher) {
      if (launcher.endsWith('-linux')) return 'linux';
      if (launcher.endsWith('-macos')) return 'macos';
      if (launcher.endsWith('-win.bat')) return 'windows';
    }
  } catch {
    // Fallback to OS detection
  }

  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * Check if running as a binary installation (not development mode)
 */
export function isBinaryInstallation() {
  const rootDir = getRootDir();
  const hasVersionFile = existsSync(join(rootDir, 'version.txt'));
  const hasPackageJson = existsSync(join(rootDir, 'package.json'));
  // Binary installs have version.txt but no root package.json
  return hasVersionFile && !hasPackageJson;
}

/**
 * Check if running inside a container (Docker, Podman, Kubernetes, etc.).
 *
 * Auto-updates must be disabled in containers: a successful update writes to
 * the container's ephemeral filesystem and is lost on restart, while any
 * data-migration side effects (config, indexes, etc.) persist on volumes —
 * leaving the next container start running an older binary against migrated
 * state. Cached so the filesystem checks only run once per process.
 */
let containerDetectionCache = null;
export function isContainerInstallation() {
  if (containerDetectionCache !== null) return containerDetectionCache;

  // Explicit override — set by our Dockerfile and useful for custom images
  // or non-Docker container runtimes that we can't auto-detect.
  const explicit = process.env.IHUB_CONTAINER || process.env.CONTAINER;
  if (explicit && /^(1|true|yes|docker|podman|kubernetes|k8s)$/i.test(explicit)) {
    containerDetectionCache = true;
    return true;
  }

  // Kubernetes injects this into every pod
  if (process.env.KUBERNETES_SERVICE_HOST) {
    containerDetectionCache = true;
    return true;
  }

  // Docker creates /.dockerenv; Podman creates /run/.containerenv
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
    containerDetectionCache = true;
    return true;
  }

  // Inspect cgroup membership — works for most container runtimes on Linux
  try {
    if (existsSync('/proc/1/cgroup')) {
      const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
      if (/docker|kubepods|containerd|libpod|lxc|garden/i.test(cgroup)) {
        containerDetectionCache = true;
        return true;
      }
    }
  } catch {
    // ignore — cgroup file may not be readable on non-Linux platforms
  }

  containerDetectionCache = false;
  return false;
}

// In-memory update state
let updateState = {
  status: 'idle', // idle | checking | downloading | extracting | staging | applying | restarting | error
  progress: 0,
  message: '',
  error: null,
  stagedVersion: null,
  backupVersion: null
};

/**
 * Get current update status
 */
export function getUpdateStatus() {
  const rootDir = getRootDir();
  const backupBaseDir = join(rootDir, UPDATE_BACKUP_DIR);
  const hasBackup = existsSync(backupBaseDir);
  let backupVersion = null;

  if (hasBackup) {
    try {
      const versions = readdirSync(backupBaseDir).filter(d => {
        try {
          return statSync(join(backupBaseDir, d)).isDirectory();
        } catch {
          return false;
        }
      });
      if (versions.length > 0) {
        versions.sort().reverse();
        const bvPath = join(backupBaseDir, versions[0], 'version.txt');
        if (existsSync(bvPath)) {
          backupVersion = readFileSync(bvPath, 'utf8').trim();
        }
      }
    } catch {
      // ignore
    }
  }

  const hasStaged = existsSync(join(rootDir, UPDATE_STAGING_DIR));

  const isContainer = isContainerInstallation();

  return {
    ...updateState,
    isBinary: isBinaryInstallation(),
    isContainer,
    updatesEnabled: !isContainer,
    hasBackup,
    backupVersion,
    hasStaged,
    currentVersion: getAppVersion()
  };
}

function setState(updates) {
  updateState = { ...updateState, ...updates };
}

/**
 * Acquire update lock to prevent concurrent operations
 */
async function acquireLock() {
  const lockPath = join(getRootDir(), UPDATE_LOCK_FILE);
  if (existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      const lockAge = Date.now() - lockData.timestamp;
      // Stale lock after 10 minutes
      if (lockAge < 10 * 60 * 1000) {
        throw new Error('Another update operation is in progress');
      }
      logger.warn('Removing stale update lock', { component: 'UpdateService' });
    } catch (error) {
      if (error.message === 'Another update operation is in progress') throw error;
      // Invalid lock file, remove it
    }
  }
  await fs.writeFile(lockPath, JSON.stringify({ timestamp: Date.now(), pid: process.pid }));
}

async function releaseLock() {
  const lockPath = join(getRootDir(), UPDATE_LOCK_FILE);
  try {
    await fs.unlink(lockPath);
  } catch {
    // ignore
  }
}

/**
 * Compare two semantic versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;

  const cleanV1 = v1.split('-')[0];
  const cleanV2 = v2.split('-')[0];

  const parts1 = cleanV1.split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = cleanV2.split('.').map(p => parseInt(p, 10) || 0);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Check for available updates from GitHub Releases
 */
export async function checkForUpdate() {
  setState({ status: 'checking', error: null });

  try {
    const currentVersion = getAppVersion();
    const platform = detectPlatform();

    const response = await httpFetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ihub-apps-updater'
        }
      }
    );

    if (!response.ok) {
      setState({ status: 'idle' });
      return {
        updateAvailable: false,
        currentVersion,
        error:
          response.status === 404 ? 'No releases found' : `GitHub API error: ${response.status}`
      };
    }

    const releaseData = await response.json();
    if (!releaseData.tag_name) {
      setState({ status: 'idle' });
      return { updateAvailable: false, currentVersion, error: 'Invalid release data' };
    }

    const latestVersion = releaseData.tag_name.replace(/^v/, '');
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

    // Find the matching asset for this platform
    const archiveName = `ihub-apps-${releaseData.tag_name}-${platform}.tar.gz`;
    const asset = releaseData.assets?.find(a => a.name === archiveName);
    const checksumsAsset = releaseData.assets?.find(a => a.name === 'checksums.sha256');

    setState({ status: 'idle' });

    return {
      updateAvailable,
      currentVersion,
      latestVersion,
      releaseUrl: releaseData.html_url,
      releaseName: releaseData.name,
      publishedAt: releaseData.published_at,
      platform,
      assetUrl: asset?.browser_download_url || null,
      assetSize: asset?.size || null,
      checksumsUrl: checksumsAsset?.browser_download_url || null,
      tagName: releaseData.tag_name
    };
  } catch (error) {
    setState({ status: 'idle', error: error.message });
    return {
      updateAvailable: false,
      currentVersion: getAppVersion(),
      error: 'Failed to check for updates: ' + error.message
    };
  }
}

/**
 * Download and stage an update
 */
export async function downloadUpdate(updateInfo) {
  const rootDir = getRootDir();

  if (!updateInfo?.assetUrl) {
    throw new Error('No download URL available for this platform');
  }

  await acquireLock();

  const tmpDir = join(rootDir, UPDATE_TMP_DIR);
  const stagingDir = join(rootDir, UPDATE_STAGING_DIR);

  try {
    setState({ status: 'downloading', progress: 0, message: 'Downloading update...', error: null });

    // Sanitize version string to prevent path traversal
    const safeVersion = updateInfo.latestVersion.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeVersion) {
      throw new Error('Invalid version string in update info');
    }

    // Clean up any previous staging/tmp
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });

    // Download the archive
    const archivePath = join(tmpDir, `update-${safeVersion}.tar.gz`);
    await downloadFile(updateInfo.assetUrl, archivePath, updateInfo.assetSize);

    // Download and verify checksum
    if (updateInfo.checksumsUrl) {
      setState({ status: 'extracting', progress: 90, message: 'Verifying checksum...' });
      const checksumsPath = join(tmpDir, 'checksums.sha256');
      await downloadFile(updateInfo.checksumsUrl, checksumsPath);
      await verifyChecksum(archivePath, checksumsPath, updateInfo);
    } else {
      logger.warn('No checksums file available, skipping verification', {
        component: 'UpdateService'
      });
    }

    // Validate archive contents before extraction to prevent path traversal
    setState({ status: 'extracting', progress: 93, message: 'Validating archive...' });
    const { stdout: tarList } = await execAsync('tar', ['-tzf', archivePath], {
      maxBuffer: 50 * 1024 * 1024
    });
    const archiveEntries = tarList.split('\n').filter(Boolean);
    for (const entry of archiveEntries) {
      if (entry.startsWith('/') || entry.includes('../')) {
        throw new Error(`Archive contains unsafe path: ${entry}`);
      }
    }

    // Extract the archive
    setState({ status: 'extracting', progress: 95, message: 'Extracting update...' });
    await fs.mkdir(stagingDir, { recursive: true });
    await execAsync('tar', ['-xzf', archivePath, '-C', stagingDir]);

    // Find the extracted content (may be in a subdirectory)
    const entries = await fs.readdir(stagingDir);
    let extractedRoot = stagingDir;
    if (entries.length === 1) {
      const subPath = join(stagingDir, entries[0]);
      const stat = await fs.stat(subPath);
      if (stat.isDirectory()) {
        extractedRoot = subPath;
      }
    }

    // Verify the extracted content has expected files
    const hasServer = existsSync(join(extractedRoot, 'server'));
    const hasPublic = existsSync(join(extractedRoot, 'public'));
    if (!hasServer || !hasPublic) {
      throw new Error('Downloaded archive does not contain expected application files');
    }

    // If extracted into a subdirectory, move files up to staging root
    if (extractedRoot !== stagingDir) {
      const subEntries = await fs.readdir(extractedRoot);
      for (const entry of subEntries) {
        await fs.rename(join(extractedRoot, entry), join(stagingDir, entry));
      }
      await fs.rm(extractedRoot, { recursive: true, force: true });
    }

    // Clean up the archive
    await fs.rm(tmpDir, { recursive: true, force: true });

    setState({
      status: 'idle',
      progress: 100,
      message: 'Update downloaded and staged',
      stagedVersion: updateInfo.latestVersion
    });

    logger.info('Update downloaded and staged successfully', {
      component: 'UpdateService',
      version: updateInfo.latestVersion
    });

    return { success: true, stagedVersion: updateInfo.latestVersion };
  } catch (error) {
    setState({ status: 'error', error: error.message, message: 'Download failed' });
    // Clean up on failure
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    await releaseLock();
  }
}

/**
 * Apply a staged update — swap files and prepare for restart
 */
export async function applyUpdate() {
  const rootDir = getRootDir();
  const stagingDir = join(rootDir, UPDATE_STAGING_DIR);

  if (!existsSync(stagingDir)) {
    throw new Error('No staged update found. Download an update first.');
  }

  await acquireLock();
  setState({ status: 'applying', progress: 0, message: 'Applying update...', error: null });

  const currentVersion = getAppVersion();
  const backupBaseDir = join(rootDir, UPDATE_BACKUP_DIR);
  const backupDir = join(backupBaseDir, currentVersion);

  try {
    // Remove any stale backup for THIS version only (e.g. from a failed attempt)
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.mkdir(backupDir, { recursive: true });

    // Save current version to backup
    await fs.writeFile(join(backupDir, 'version.txt'), currentVersion);

    // Backup and replace each path
    const replacePaths = getReplacePaths();
    let replacedCount = 0;
    for (const relPath of replacePaths) {
      const currentPath = join(rootDir, relPath);
      const stagedPath = join(stagingDir, relPath);
      const backupPath = join(backupDir, relPath);

      if (!existsSync(stagedPath)) {
        logger.debug('Staged path does not exist, skipping', {
          component: 'UpdateService',
          relPath
        });
        continue;
      }

      // Backup current file/directory
      if (existsSync(currentPath)) {
        await fs.rename(currentPath, backupPath);
      }

      // Move staged file/directory into place
      await fs.rename(stagedPath, currentPath);
      replacedCount++;
      setState({ progress: Math.round((replacedCount / replacePaths.length) * 70) });
    }

    // Handle launcher script (versioned filename)
    setState({ progress: 75, message: 'Updating launcher...' });
    await updateLauncherScript(rootDir, stagingDir, backupDir);

    // Ensure permissions on node binary and launcher (Unix only; Windows doesn't use chmod)
    setState({ progress: 85, message: 'Setting permissions...' });
    const platform = detectPlatform();
    if (platform !== 'windows') {
      const nodePath = join(rootDir, 'node');
      if (existsSync(nodePath)) {
        await fs.chmod(nodePath, 0o755);
      }
    }

    // Make any launcher scripts executable
    const rootFiles = await fs.readdir(rootDir);
    for (const f of rootFiles) {
      if (f.startsWith('ihub-apps-') && !f.endsWith('.bat')) {
        await fs.chmod(join(rootDir, f), 0o755);
      }
    }

    // Clean up staging directory
    setState({ progress: 90, message: 'Cleaning up...' });
    await fs.rm(stagingDir, { recursive: true, force: true });

    const newVersion = getAppVersion();
    setState({
      status: 'restarting',
      progress: 100,
      message: `Update applied. Restarting... (${currentVersion} → ${newVersion})`,
      stagedVersion: null,
      backupVersion: currentVersion
    });

    logger.info('Update applied successfully', {
      component: 'UpdateService',
      currentVersion,
      newVersion
    });

    return {
      success: true,
      previousVersion: currentVersion,
      newVersion,
      restartCode: UPDATE_RESTART_CODE
    };
  } catch (error) {
    logger.error('Update apply failed, attempting rollback', { component: 'UpdateService', error });
    setState({ status: 'error', error: error.message, message: 'Apply failed, rolling back...' });

    // Attempt automatic rollback
    try {
      await performRollback(rootDir, backupDir);
      setState({
        status: 'error',
        error: `Update failed and was rolled back: ${error.message}`,
        message: 'Update rolled back'
      });
    } catch (rollbackError) {
      logger.error('Rollback also failed', { component: 'UpdateService', error: rollbackError });
      setState({
        status: 'error',
        error: `Update AND rollback failed: ${error.message}. Rollback error: ${rollbackError.message}`,
        message: 'CRITICAL: Rollback failed'
      });
    }

    throw error;
  } finally {
    await releaseLock();
  }
}

/**
 * Manually rollback to the previous version
 */
export async function rollback() {
  const rootDir = getRootDir();
  const backupBaseDir = join(rootDir, UPDATE_BACKUP_DIR);

  if (!existsSync(backupBaseDir)) {
    throw new Error('No backup available for rollback');
  }

  const versions = (await fs.readdir(backupBaseDir)).filter(d => {
    try {
      return statSync(join(backupBaseDir, d)).isDirectory();
    } catch {
      return false;
    }
  });

  if (versions.length === 0) {
    throw new Error('No backup available for rollback');
  }

  versions.sort().reverse();
  const backupDir = join(backupBaseDir, versions[0]);

  await acquireLock();
  setState({ status: 'applying', progress: 0, message: 'Rolling back...', error: null });

  try {
    await performRollback(rootDir, backupDir);
    await releaseLock();

    const restoredVersion = getAppVersion();
    setState({
      status: 'restarting',
      progress: 100,
      message: `Rolled back to ${restoredVersion}. Restarting...`,
      backupVersion: null
    });

    logger.info('Rollback completed', { component: 'UpdateService', restoredVersion });

    return { success: true, restoredVersion, restartCode: UPDATE_RESTART_CODE };
  } catch (error) {
    setState({ status: 'error', error: error.message, message: 'Rollback failed' });
    await releaseLock();
    throw error;
  }
}

/**
 * Internal rollback implementation
 */
async function performRollback(rootDir, backupDir) {
  for (const relPath of getReplacePaths()) {
    const currentPath = join(rootDir, relPath);
    const backupPath = join(backupDir, relPath);

    if (!existsSync(backupPath)) continue;

    // Remove current (potentially partial) file
    await fs.rm(currentPath, { recursive: true, force: true });
    // Restore from backup
    await fs.rename(backupPath, currentPath);
  }

  // Restore launcher script
  await restoreLauncherScript(rootDir, backupDir);

  // Clean up the restored backup subdirectory (not the whole .update-backup/)
  await fs.rm(backupDir, { recursive: true, force: true });

  // If no more backups remain, clean up the parent directory too
  const backupBaseDir = join(rootDir, UPDATE_BACKUP_DIR);
  try {
    const remaining = await fs.readdir(backupBaseDir);
    if (remaining.length === 0) {
      await fs.rm(backupBaseDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

/**
 * Update the versioned launcher script
 */
async function updateLauncherScript(rootDir, stagingDir, backupDir) {
  const rootFiles = await fs.readdir(rootDir);
  const stagingFiles = await fs.readdir(stagingDir);

  // Find current launcher script
  const currentLauncher = rootFiles.find(f => /^ihub-apps-v.*-(linux|macos|win\.bat)$/.test(f));
  // Find new launcher script in staging
  const newLauncher = stagingFiles.find(f => /^ihub-apps-v.*-(linux|macos|win\.bat)$/.test(f));

  if (currentLauncher) {
    // Backup current launcher
    await fs.rename(join(rootDir, currentLauncher), join(backupDir, currentLauncher));
  }

  if (newLauncher) {
    // Move new launcher into place
    await fs.rename(join(stagingDir, newLauncher), join(rootDir, newLauncher));
    if (!newLauncher.endsWith('.bat')) {
      await fs.chmod(join(rootDir, newLauncher), 0o755);
    }
  }
}

/**
 * Restore launcher script from backup
 */
async function restoreLauncherScript(rootDir, backupDir) {
  try {
    const backupFiles = await fs.readdir(backupDir);
    const rootFiles = await fs.readdir(rootDir);

    // Remove any current launcher
    const currentLauncher = rootFiles.find(f => /^ihub-apps-v.*-(linux|macos|win\.bat)$/.test(f));
    if (currentLauncher) {
      await fs.unlink(join(rootDir, currentLauncher));
    }

    // Restore backed up launcher
    const backupLauncher = backupFiles.find(f => /^ihub-apps-v.*-(linux|macos|win\.bat)$/.test(f));
    if (backupLauncher) {
      await fs.rename(join(backupDir, backupLauncher), join(rootDir, backupLauncher));
      if (!backupLauncher.endsWith('.bat')) {
        await fs.chmod(join(rootDir, backupLauncher), 0o755);
      }
    }
  } catch (error) {
    logger.warn('Error restoring launcher script', { component: 'UpdateService', error });
  }
}

/**
 * Download a file with progress tracking
 */
async function downloadFile(url, destPath, expectedSize = null) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await httpFetch(url, {
        headers: {
          'User-Agent': 'ihub-apps-updater',
          Accept: 'application/octet-stream'
        },
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }

      const totalSize = expectedSize || parseInt(response.headers.get('content-length') || '0', 10);
      let downloadedSize = 0;

      const fileStream = createWriteStream(destPath);
      const body = response.body;

      if (body && totalSize > 0) {
        body.on('data', chunk => {
          downloadedSize += chunk.length;
          const progress = Math.round((downloadedSize / totalSize) * 85);
          setState({ progress });
        });
      }

      await pipeline(body, fileStream);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn('Download attempt failed, retrying', {
          component: 'UpdateService',
          attempt,
          delay,
          error
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Download failed after ${maxRetries} attempts: ${lastError.message}`);
}

/**
 * Verify file checksum against checksums file
 */
async function verifyChecksum(filePath, checksumsPath, updateInfo) {
  try {
    const checksumsContent = await fs.readFile(checksumsPath, 'utf8');
    const fileName = `ihub-apps-${updateInfo.tagName}-${updateInfo.platform}.tar.gz`;

    const expectedLine = checksumsContent.split('\n').find(line => line.includes(fileName));

    if (!expectedLine) {
      logger.warn('No checksum found, skipping verification', {
        component: 'UpdateService',
        fileName
      });
      return;
    }

    const expectedHash = expectedLine.trim().split(/\s+/)[0];

    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    const actualHash = hash.digest('hex');

    if (actualHash !== expectedHash) {
      throw new Error(`Checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
    }

    logger.info('Checksum verification passed', { component: 'UpdateService' });
  } catch (error) {
    if (error.message.startsWith('Checksum mismatch')) {
      throw error;
    }
    logger.warn('Checksum verification skipped', { component: 'UpdateService', error });
  }
}

/**
 * Check available disk space (best-effort)
 */
export async function checkDiskSpace() {
  const rootDir = getRootDir();
  try {
    const { stdout } = await execAsync('df', ['-k', rootDir]);
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return { available: null, sufficient: true };
    // df output: Filesystem 1K-blocks Used Available Use% Mounted on
    const columns = lines[lines.length - 1].trim().split(/\s+/);
    const availableKB = parseInt(columns[3], 10);
    if (isNaN(availableKB)) return { available: null, sufficient: true };

    // Need at least 500MB for backup + new version
    const requiredKB = 500 * 1024;
    return {
      available: availableKB * 1024,
      sufficient: availableKB >= requiredKB
    };
  } catch {
    return { available: null, sufficient: true };
  }
}

/**
 * Check write permissions on the install directory
 */
export async function checkWritePermissions() {
  const rootDir = getRootDir();
  const testFile = join(rootDir, '.update-write-test');
  try {
    await fs.writeFile(testFile, 'test');
    await fs.unlink(testFile);
    return true;
  } catch {
    return false;
  }
}

export { UPDATE_RESTART_CODE };

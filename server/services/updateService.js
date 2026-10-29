// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Update Service
 *
 * In-place updates for binary (single-server) installations. One pipeline,
 * three sources:
 *
 *   source (GitHub release | browser upload | file on the server)
 *     → acquire the archive into .update-tmp/
 *     → extract it into .update-staging/ (update/archive.js: hardened,
 *       nothing outside the staging directory is touched)
 *     → verify: Ed25519 signature on the manifest or checksum file, the
 *       manifest against every extracted file, published checksum, platform,
 *       architecture, version, minimum version to update from
 *     → the admin reviews the summary and confirms
 *     → apply: snapshot contents/config, then either hand the swap to the
 *       launcher for the next start (update/swap.cjs, "swap on start") or,
 *       under a launcher too old for that, swap in-process; restart the
 *       whole server (utils/processRestart.js)
 *
 * The online path (GitHub) is just one source; it shares every check with
 * the offline ones, which is what makes "install from file" for air-gapped
 * installations as trustworthy as the button.
 */
import { promises as fs, existsSync, readFileSync, statfsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getRootDir } from '../pathUtils.js';
import { getAppVersion } from '../utils/versionHelper.js';
import { httpFetch } from '../utils/httpConfig.js';
import { getContentsPath } from '../utils/contentsPath.js';
import {
  buildUpdateInfo,
  compareVersions,
  isVersionCheckDisabled,
  refreshVersionCheck
} from './versionCheckService.js';
import logger from '../utils/logger.js';
import config from '../config.js';
import { gather, isClusterBusActive, respond } from '../clusterBus.js';
import { BOOT_ID, UPDATE_RESTART_CODE } from '../utils/processRestart.js';
import swap from '../update/swap.cjs';
import {
  ARCHIVE_EXTENSIONS,
  detectArchiveFormat,
  getUpdateArchiveName,
  parseUpdateArchiveName
} from '../update/archiveNames.js';
import {
  ArchiveRejectedError,
  decodeBase64File,
  extractArchive,
  sha256File
} from '../update/archive.js';
import { loadTrustedKeys, verifyDetachedSignature } from '../update/signature.js';

const execFileAsync = promisify(execFile);

const UPDATE_TMP_DIR = '.update-tmp';
const UPDATE_STAGING_DIR = swap.STAGING_DIR;
const UPDATE_LOCK_FILE = '.update-lock';
/** Summary of the staged release, so every worker and a restarted server can show it. */
const STAGED_INFO_FILE = '.update-staged.json';
/** Drop-in folder an admin can copy release archives into. */
const LOCAL_UPDATE_DIR = 'updates';
const MANIFEST_FILE = 'update-manifest.json';
const SIGNATURE_SUFFIX = '.sig';
const CHECKSUMS_FILE = 'checksums.sha256';
/** A checksum or signature file is a few lines; anything bigger is not one. */
const MAX_SIDE_FILE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_MB = 1024;

/**
 * Top-level entries a release archive may contain that are NOT installed by an
 * update: install-time files (an admin may have customised the Windows service
 * definition or config.env) and build diagnostics.
 */
const IGNORED_TOP_LEVEL = new Set([
  'config.env',
  'ihub-apps-service.xml',
  'ihub-apps-service.exe',
  'install-service.cmd',
  'uninstall-service.cmd',
  'windows-check.bat'
]);

export { UPDATE_RESTART_CODE };

/** An update request the admin has to correct (bad input, missing confirmation). */
export class UpdateRequestError extends Error {
  constructor(message, { status = 400, code } = {}) {
    super(message);
    this.name = 'UpdateRequestError';
    this.status = status;
    this.code = code;
  }
}

// ------------------------------------------------------------ settings ----

/**
 * Reads `platform.json` → `update`. The server registers the config cache
 * (routes/admin/update.js); the CLI, which runs without one, reads the file.
 */
let updateSettingsProvider = null;

/** @param {() => (Object|undefined)} provider - Returns platform.json's `update` section */
export function setUpdateSettingsProvider(provider) {
  updateSettingsProvider = provider;
}

export function getUpdateSettings() {
  let section;
  if (updateSettingsProvider) {
    try {
      section = updateSettingsProvider();
    } catch {
      section = undefined;
    }
  } else {
    try {
      section = JSON.parse(
        readFileSync(getContentsPath('config', 'platform.json'), 'utf8')
      )?.update;
    } catch {
      section = undefined;
    }
  }
  const update = section && typeof section === 'object' ? section : {};
  const maxUploadSizeMB = Number(update.maxUploadSizeMB);
  return {
    allowUnsigned: update.allowUnsigned === true,
    trustedPublicKeys: Array.isArray(update.trustedPublicKeys) ? update.trustedPublicKeys : [],
    maxUploadSizeMB:
      Number.isFinite(maxUploadSizeMB) && maxUploadSizeMB > 0
        ? maxUploadSizeMB
        : DEFAULT_MAX_UPLOAD_MB
  };
}

// --------------------------------------------------------- environment ----

/** The installation's platform: `linux`, `macos` or `windows`. */
export function detectPlatform() {
  return swap.detectPlatform(getRootDir());
}

/**
 * Update protocol of the launcher that started this server. A launcher from
 * before swap-on-start sets nothing.
 */
export function getLauncherProtocol() {
  const value = Number.parseInt(process.env.IHUB_LAUNCHER_PROTOCOL || '', 10);
  return Number.isFinite(value) ? value : 1;
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

// --------------------------------------------------------------- state ----

// In-memory update state
let updateState = {
  status: 'idle', // idle | checking | downloading | extracting | staging | applying | restarting | error
  progress: 0,
  message: '',
  error: null,
  stagedVersion: null,
  backupVersion: null
};

function setState(updates) {
  updateState = { ...updateState, ...updates, updatedAt: Date.now() };
}

function readStagedInfo() {
  const rootDir = getRootDir();
  if (!existsSync(join(rootDir, UPDATE_STAGING_DIR))) return null;
  try {
    return JSON.parse(readFileSync(join(rootDir, STAGED_INFO_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Get current update status
 */
export function getUpdateStatus() {
  const rootDir = getRootDir();
  const platform = detectPlatform();
  const backups = swap.listBackups(rootDir);
  const latestBackup = backups[0] || null;
  const staged = readStagedInfo();
  const isContainer = isContainerInstallation();
  const isBinary = isBinaryInstallation();
  const settings = getUpdateSettings();
  const { keys } = loadTrustedKeys(settings.trustedPublicKeys);

  return {
    ...updateState,
    isBinary,
    isContainer,
    updatesEnabled: !isContainer,
    versionCheckEnabled: !isVersionCheckDisabled(),
    hasBackup: Boolean(latestBackup),
    backupVersion: latestBackup?.version || null,
    backupHasConfigSnapshot: Boolean(latestBackup?.hasConfigSnapshot),
    hasStaged: Boolean(staged) || existsSync(join(rootDir, UPDATE_STAGING_DIR)),
    staged,
    pendingRestart: Boolean(swap.readPending(rootDir)),
    lastResult: swap.readResult(rootDir),
    currentVersion: getAppVersion(),
    bootId: BOOT_ID,
    platform,
    arch: process.arch,
    archiveNameExample: getUpdateArchiveName('<version>', platform),
    localUpdateDir: join(rootDir, LOCAL_UPDATE_DIR),
    canInstallFromFile: isBinary && !isContainer,
    launcherProtocol: getLauncherProtocol(),
    swapOnStart: getLauncherProtocol() >= swap.LAUNCHER_PROTOCOL,
    signing: {
      trustedKeys: keys.length,
      allowUnsigned: settings.allowUnsigned
    },
    maxUploadSizeMB: settings.maxUploadSizeMB
  };
}

/**
 * The update runs on the cluster worker that received the admin's request,
 * and only that worker's `updateState` moves; a status poll reaching another
 * worker used to report `idle` and 0% and never showed a download error.
 * Every worker answers with its own state, and the poll picks among them
 * with {@link pickUpdateState}.
 */
const UPDATE_STATUS_CHANNEL = 'update:status';
respond(UPDATE_STATUS_CHANNEL, () => ({ state: updateState }));

/** States in which an update operation is still running. */
const ACTIVE_UPDATE_STATUSES = new Set([
  'checking',
  'downloading',
  'extracting',
  'staging',
  'applying',
  'restarting'
]);

/**
 * The state a status poll should show, out of every worker's.
 *
 * An operation that is still running wins: only one runs at a time (the update
 * lock), and its progress is what the admin is waiting for. Otherwise the most
 * recent outcome wins. "Not idle" alone does not do: an `error` stays in the
 * state of the worker that failed until that worker runs another operation,
 * so it would hide a later success on another worker, or this worker's own
 * old failure would hide a download running elsewhere.
 *
 * @param {Array<Object>} states - Worker update states; `updatedAt` is absent
 *   on a worker that has never run an operation
 * @returns {Object|undefined} The state to show
 */
export function pickUpdateState(states) {
  const newest = list =>
    list.reduce((best, state) => ((state.updatedAt || 0) > (best.updatedAt || 0) ? state : best));
  const known = states.filter(Boolean);
  if (known.length === 0) return undefined;
  const active = known.filter(state => ACTIVE_UPDATE_STATUSES.has(state.status));
  return newest(active.length > 0 ? active : known);
}

/**
 * {@link getUpdateStatus}, showing the update operation of whichever worker ran it.
 */
export async function getUpdateStatusAnywhere() {
  const local = getUpdateStatus();
  if (!isClusterBusActive()) return local;
  const replies = await gather(UPDATE_STATUS_CHANNEL, null, {
    expected: Math.max(0, (Number(config.WORKERS) || 1) - 1),
    timeoutMs: 500
  });
  const shown = pickUpdateState([updateState, ...replies.map(reply => reply?.state)]);
  return shown === updateState ? local : { ...local, ...shown };
}

// ---------------------------------------------------------------- lock ----

/**
 * Acquire update lock to prevent concurrent operations. The lock is a file in
 * the installation root, so it also holds across cluster workers and against
 * the CLI.
 */
async function acquireLock() {
  const lockPath = join(getRootDir(), UPDATE_LOCK_FILE);
  if (existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      const lockAge = Date.now() - lockData.timestamp;
      // Stale lock after 10 minutes without a heartbeat
      if (lockAge < 10 * 60 * 1000) {
        throw new UpdateRequestError('Another update operation is in progress', { status: 409 });
      }
      logger.warn('Removing stale update lock', { component: 'UpdateService' });
    } catch (error) {
      if (error instanceof UpdateRequestError) throw error;
      // Invalid lock file, remove it
    }
  }
  await fs.writeFile(lockPath, JSON.stringify({ timestamp: Date.now(), pid: process.pid }));
  // Long operations (a slow upload being staged, a large extraction) keep it fresh.
  const heartbeat = setInterval(() => {
    fs.writeFile(lockPath, JSON.stringify({ timestamp: Date.now(), pid: process.pid })).catch(
      () => {}
    );
  }, 60 * 1000);
  heartbeat.unref();
  return heartbeat;
}

async function releaseLock(heartbeat) {
  if (heartbeat) clearInterval(heartbeat);
  try {
    await fs.unlink(join(getRootDir(), UPDATE_LOCK_FILE));
  } catch {
    // ignore
  }
}

// ------------------------------------------------------- GitHub source ----

/**
 * Check for available updates from GitHub Releases, resolving the download
 * assets for this platform.
 *
 * The GitHub lookup runs through versionCheckService, so it is bounded by the
 * version-check timeout and shares that service's cache — a download started
 * right after a check therefore reuses the release the admin was shown.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force] - Bypass the cached release and re-query GitHub.
 */
export async function checkForUpdate({ force = false } = {}) {
  setState({ status: 'checking', error: null });

  const currentVersion = getAppVersion();

  if (isVersionCheckDisabled()) {
    setState({ status: 'idle' });
    return {
      updateAvailable: false,
      currentVersion,
      versionCheckDisabled: true
    };
  }

  const entry = await refreshVersionCheck({ force });
  const info = buildUpdateInfo(entry, currentVersion);

  setState({ status: 'idle', error: info.error ?? null });

  if (info.error || !entry.release) {
    return {
      updateAvailable: false,
      currentVersion,
      error: info.error ?? 'No release information available'
    };
  }

  // Find the matching asset for this platform
  const platform = detectPlatform();
  const tagName = entry.release.tag_name;
  const archiveName = getUpdateArchiveName(tagName, platform);
  const findAsset = name => entry.release.assets?.find(a => a.name === name);
  const asset = findAsset(archiveName);

  return {
    ...info,
    platform,
    archiveName,
    assetUrl: asset?.browser_download_url || null,
    assetSize: asset?.size || null,
    checksumsUrl: findAsset(CHECKSUMS_FILE)?.browser_download_url || null,
    checksumsSigUrl: findAsset(CHECKSUMS_FILE + SIGNATURE_SUFFIX)?.browser_download_url || null,
    tagName
  };
}

/**
 * Download the release for this platform from GitHub and stage it.
 *
 * @param {Object} updateInfo - From {@link checkForUpdate}, fetched server-side
 * @returns {Promise<Object>} The staging summary
 */
export async function downloadUpdate(updateInfo) {
  if (!updateInfo?.assetUrl) {
    throw new UpdateRequestError(
      `No download available for this platform (${updateInfo?.archiveName || 'unknown archive'})`
    );
  }
  const workDir = await createWorkDir('github');
  try {
    setState({ status: 'downloading', progress: 0, message: 'Downloading update...', error: null });
    const archivePath = join(workDir, workCopyName(updateInfo.archiveName));
    await downloadFile(updateInfo.assetUrl, archivePath, updateInfo.assetSize);

    let checksumsPath = null;
    let checksumsSigPath = null;
    if (updateInfo.checksumsUrl) {
      checksumsPath = join(workDir, CHECKSUMS_FILE);
      await downloadFile(updateInfo.checksumsUrl, checksumsPath, null, { progress: false });
    }
    if (updateInfo.checksumsSigUrl) {
      checksumsSigPath = join(workDir, CHECKSUMS_FILE + SIGNATURE_SUFFIX);
      await downloadFile(updateInfo.checksumsSigUrl, checksumsSigPath, null, { progress: false });
    }

    return await stageArchive({
      archivePath,
      originalName: updateInfo.archiveName,
      source: 'github',
      checksumsPath,
      checksumsSigPath
    });
  } catch (error) {
    if (updateState.status !== 'error') {
      setState({ status: 'error', error: error.message, message: 'Download failed' });
    }
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Download a file with progress tracking
 */
async function downloadFile(url, destPath, expectedSize = null, { progress = true } = {}) {
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

      const totalSize =
        expectedSize || Number.parseInt(response.headers.get('content-length') || '0', 10);
      let downloadedSize = 0;

      const fileStream = createWriteStream(destPath);
      const body = response.body;

      if (progress && body && totalSize > 0) {
        body.on('data', chunk => {
          downloadedSize += chunk.length;
          setState({ progress: Math.round((downloadedSize / totalSize) * 60) });
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

// --------------------------------------------------------- file sources ----

/** A private scratch directory below .update-tmp/ for one acquisition. */
export async function createWorkDir(prefix) {
  const dir = join(getRootDir(), UPDATE_TMP_DIR, `${prefix}-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Remove a directory made by {@link createWorkDir}; anything else is left alone. */
export function removeWorkDir(dir) {
  const tmpRoot = join(getRootDir(), UPDATE_TMP_DIR);
  if (typeof dir !== 'string' || !resolve(dir).startsWith(tmpRoot + sep)) return;
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Name of the private working copy of an archive: fixed, so nothing a client
 * or a release lists ends up in a path. The original name travels as metadata.
 */
function workCopyName(originalName) {
  const format = detectArchiveFormat(originalName);
  if (!format) throw new UpdateRequestError('Not a release archive');
  return `archive.${format.format}${format.base64 ? '.base64.txt' : ''}`;
}

function isAllowedArchiveName(name) {
  const lower = String(name || '').toLowerCase();
  return ARCHIVE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Archives in the `updates/` drop-in folder of the installation, newest first.
 * A convenience: any absolute path works too (see {@link stageLocalFile}).
 */
export async function listLocalCandidates() {
  const dir = join(getRootDir(), LOCAL_UPDATE_DIR);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { directory: dir, exists: false, files: [] };
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isAllowedArchiveName(entry.name)) continue;
    try {
      const stat = await fs.stat(join(dir, entry.name));
      const parsed = parseUpdateArchiveName(entry.name);
      files.push({
        name: entry.name,
        path: join(dir, entry.name),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        version: parsed?.version || null,
        platform: parsed?.platform || null
      });
    } catch {
      // vanished between readdir and stat
    }
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { directory: dir, exists: true, files };
}

/**
 * Read a small side file (checksums, signature) next to an archive, if present.
 * @returns {Promise<string|null>} Path of a private copy, or null
 */
async function copySideFile(sourcePath, workDir, name) {
  let handle;
  try {
    handle = await fs.open(sourcePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SIDE_FILE_BYTES) return null;
    const dest = join(workDir, name);
    await fs.writeFile(dest, await handle.readFile());
    return dest;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Stage an archive that already is on the server (an air-gapped admin copied
 * it there, or a browser upload would exceed a reverse proxy's body limit).
 *
 * Any absolute path an admin names is accepted (UNC paths included); it is
 * resolved with `realpath`, must be a regular file with an archive extension,
 * and is opened once and copied from that handle, so it cannot be swapped
 * between the check and the read. Errors never echo the file's content.
 * `checksums.sha256` and its `.sig` next to it are used when present.
 *
 * @param {string} requestedPath
 */
export async function stageLocalFile(requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new UpdateRequestError('A file path is required');
  }
  const trimmed = requestedPath.trim();
  if (trimmed.includes('\0')) throw new UpdateRequestError('Invalid file path');
  if (!isAbsolute(trimmed)) {
    throw new UpdateRequestError(
      'The path must be absolute (e.g. /opt/updates/… or C:\\updates\\…)'
    );
  }

  let realPath;
  try {
    realPath = await fs.realpath(trimmed);
  } catch (error) {
    throw new UpdateRequestError(
      error.code === 'EACCES' || error.code === 'EPERM'
        ? 'The server is not allowed to read this path'
        : 'File not found'
    );
  }
  const name = basename(realPath);
  if (!isAllowedArchiveName(name)) {
    throw new UpdateRequestError(
      `Not a release archive: expected a file ending in ${ARCHIVE_EXTENSIONS.join(', ')}`
    );
  }

  const workDir = await createWorkDir('local');
  let handle;
  try {
    try {
      handle = await fs.open(realPath, 'r');
    } catch (error) {
      throw new UpdateRequestError(
        error.code === 'EACCES' || error.code === 'EPERM'
          ? 'The server is not allowed to read this file'
          : 'The file could not be opened'
      );
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw new UpdateRequestError('The path is not a regular file');
    const maxBytes = getUpdateSettings().maxUploadSizeMB * 1024 * 1024 * 2;
    if (stat.size > maxBytes)
      throw new UpdateRequestError('The file is too large to be a release archive');
    await assertDiskSpaceFor(stat.size);

    setState({ status: 'staging', progress: 5, message: 'Reading archive...', error: null });
    const copy = join(workDir, workCopyName(name));
    await pipeline(
      handle.createReadStream({ start: 0, autoClose: false }),
      createWriteStream(copy)
    );

    const dir = resolve(realPath, '..');
    const checksumsPath = await copySideFile(join(dir, CHECKSUMS_FILE), workDir, CHECKSUMS_FILE);
    const checksumsSigPath = await copySideFile(
      join(dir, CHECKSUMS_FILE + SIGNATURE_SUFFIX),
      workDir,
      CHECKSUMS_FILE + SIGNATURE_SUFFIX
    );

    return await stageArchive({
      archivePath: copy,
      originalName: name,
      source: 'local',
      sourcePath: realPath,
      checksumsPath,
      checksumsSigPath
    });
  } finally {
    await handle?.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Stage an archive uploaded through the browser (already streamed to disk by
 * the route's multer storage).
 *
 * @param {{ path: string, originalname: string }} archiveFile
 * @param {{ path: string }|undefined} checksumsFile
 * @param {{ path: string }|undefined} checksumsSigFile
 */
export async function stageUploadedFile(archiveFile, checksumsFile, checksumsSigFile) {
  if (!archiveFile?.path) throw new UpdateRequestError('No archive was uploaded');
  const name = basename(String(archiveFile.originalname || ''));
  if (!isAllowedArchiveName(name)) {
    throw new UpdateRequestError(
      `Not a release archive: expected a file ending in ${ARCHIVE_EXTENSIONS.join(', ')}`
    );
  }
  const small = async file => {
    if (!file?.path) return null;
    const { size } = await fs.stat(file.path);
    return size <= MAX_SIDE_FILE_BYTES ? file.path : null;
  };
  return stageArchive({
    archivePath: archiveFile.path,
    originalName: name,
    source: 'upload',
    checksumsPath: await small(checksumsFile),
    checksumsSigPath: await small(checksumsSigFile)
  });
}

// ------------------------------------------------------------- staging ----

/** How a top-level archive entry is treated. */
function classifyTopLevel(name) {
  if (IGNORED_TOP_LEVEL.has(name)) return 'ignore';
  if (swap.LAUNCHER_SCRIPT_PATTERN.test(name)) return 'extract';
  const extractable = new Set([
    ...swap.getReplacePaths('linux'),
    ...swap.getReplacePaths('windows')
  ]);
  return extractable.has(name) ? 'extract' : 'reject';
}

function issue(code, message, params) {
  return params ? { code, message, params } : { code, message };
}

/**
 * Parse a `sha256sum`-format file (`<hex>  <name>` or `<hex> *<name>`, LF or CRLF).
 * @returns {Array<{ hash: string, name: string }>}
 */
export function parseChecksums(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(raw.trim());
    if (match) entries.push({ hash: match[1].toLowerCase(), name: basename(match[2]) });
  }
  return entries;
}

/**
 * What a published checksum file says about an archive. Matching is on the
 * exact file name, or on the hash when the file was renamed.
 *
 * @param {string|null} checksumsText
 * @param {string} fileName
 * @param {string[]} hashes - The archive's SHA-256, plus the decoded archive's for a .base64.txt
 * @returns {'match'|'mismatch'|'not-listed'|'missing'}
 */
export function evaluateChecksum(checksumsText, fileName, hashes) {
  if (checksumsText === null || checksumsText === undefined) return 'missing';
  const entries = parseChecksums(checksumsText);
  if (entries.some(entry => hashes.includes(entry.hash))) return 'match';
  if (entries.some(entry => entry.name === fileName)) return 'mismatch';
  return 'not-listed';
}

/**
 * Compare the extracted files with the manifest. Files under ignored top-level
 * entries were not extracted and are not compared.
 */
function compareWithManifest(manifestFiles, extracted) {
  const missing = [];
  const changed = [];
  const unlisted = [];
  for (const [rel, hash] of Object.entries(manifestFiles)) {
    if (classifyTopLevel(rel.split('/')[0]) !== 'extract') continue;
    const file = extracted.get(rel);
    if (!file) missing.push(rel);
    else if (file.sha256 !== String(hash).toLowerCase()) changed.push(rel);
  }
  for (const rel of extracted.keys()) {
    if (rel === MANIFEST_FILE || rel === MANIFEST_FILE + SIGNATURE_SUFFIX) continue;
    if (!Object.prototype.hasOwnProperty.call(manifestFiles, rel)) unlisted.push(rel);
  }
  return { missing, changed, unlisted, ok: !missing.length && !changed.length && !unlisted.length };
}

async function readOptional(file, maxBytes) {
  if (!file) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

async function assertDiskSpaceFor(archiveBytes) {
  const disk = checkDiskSpace({ archiveBytes });
  if (!disk.sufficient) {
    throw new UpdateRequestError(
      `Not enough free disk space in the installation directory: ` +
        `${Math.round(disk.required / 1024 ** 2)} MB needed, ${Math.round(disk.available / 1024 ** 2)} MB free`,
      { status: 507, code: 'disk-space' }
    );
  }
}

/**
 * Verify, extract and stage a release archive from any source.
 *
 * On success the release sits in `.update-staging/` and its summary in
 * `.update-staged.json`; nothing of the installation has changed yet. An
 * archive with problems is removed again and the summary (with `accepted:
 * false` and the problems) is returned so the admin can see why.
 *
 * @param {Object} options
 * @param {string} options.archivePath
 * @param {string} options.originalName - File name the archive arrived with
 * @param {'github'|'upload'|'local'} options.source
 * @param {string} [options.sourcePath] - For `local`: the resolved path
 * @param {string|null} [options.checksumsPath]
 * @param {string|null} [options.checksumsSigPath]
 * @returns {Promise<Object>} Summary
 */
export async function stageArchive({
  archivePath,
  originalName,
  source,
  sourcePath,
  checksumsPath = null,
  checksumsSigPath = null
}) {
  const rootDir = getRootDir();
  const stagingDir = join(rootDir, UPDATE_STAGING_DIR);
  const format = detectArchiveFormat(originalName);
  if (!format) {
    throw new UpdateRequestError(
      `Not a release archive: expected a file ending in ${ARCHIVE_EXTENSIONS.join(', ')}`
    );
  }

  const lock = await acquireLock();
  const scratch = await createWorkDir('stage');
  try {
    setState({ status: 'extracting', progress: 65, message: 'Verifying archive...', error: null });
    await fs.rm(join(rootDir, STAGED_INFO_FILE), { force: true });

    const { size: fileSize } = await fs.stat(archivePath);
    await assertDiskSpaceFor(fileSize);
    const fileSha256 = await sha256File(archivePath);
    let archiveToExtract = archivePath;
    let archiveSha256 = fileSha256;
    if (format.base64) {
      archiveToExtract = join(scratch, `archive.${format.format}`);
      await decodeBase64File(archivePath, archiveToExtract);
      archiveSha256 = await sha256File(archiveToExtract);
    }
    const { size: archiveSize } = await fs.stat(archiveToExtract);

    setState({ progress: 70, message: 'Extracting archive...' });
    const extracted = await extractArchive(archiveToExtract, stagingDir, {
      format: format.format,
      classifyTopLevel
    });

    setState({ progress: 90, message: 'Checking signature and compatibility...' });
    const summary = await evaluateStaged({
      stagingDir,
      extracted,
      originalName,
      source,
      sourcePath,
      fileSha256,
      archiveSha256,
      archiveSize,
      checksumsText:
        (await readOptional(checksumsPath, MAX_SIDE_FILE_BYTES))?.toString('utf8') ?? null,
      checksumsSig: await readOptional(checksumsSigPath, MAX_SIDE_FILE_BYTES),
      checksumsBytes: await readOptional(checksumsPath, MAX_SIDE_FILE_BYTES)
    });

    if (!summary.accepted) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      setState({
        status: 'error',
        progress: 0,
        message: 'Archive rejected',
        error: summary.problems.map(p => p.message).join('; '),
        stagedVersion: null
      });
      logger.warn('Update archive rejected', {
        component: 'UpdateService',
        source,
        fileName: originalName,
        sha256: archiveSha256,
        problems: summary.problems.map(p => p.code)
      });
      return summary;
    }

    await fs.writeFile(join(rootDir, STAGED_INFO_FILE), JSON.stringify(summary, null, 2), {
      mode: 0o600
    });
    setState({
      status: 'idle',
      progress: 100,
      message: 'Update verified and staged',
      error: null,
      stagedVersion: summary.version
    });
    logger.info('Update staged', {
      component: 'UpdateService',
      source,
      fileName: originalName,
      version: summary.version,
      sha256: archiveSha256,
      signature: summary.signature.status,
      checksum: summary.checksum
    });
    return summary;
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    const message =
      error instanceof ArchiveRejectedError ? `Archive rejected: ${error.message}` : error.message;
    setState({ status: 'error', progress: 0, error: message, message: 'Staging failed' });
    if (error instanceof ArchiveRejectedError) {
      throw new UpdateRequestError(message, { status: 422, code: 'archive-rejected' });
    }
    throw error;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    await releaseLock(lock);
  }
}

async function readStagedText(stagingDir, rel, maxBytes) {
  try {
    const file = join(stagingDir, rel);
    const stat = await fs.stat(file);
    if (stat.size > maxBytes) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/**
 * Work out what the staged release is and whether it may be installed.
 * Exported for tests.
 */
export async function evaluateStaged({
  stagingDir,
  extracted,
  originalName,
  source,
  sourcePath,
  fileSha256,
  archiveSha256,
  archiveSize,
  checksumsText,
  checksumsBytes,
  checksumsSig
}) {
  const problems = [];
  const warnings = [];
  const settings = getUpdateSettings();
  const { keys, invalid: invalidKeys } = loadTrustedKeys(settings.trustedPublicKeys);
  for (const message of invalidKeys) {
    warnings.push(
      issue('invalid-trusted-key', `A configured update key is not usable: ${message}`, {
        error: message
      })
    );
  }

  const currentVersion = getAppVersion();
  const currentPlatform = detectPlatform();

  // --- manifest
  const manifestBytes = await readStagedText(stagingDir, MANIFEST_FILE, MAX_MANIFEST_BYTES);
  const manifestSigBytes = await readStagedText(
    stagingDir,
    MANIFEST_FILE + SIGNATURE_SUFFIX,
    MAX_SIDE_FILE_BYTES
  );
  let manifest = null;
  let manifestCheck = null;
  if (manifestBytes) {
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (!manifest || typeof manifest !== 'object' || typeof manifest.files !== 'object') {
        throw new Error('no file list');
      }
    } catch (error) {
      manifest = null;
      problems.push(
        issue('manifest-invalid', `The update manifest is not valid: ${error.message}`, {
          error: error.message
        })
      );
    }
  } else {
    warnings.push(
      issue(
        'legacy-archive',
        'The archive has no update manifest (built before manifests were introduced); ' +
          'its contents cannot be checked file by file'
      )
    );
  }
  if (manifest) {
    manifestCheck = compareWithManifest(manifest.files, extracted.files);
    if (!manifestCheck.ok) {
      const sample = [...manifestCheck.changed, ...manifestCheck.missing, ...manifestCheck.unlisted]
        .slice(0, 5)
        .join(', ');
      problems.push(
        issue(
          'manifest-mismatch',
          `The archive's files do not match its manifest (${manifestCheck.changed.length} changed, ` +
            `${manifestCheck.missing.length} missing, ${manifestCheck.unlisted.length} unlisted: ${sample})`,
          {
            changed: manifestCheck.changed.length,
            missing: manifestCheck.missing.length,
            unlisted: manifestCheck.unlisted.length,
            sample
          }
        )
      );
    }
    if (manifest.product && manifest.product !== 'ihub-apps') {
      problems.push(
        issue('wrong-product', `The archive is not an iHub Apps release (${manifest.product})`, {
          product: String(manifest.product)
        })
      );
    }
  }

  // --- version
  const versionTxt = (await readStagedText(stagingDir, 'version.txt', 1024))
    ?.toString('utf8')
    .trim();
  const version = manifest?.version || versionTxt || null;
  if (
    !versionTxt ||
    !existsSync(join(stagingDir, 'server', 'server.js')) ||
    !existsSync(join(stagingDir, 'public'))
  ) {
    problems.push(
      issue(
        'incomplete',
        'The archive does not contain the application files (server/, public/, version.txt)'
      )
    );
  } else if (manifest?.version && manifest.version !== versionTxt) {
    problems.push(
      issue(
        'version-conflict',
        `The manifest says ${manifest.version}, version.txt says ${versionTxt}`,
        { manifest: manifest.version, versionTxt }
      )
    );
  }

  // --- signatures and checksums
  const manifestSignature = manifestBytes
    ? verifyDetachedSignature(manifestBytes, manifestSigBytes, keys)
    : { status: 'missing' };
  const checksumsSignature = checksumsBytes
    ? verifyDetachedSignature(checksumsBytes, checksumsSig, keys)
    : { status: 'missing' };
  const checksum = evaluateChecksum(checksumsText, originalName, [fileSha256, archiveSha256]);

  if (manifestSignature.status === 'invalid') {
    problems.push(
      issue(
        'signature-invalid',
        'The manifest signature does not match: the archive was modified after signing'
      )
    );
  }
  if (checksumsSignature.status === 'invalid') {
    problems.push(
      issue(
        'checksums-signature-invalid',
        'The signature on checksums.sha256 does not match the file'
      )
    );
  }
  if (checksum === 'mismatch') {
    problems.push(
      issue(
        'checksum-mismatch',
        `The archive does not match the published checksum for ${originalName}`,
        { file: originalName }
      )
    );
  } else if (checksum === 'not-listed') {
    warnings.push(
      issue('checksum-not-listed', 'The provided checksums.sha256 does not list this archive')
    );
  } else if (checksum === 'missing') {
    warnings.push(issue('checksum-missing', 'No checksums.sha256 was provided for this archive'));
  }

  let signedVia = null;
  if (manifestSignature.status === 'valid' && manifestCheck?.ok) signedVia = 'manifest';
  else if (checksumsSignature.status === 'valid' && checksum === 'match') signedVia = 'checksums';
  const signature =
    signedVia === 'manifest'
      ? manifestSignature
      : signedVia === 'checksums'
        ? checksumsSignature
        : manifestSignature.status !== 'missing'
          ? manifestSignature
          : checksumsSignature;
  const trusted = signedVia !== null;
  if (!trusted) {
    // `variant` picks the translation in the admin UI.
    const [variant, why] =
      keys.length === 0
        ? ['noKeys', 'no update signing key is configured on this server']
        : signature.status === 'unknown-key'
          ? [
              'unknownKey',
              `it is signed with a key this server does not trust (${signature.keyId || 'unknown'})`
            ]
          : ['notSigned', 'it is not signed'];
    const params = { variant, keyId: signature.keyId || '' };
    if (settings.allowUnsigned) {
      warnings.push(
        issue(
          'unsigned',
          `The archive's origin cannot be verified: ${why}. Installing it needs a typed confirmation.`,
          params
        )
      );
    } else {
      problems.push(
        issue(
          'untrusted',
          `The archive's origin cannot be verified: ${why}. Unsigned archives are refused ` +
            '(platform setting update.allowUnsigned).',
          params
        )
      );
    }
  }

  // --- compatibility gates
  const layoutPlatform = existsSync(join(stagingDir, 'node.exe'))
    ? 'windows'
    : swap.detectPlatform(stagingDir);
  const archivePlatform =
    manifest?.platform || parseUpdateArchiveName(originalName)?.platform || layoutPlatform;
  if (archivePlatform !== currentPlatform) {
    problems.push(
      issue(
        'wrong-platform',
        `The archive is for ${archivePlatform}, this server runs on ${currentPlatform}`,
        { archive: archivePlatform, server: currentPlatform }
      )
    );
  }
  const arch = manifest?.arch || null;
  if (arch && arch !== process.arch) {
    problems.push(
      issue('wrong-arch', `The archive is built for ${arch}, this server is ${process.arch}`, {
        archive: arch,
        server: process.arch
      })
    );
  } else if (!arch) {
    warnings.push(
      issue('arch-unknown', 'The archive does not say which CPU architecture it is built for')
    );
  }

  let comparison = 'unknown';
  if (version) {
    const order = compareVersions(version, currentVersion);
    comparison = order > 0 ? 'upgrade' : order === 0 ? 'same' : 'downgrade';
    if (comparison === 'downgrade') {
      warnings.push(
        issue('downgrade', `Version ${version} is older than the running ${currentVersion}`, {
          version,
          current: currentVersion
        })
      );
    } else if (comparison === 'same') {
      warnings.push(issue('same-version', `Version ${version} is already installed`, { version }));
    }
  }
  if (manifest?.minUpdateFrom && compareVersions(currentVersion, manifest.minUpdateFrom) < 0) {
    problems.push(
      issue(
        'min-update-from',
        `Version ${version} can only be installed over ${manifest.minUpdateFrom} or later; ` +
          `update to that version first`,
        { version, minimum: manifest.minUpdateFrom }
      )
    );
  }

  const launcherProtocol = getLauncherProtocol();
  const swapOnStart = launcherProtocol >= swap.LAUNCHER_PROTOCOL;
  if (!swapOnStart) {
    warnings.push(
      issue(
        'legacy-launcher',
        'The running launcher predates swap-on-start; this update is applied by the running server ' +
          '(subsequent updates are applied by the launcher before the server starts)'
      )
    );
  }

  // --- does the bundled Node start at all (quarantine, antivirus, wrong binary)
  let nodeVersion = manifest?.nodeVersion || null;
  if (problems.length === 0) {
    const nodeBinary = join(stagingDir, swap.nodeBinaryName(currentPlatform));
    if (existsSync(nodeBinary)) {
      if (currentPlatform !== 'windows') await fs.chmod(nodeBinary, 0o755).catch(() => {});
      try {
        const { stdout } = await execFileAsync(nodeBinary, ['--version'], { timeout: 20_000 });
        nodeVersion = stdout.trim() || nodeVersion;
      } catch (error) {
        problems.push(
          issue(
            'node-does-not-start',
            `The bundled Node.js binary does not start on this server (${error.code || error.message}); ` +
              'check antivirus quarantine or macOS Gatekeeper',
            { error: String(error.code || error.message) }
          )
        );
      }
    }
  }

  return {
    accepted: problems.length === 0,
    version,
    currentVersion,
    comparison,
    platform: archivePlatform,
    arch,
    nodeVersion,
    maxMigrationVersion: manifest?.maxMigrationVersion ?? null,
    source,
    fileName: originalName,
    sourcePath: sourcePath || null,
    archiveSha256,
    ...(fileSha256 !== archiveSha256 && { fileSha256 }),
    archiveSize,
    files: extracted.files.size,
    ignoredEntries: extracted.ignored,
    manifest: manifest ? 'present' : 'missing',
    signature: {
      status: trusted ? 'valid' : signature.status,
      via: signedVia,
      keyId: signature.keyId || null,
      label: signature.label || null
    },
    checksum,
    trusted,
    applyMode: swapOnStart ? 'swap-on-start' : 'in-process',
    requiresConfirmation: {
      downgrade: comparison === 'downgrade' || comparison === 'same',
      unsigned: !trusted
    },
    warnings,
    problems,
    stagedAt: new Date().toISOString()
  };
}

/**
 * Throw away the staged release.
 */
export async function discardStaged() {
  const rootDir = getRootDir();
  const lock = await acquireLock();
  try {
    if (swap.readPending(rootDir)) {
      throw new UpdateRequestError(
        'The staged update is already scheduled to be applied on restart',
        { status: 409 }
      );
    }
    await fs.rm(join(rootDir, UPDATE_STAGING_DIR), { recursive: true, force: true });
    await fs.rm(join(rootDir, STAGED_INFO_FILE), { force: true });
    await fs.rm(join(rootDir, UPDATE_TMP_DIR), { recursive: true, force: true });
    setState({
      status: 'idle',
      progress: 0,
      message: 'Staged update discarded',
      error: null,
      stagedVersion: null
    });
  } finally {
    await releaseLock(lock);
  }
}

// --------------------------------------------------------------- apply ----

/**
 * Apply the staged release.
 *
 * With a current launcher this only prepares: it snapshots the configuration,
 * writes the backup metadata and `.update-pending.json`, and the launcher
 * swaps the files on the restart that follows — no file of the running server
 * is moved while it runs. Under an older launcher the swap happens here.
 *
 * @param {Object} [options]
 * @param {boolean} [options.confirmDowngrade] - Required for a downgrade or the same version
 * @param {string} [options.confirmUnsigned] - The version number, typed, for an unsigned archive
 * @param {boolean} [options.skipConfigSnapshot] - Apply even if the configuration snapshot fails
 * @param {boolean} [options.inProcess] - Swap now instead of on the next start (the CLI, server stopped)
 * @returns {Promise<Object>}
 */
export async function applyUpdate({
  confirmDowngrade = false,
  confirmUnsigned,
  skipConfigSnapshot = false,
  inProcess = false
} = {}) {
  const rootDir = getRootDir();
  const stagingDir = join(rootDir, UPDATE_STAGING_DIR);

  if (!existsSync(stagingDir)) {
    throw new UpdateRequestError('No staged update found. Stage an update first.', { status: 409 });
  }
  const staged = readStagedInfo();
  if (!staged?.accepted) {
    throw new UpdateRequestError(
      'The staged files have no verification record. Discard them and stage the archive again.',
      { status: 409 }
    );
  }
  if (staged.requiresConfirmation?.downgrade && confirmDowngrade !== true) {
    throw new UpdateRequestError(
      `Version ${staged.version} is not newer than the running ${staged.currentVersion}; confirm the downgrade`,
      { status: 409, code: 'confirm-downgrade' }
    );
  }
  if (staged.requiresConfirmation?.unsigned) {
    if (!getUpdateSettings().allowUnsigned) {
      throw new UpdateRequestError('Unsigned archives are not allowed on this server', {
        status: 403,
        code: 'unsigned-not-allowed'
      });
    }
    if (String(confirmUnsigned || '').trim() !== String(staged.version)) {
      throw new UpdateRequestError(
        `The archive is not signed by a trusted key. Type the version (${staged.version}) to install it anyway`,
        { status: 409, code: 'confirm-unsigned' }
      );
    }
  }

  const lock = await acquireLock();
  setState({ status: 'applying', progress: 10, message: 'Preparing update...', error: null });

  const currentVersion = getAppVersion();
  const targetVersion = staged.version;
  const contentsDir = getContentsPath();
  const swapOnStart = !inProcess && getLauncherProtocol() >= swap.LAUNCHER_PROTOCOL;

  try {
    const backupDir = swap.prepareBackupDir(rootDir, { version: currentVersion, targetVersion });

    setState({ progress: 30, message: 'Saving a snapshot of the configuration...' });
    let configSnapshot = false;
    try {
      swap.writeConfigSnapshot(backupDir, contentsDir);
      configSnapshot = true;
    } catch (error) {
      if (!skipConfigSnapshot) {
        throw new UpdateRequestError(
          `The configuration snapshot could not be written (${error.message}). ` +
            'Free disk space, or apply without a snapshot.',
          { status: 507, code: 'config-snapshot-failed' }
        );
      }
      logger.warn('Applying update without a configuration snapshot', {
        component: 'UpdateService',
        error: error.message
      });
    }

    if (swapOnStart) {
      swap.writePending(rootDir, {
        action: 'update',
        targetVersion,
        previousVersion: currentVersion,
        backupDir,
        contentsDir
      });
    } else {
      setState({ progress: 50, message: 'Replacing application files...' });
      swap.swapInStaged(rootDir, { backupDir });
      swap.writeAttempt(rootDir, {
        targetVersion,
        previousVersion: currentVersion,
        backupDir,
        contentsDir,
        failedStarts: 0,
        appliedAt: new Date().toISOString()
      });
    }
    await fs.rm(join(rootDir, STAGED_INFO_FILE), { force: true });
    await fs.rm(join(rootDir, swap.RESULT_FILE), { force: true });

    setState({
      status: 'restarting',
      progress: 100,
      message: `Restarting to apply ${currentVersion} → ${targetVersion}...`,
      stagedVersion: null,
      backupVersion: currentVersion
    });
    logger.info('Update ready, restarting', {
      component: 'UpdateService',
      currentVersion,
      targetVersion,
      applyMode: swapOnStart ? 'swap-on-start' : 'in-process',
      configSnapshot
    });

    return {
      success: true,
      previousVersion: currentVersion,
      newVersion: targetVersion,
      applyMode: swapOnStart ? 'swap-on-start' : 'in-process',
      configSnapshot,
      restartCode: UPDATE_RESTART_CODE
    };
  } catch (error) {
    // swapInStaged undoes its own moves; nothing else has touched the installation.
    swap.clearPending(rootDir);
    logger.error('Applying the update failed', { component: 'UpdateService', error });
    setState({
      status: 'error',
      error: error.message,
      message: 'Update failed; nothing was changed'
    });
    throw error;
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Roll back to the version in the newest backup.
 *
 * @param {Object} [options]
 * @param {boolean} [options.restoreConfig] - Also restore the configuration
 *   snapshot taken before the update (configuration changes since are lost)
 * @param {boolean} [options.inProcess] - Restore now (the CLI, server stopped)
 */
export async function rollback({ restoreConfig = false, inProcess = false } = {}) {
  const rootDir = getRootDir();
  const backup = swap.listBackups(rootDir)[0];
  if (!backup) {
    throw new UpdateRequestError('No backup available for rollback', { status: 409 });
  }
  if (restoreConfig && !backup.hasConfigSnapshot) {
    throw new UpdateRequestError('This backup has no configuration snapshot', { status: 409 });
  }

  const lock = await acquireLock();
  setState({ status: 'applying', progress: 0, message: 'Rolling back...', error: null });
  const currentVersion = getAppVersion();
  const contentsDir = getContentsPath();
  const swapOnStart = !inProcess && getLauncherProtocol() >= swap.LAUNCHER_PROTOCOL;

  try {
    let restoredVersion = backup.version;
    if (swapOnStart) {
      swap.writePending(rootDir, {
        action: 'rollback',
        backupDir: backup.dir,
        targetVersion: backup.version,
        previousVersion: currentVersion,
        restoreConfig,
        contentsDir
      });
    } else {
      const result = swap.restoreBackup(rootDir, backup.dir, { contentsDir, restoreConfig });
      restoredVersion = result.restoredVersion;
      swap.writeResult(rootDir, {
        status: 'rolled-back',
        manual: true,
        targetVersion: restoredVersion,
        previousVersion: currentVersion,
        configRestored: result.configRestored
      });
    }

    setState({
      status: 'restarting',
      progress: 100,
      message: `Rolling back to ${restoredVersion}. Restarting...`,
      backupVersion: null
    });
    logger.info('Rollback ready, restarting', {
      component: 'UpdateService',
      restoredVersion,
      restoreConfig,
      applyMode: swapOnStart ? 'swap-on-start' : 'in-process'
    });
    return { success: true, restoredVersion, restoreConfig, restartCode: UPDATE_RESTART_CODE };
  } catch (error) {
    swap.clearPending(rootDir);
    setState({ status: 'error', error: error.message, message: 'Rollback failed' });
    throw error;
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Called once the server is answering requests: confirms an update the
 * launcher (or the in-process swap) just applied, so the launcher stops
 * counting failed starts, and records the outcome for the admin UI.
 */
export function confirmUpdateOnStartup() {
  try {
    if (!isBinaryInstallation()) return;
    const rootDir = getRootDir();
    const result = swap.confirmUpdateAttempt(rootDir, getAppVersion());
    if (result) {
      logger.info('Update confirmed after restart', {
        component: 'UpdateService',
        status: result.status,
        version: result.runningVersion,
        previousVersion: result.previousVersion
      });
    }
    // Leftovers of an interrupted acquisition.
    fs.rm(join(rootDir, UPDATE_TMP_DIR), { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    logger.warn('Could not confirm the update result', { component: 'UpdateService', error });
  }
}

// ----------------------------------------------------------- preflight ----

/**
 * Free disk space in the installation directory against what an update needs:
 * the archive, its extracted copy (about three times its size) and the
 * configuration snapshot. The code backup is made by renaming within the same
 * directory and costs nothing. Uses `fs.statfs` (no `df`, which Windows lacks).
 *
 * @param {{ archiveBytes?: number }} [options]
 */
export function checkDiskSpace({ archiveBytes = 200 * 1024 * 1024 } = {}) {
  const required = archiveBytes * 5 + 50 * 1024 * 1024;
  try {
    const stats = statfsSync(getRootDir());
    const available = Number(stats.bavail) * Number(stats.bsize);
    return { available, required, sufficient: available >= required };
  } catch {
    return { available: null, required, sufficient: true };
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

/** For the route's upload handling: an uploaded file's extension is acceptable. */
export function isAcceptedUploadName(name) {
  return (
    isAllowedArchiveName(name) || name === CHECKSUMS_FILE || extname(name) === SIGNATURE_SUFFIX
  );
}

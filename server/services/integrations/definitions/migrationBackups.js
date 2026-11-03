// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getContentsPath } from '../../../utils/contentsPath.js';
import { isValidId, resolveAndValidatePath } from '../../../utils/pathSecurity.js';
import { atomicWriteJSON } from '../../../utils/atomicWrite.js';
import { isStrictSemver } from '../../../validators/integrationDefinitionSchema.js';
import logger from '../../../utils/logger.js';

/**
 * The backups the definition migration runner takes of an installation
 * (versioning concept §3, step 1) and the commit markers of its staged
 * writes, under `contents/backups/integrations/`.
 *
 * One folder per backup, named `<instanceId>-<version>-<timestamp>`:
 *
 * ```
 * <instanceId>-<version>-<timestamp>/
 *   manifest.json   { representedVersion, instanceId, definitionId, createdAt, kind, createdBy, trigger, files }
 *   files/          the copies, at their paths below contents/:
 *     config/integrations.json
 *     config/installations.json          (marketplace definitions: the manifest of the marketplace)
 *     apps/<file>.json                    (every app that binds the installation)
 *     integration-definitions/<folder>/   (marketplace definitions, when the folder on disk is the version represented)
 *   staging/        the results of a commit before they move into place (removed when it finishes)
 *   commit.json     the commit marker { token, finished, … } (see the runner)
 * ```
 *
 * `representedVersion` is the definition version the copies were written
 * for. `kind` is `pre-migration` (taken before a run), `boundary` (the state
 * between two migrations of one run, kept so a later revert to that version
 * has something to restore: for a marketplace definition with the definition
 * folder of that version, fetched from the registry, and its manifest entry),
 * or `pre-restore` (taken before a restore or revert replaced the
 * installation). The manifest is written last: a folder without
 * one is an interrupted backup and is never offered.
 *
 * Paths are built from an instance id that passed the id grammar and a
 * version that passed strict semver, and every path is resolved with
 * `resolveAndValidatePath` under the backups root (or the backup's own
 * folder), so neither part can leave the directory.
 *
 * @module services/integrations/definitions/migrationBackups
 */

const COMPONENT = 'IntegrationMigrationBackups';
export const MANIFEST_FILE = 'manifest.json';
export const MARKER_FILE = 'commit.json';
const FILES_DIR = 'files';
const STAGING_DIR = 'staging';

/** The kinds of backup the runner takes. */
export const BACKUP_KINDS = Object.freeze(['pre-migration', 'boundary', 'pre-restore']);

/** Paths below `contents/` a backup may hold (anything else in a manifest is ignored). */
const ALLOWED_FILE_PATTERNS = [
  /^config\/integrations\.json$/,
  /^config\/installations\.json$/,
  /^apps\/[A-Za-z0-9._-]+\.json$/,
  /^integration-definitions\/[a-z0-9][a-z0-9._-]*$/
];

/** Whether a manifest path is one a backup may hold. */
export function isAllowedBackupPath(relPath) {
  return (
    typeof relPath === 'string' &&
    !relPath.includes('..') &&
    ALLOWED_FILE_PATTERNS.some(pattern => pattern.test(relPath))
  );
}

/** The backups root, `contents/backups/integrations`. */
export function backupsRoot() {
  return getContentsPath('backups', 'integrations');
}

async function ensureRoot() {
  const root = backupsRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}

/** `2026-11-02T10:15:00.123Z` → `20261102T101500123Z` (sortable, no separators). */
export function compactTimestamp(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

/**
 * Create a backup folder and copy the files into it.
 *
 * @param {object} input
 * @param {string} input.instanceId - installation id (id grammar)
 * @param {string} input.definitionId
 * @param {string} input.representedVersion - strict semver
 * @param {string} [input.kind='pre-migration'] - see {@link BACKUP_KINDS}
 * @param {string} [input.createdBy]
 * @param {string} [input.trigger]
 * @param {Date} [input.now]
 * @param {object} input.integrations - the `config/integrations.json` body to keep
 * @param {Array<{ path: string, data: object, bindingKeys: string[] }>} [input.apps]
 * @param {{ data: object, entryKey: string }|null} [input.installations] - the marketplace manifest and the entry of the definition
 * @param {{ folder: string, sourceDir?: string, files?: Record<string, string|object>, version: string }|null} [input.definition]
 *   - a marketplace definition folder to keep: copied from `sourceDir`, or
 *   written from a package's `files` (relative path → text or JSON)
 * @returns {Promise<{ id: string, dir: string, manifest: object }>}
 * @throws {Error} on an invalid id or version, or when the copy fails (the partial folder is removed)
 */
export async function createSnapshot({
  instanceId,
  definitionId,
  representedVersion,
  kind = 'pre-migration',
  createdBy = 'system',
  trigger,
  now = new Date(),
  integrations,
  apps = [],
  installations = null,
  definition = null
}) {
  if (!isValidId(instanceId))
    throw new Error(`Invalid installation id for a backup: ${instanceId}`);
  if (!isStrictSemver(representedVersion)) {
    throw new Error(`A backup needs a strict semantic version, got ${representedVersion}`);
  }
  if (!BACKUP_KINDS.includes(kind)) throw new Error(`Unknown backup kind ${kind}`);
  const root = await ensureRoot();
  const { id, dir } = await createBackupFolder(
    root,
    `${instanceId}-${representedVersion}-${compactTimestamp(now)}`,
    instanceId
  );
  try {
    const files = await copyIntoBackup(dir, { integrations, apps, installations, definition });
    const manifest = {
      representedVersion,
      instanceId,
      definitionId,
      createdAt: now.toISOString(),
      kind,
      createdBy,
      ...(trigger ? { trigger } : {}),
      files
    };
    await atomicWriteJSON(path.join(dir, MANIFEST_FILE), manifest);
    return { id, dir, manifest };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Create a new, empty backup folder below the backups root: `base`, or
 * `base-1`, `base-2`, … when a backup of the same millisecond took it.
 *
 * @param {string} root - the backups root
 * @param {string} base - `<instanceId>-<version>-<timestamp>`
 * @param {string} instanceId - for the error message
 * @returns {Promise<{ id: string, dir: string }>} the folder name and its absolute path
 * @throws {Error} when a name escapes the root, or no free name is left
 */
async function createBackupFolder(root, base, instanceId) {
  // Sequential on purpose: the names are tried in order and the first free one wins.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = attempt === 0 ? base : `${base}-${attempt}`;
    const candidate = await resolveAndValidatePath(id, root);
    if (!candidate || path.dirname(candidate) !== (await fs.realpath(root))) {
      throw new Error(`Backup folder escapes the backups directory: ${id}`);
    }
    try {
      await fs.mkdir(candidate);
      return { id, dir: candidate };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not create a backup folder for ${instanceId}`);
}

/**
 * Copy what a backup keeps into its `files/` folder and describe each copy
 * for the manifest: `integrations.json`, the app files, the marketplace
 * manifest and the definition folder (the last two only when given).
 *
 * @param {string} dir - the backup folder
 * @param {object} input - see {@link createSnapshot}
 * @returns {Promise<Array<object>>} the manifest's `files`
 */
async function copyIntoBackup(dir, { integrations, apps, installations, definition }) {
  const files = [];
  await writeBackupJson(dir, 'config/integrations.json', integrations);
  files.push({ path: 'config/integrations.json', type: 'integrations' });
  // Sequential on purpose: the first failed copy stops the backup (the caller removes it).
  for (const app of apps) {
    await writeBackupJson(dir, app.path, app.data);
    files.push({
      path: app.path,
      type: 'app',
      appId: app.data?.id || null,
      bindingKeys: [...(app.bindingKeys || [])]
    });
  }
  if (installations?.data) {
    await writeBackupJson(dir, 'config/installations.json', installations.data);
    files.push({
      path: 'config/installations.json',
      type: 'marketplace-manifest',
      entryKey: installations.entryKey
    });
  }
  if (definition?.sourceDir || definition?.files) {
    const relPath = `integration-definitions/${definition.folder}`;
    const target = await backupFilePath(dir, relPath);
    if (definition.sourceDir) {
      await fs.cp(definition.sourceDir, target, { recursive: true, errorOnExist: true });
    } else {
      await writePackageFiles(target, definition.files);
    }
    files.push({ path: relPath, type: 'definition', version: definition.version });
  }
  return files;
}

/**
 * Write a definition package (relative path → text or JSON) into a folder,
 * every path resolved inside it.
 *
 * @param {string} target - the folder (created)
 * @param {Record<string, string|object>} packageFiles
 */
async function writePackageFiles(target, packageFiles) {
  await fs.mkdir(target, { recursive: true });
  // Sequential on purpose: the first file that cannot be written stops the backup.
  for (const [relPath, content] of Object.entries(packageFiles || {})) {
    const file = await resolveAndValidatePath(relPath, target);
    if (!file || file === target) throw new Error(`Package path escapes its folder: ${relPath}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await fs.writeFile(file, text, 'utf8');
  }
}

/** The absolute path of a file inside a backup's `files/`, refused outside it. */
async function backupFilePath(dir, relPath) {
  if (!isAllowedBackupPath(relPath)) throw new Error(`Not a path a backup holds: ${relPath}`);
  const filesDir = path.join(dir, FILES_DIR);
  await fs.mkdir(filesDir, { recursive: true });
  const target = await resolveAndValidatePath(relPath, filesDir);
  if (!target) throw new Error(`Backup path escapes its folder: ${relPath}`);
  return target;
}

async function writeBackupJson(dir, relPath, data) {
  const target = await backupFilePath(dir, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJSON(target, data ?? null);
}

/**
 * Open one backup by its folder name. Null when the name is not a valid
 * id, the folder is not directly below the backups root, or it has no
 * readable manifest (an interrupted backup).
 *
 * @param {string} id - folder name
 * @returns {Promise<{ id: string, dir: string, manifest: object }|null>}
 */
export async function openSnapshot(id) {
  if (!isValidId(id)) return null;
  const root = backupsRoot();
  let realRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return null;
  }
  const dir = await resolveAndValidatePath(id, root);
  if (!dir || path.dirname(dir) !== realRoot) return null;
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !isStrictSemver(manifest.representedVersion) ||
    !isValidId(manifest.instanceId) ||
    !Array.isArray(manifest.files)
  ) {
    return null;
  }
  return { id, dir, manifest };
}

/**
 * Every complete backup, newest first; with `instanceId`, only that
 * installation's (by the manifest, not the folder prefix, since ids may
 * contain `-`).
 *
 * @param {{ instanceId?: string }} [filter]
 * @returns {Promise<Array<{ id: string, dir: string, manifest: object }>>}
 */
export async function listSnapshots({ instanceId } = {}) {
  let names;
  try {
    names = await fs.readdir(backupsRoot());
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Cannot read the integration backups', {
        component: COMPONENT,
        error: error.message
      });
    }
    return [];
  }
  const candidates = instanceId ? names.filter(name => name.startsWith(`${instanceId}-`)) : names;
  // Independent reads that never throw (an unreadable backup is null); sorted below.
  const opened = await Promise.all(candidates.map(name => openSnapshot(name)));
  const out = opened.filter(
    snapshot => snapshot && (!instanceId || snapshot.manifest.instanceId === instanceId)
  );
  return out.sort(
    (a, b) =>
      String(b.manifest.createdAt).localeCompare(String(a.manifest.createdAt)) ||
      b.id.localeCompare(a.id)
  );
}

/** The summary of a backup the admin API lists. */
export function snapshotView(snapshot) {
  const { manifest } = snapshot;
  return {
    id: snapshot.id,
    representedVersion: manifest.representedVersion,
    createdAt: manifest.createdAt,
    kind: manifest.kind || 'pre-migration',
    hasDefinition: manifest.files.some(file => file.type === 'definition'),
    createdBy: manifest.createdBy || null,
    trigger: manifest.trigger || null
  };
}

/** The manifest entry of a file type (`integrations`, `marketplace-manifest`, `definition`). */
export function snapshotFile(snapshot, type) {
  return snapshot.manifest.files.find(file => file.type === type && isAllowedBackupPath(file.path));
}

/** The app files of a backup, with the binding keys that were kept. */
export function snapshotApps(snapshot) {
  return snapshot.manifest.files.filter(
    file => file.type === 'app' && isAllowedBackupPath(file.path)
  );
}

/**
 * A JSON copy from a backup, or null when it is missing or unreadable.
 * @param {{ dir: string }} snapshot
 * @param {string} relPath - path below `contents/` as the manifest names it
 */
export async function readSnapshotJson(snapshot, relPath) {
  try {
    const target = await backupFilePath(snapshot.dir, relPath);
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

/** The absolute folder of the definition copy in a backup, or null. */
export async function snapshotDefinitionDir(snapshot) {
  const file = snapshotFile(snapshot, 'definition');
  if (!file) return null;
  try {
    const target = await backupFilePath(snapshot.dir, file.path);
    const stat = await fs.stat(target);
    return stat.isDirectory() ? target : null;
  } catch {
    return null;
  }
}

// --- Staging and commit markers --------------------------------------------

/**
 * Write a result into the backup's staging folder before it moves into place.
 * @returns {Promise<string>} the absolute staged path
 */
export async function stageJson(snapshot, relPath, data) {
  if (!isAllowedBackupPath(relPath)) throw new Error(`Not a path a commit writes: ${relPath}`);
  const stagingDir = path.join(snapshot.dir, STAGING_DIR);
  await fs.mkdir(stagingDir, { recursive: true });
  const target = await resolveAndValidatePath(relPath, stagingDir);
  if (!target) throw new Error(`Staging path escapes its folder: ${relPath}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJSON(target, data);
  return target;
}

/** Read a staged result back (the commit moves exactly what was staged). */
export async function readStagedJson(snapshot, relPath) {
  const stagingDir = path.join(snapshot.dir, STAGING_DIR);
  const target = await resolveAndValidatePath(relPath, stagingDir);
  if (!target) throw new Error(`Staging path escapes its folder: ${relPath}`);
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

/** Remove the staging folder of a backup (after a commit, or when it is refused). */
export async function removeStaging(snapshot) {
  await fs.rm(path.join(snapshot.dir, STAGING_DIR), { recursive: true, force: true });
}

/** Write (or replace) the commit marker of a backup. */
export async function writeMarker(snapshot, marker) {
  await atomicWriteJSON(path.join(snapshot.dir, MARKER_FILE), marker);
}

/** The commit marker of a backup, or null. */
export async function readMarker(snapshot) {
  try {
    return JSON.parse(await fs.readFile(path.join(snapshot.dir, MARKER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Remove a marker (a commit refused before anything moved). */
export async function removeMarker(snapshot) {
  await fs.rm(path.join(snapshot.dir, MARKER_FILE), { force: true });
}

/**
 * The backups with a commit marker that never got its finished flag: a
 * commit interrupted between its writes. With `instanceId`, only that
 * installation's.
 *
 * @param {{ instanceId?: string }} [filter]
 * @returns {Promise<Array<{ snapshot: object, marker: object }>>}
 */
export async function listUnfinishedCommits({ instanceId } = {}) {
  const snapshots = await listSnapshots({ instanceId });
  // Independent reads that never throw (no marker is null); the order stays newest first.
  const markers = await Promise.all(snapshots.map(snapshot => readMarker(snapshot)));
  return snapshots
    .map((snapshot, i) => ({ snapshot, marker: markers[i] }))
    .filter(({ marker }) => marker && marker.finished !== true);
}

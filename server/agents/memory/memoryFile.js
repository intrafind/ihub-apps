/**
 * Memory File
 *
 * Per-profile long-term memory stored as plain markdown with optional YAML
 * frontmatter at `contents/agents/memory/<profileId>.md`.
 *
 * The body is organised into three canonical `## ` sections (Semantic /
 * Episodic / Procedural) with per-entry source markers — see
 * `memorySections.js`. Agent writes go through `applyMemoryDelta`, which merges
 * structured deltas into those sections while keeping human-authored entries
 * immutable. The lower-level `writeMemory` (flat append/replace of the whole
 * body) is still used for admin full-file edits and the "build from tool" flow.
 *
 * Every write first snapshots the prior version to
 * `contents/agents/memory/.snapshots/<profileId>/v<N>.md` (newest 10 retained)
 * so operators have cheap rollback without relying on git.
 *
 * Writers use optimistic concurrency: each write must specify the expected
 * version (if `expectedVersion` is omitted, last-write-wins).
 */

import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteFile } from '../../utils/atomicWrite.js';
import { resolveAndValidatePath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import { AGENT_PROFILE_ID_PATTERN } from '../../validators/agentProfileSchema.js';
import { normalizeDelta, applyDeltaToBody, stripSourceMarkers } from './memorySections.js';

const MEMORY_DIR = 'agents/memory';
const SNAPSHOT_DIR = '.snapshots';
const MAX_SNAPSHOTS = 10;

function memoryBaseDir() {
  return path.join(getRootDir(), 'contents', MEMORY_DIR);
}

// Validate the profile id with a strict regex, run it through `path.basename`
// (a CodeQL-recognized path-injection sanitizer), AND canonicalize against the
// memory base dir. Returns a safe absolute path or throws.
async function memoryPath(profileId) {
  if (typeof profileId !== 'string' || !AGENT_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(`Invalid profile id: ${profileId}`);
  }
  const safeFilename = path.basename(`${profileId}.md`);
  const baseDir = memoryBaseDir();
  const safe = await resolveAndValidatePath(safeFilename, baseDir);
  if (!safe) {
    throw new Error(`Invalid memory path for profile: ${profileId}`);
  }
  return safe;
}

// Snapshot directory for a profile. profileId is validated against the strict
// pattern (no path separators possible) before being used as a subdirectory.
function snapshotDirFor(profileId) {
  if (typeof profileId !== 'string' || !AGENT_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(`Invalid profile id: ${profileId}`);
  }
  return path.join(memoryBaseDir(), SNAPSHOT_DIR, path.basename(profileId));
}

async function snapshotPath(profileId, version) {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Invalid snapshot version: ${version}`);
  }
  const dir = snapshotDirFor(profileId);
  await fs.mkdir(dir, { recursive: true });
  const safe = await resolveAndValidatePath(`v${version}.md`, dir);
  if (!safe) {
    throw new Error(`Invalid snapshot path for profile: ${profileId} v${version}`);
  }
  return safe;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const fm = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) {
      let val = m[2].trim();
      if (/^\d+$/.test(val)) val = parseInt(val, 10);
      fm[m[1]] = val;
    }
  }
  return { frontmatter: fm, body: match[2] };
}

function buildFrontmatter(fm) {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export async function readMemory(profileId) {
  // memoryPath validates `profileId` against AGENT_PROFILE_ID_PATTERN and
  // canonicalizes the result against the memory base dir, preventing path
  // traversal even if the caller supplied untrusted input.
  await fs.mkdir(memoryBaseDir(), { recursive: true });
  const file = await memoryPath(profileId);
  try {
    // lgtm[js/path-injection] -- profileId validated by AGENT_PROFILE_ID_PATTERN; path canonicalized by resolveAndValidatePath.
    const raw = await fs.readFile(file, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      profileId,
      raw,
      frontmatter,
      body,
      version: frontmatter.version || 0,
      updatedAt: frontmatter.updatedAt || null,
      updatedBy: frontmatter.updatedBy || null
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        profileId,
        raw: '',
        frontmatter: { profileId, version: 0 },
        body: '',
        version: 0,
        updatedAt: null,
        updatedBy: null
      };
    }
    throw err;
  }
}

/**
 * Snapshot the current on-disk file (raw, with frontmatter) into the snapshot
 * directory keyed by its version, then prune to the newest MAX_SNAPSHOTS.
 * No-op when there is nothing to snapshot (version 0 / empty file).
 */
async function snapshotCurrent(profileId, current) {
  if (!current || current.version <= 0 || !current.raw) return;
  try {
    const file = await snapshotPath(profileId, current.version);
    await atomicWriteFile(file, current.raw);
    await pruneSnapshots(profileId);
  } catch (err) {
    // A snapshot failure must never block the actual memory write — log and
    // continue. Rollback is a convenience, not a correctness guarantee.
    logger.warn('Memory snapshot failed', {
      component: 'MemoryFile',
      profileId,
      version: current.version,
      error: err.message
    });
  }
}

async function listSnapshotVersions(profileId) {
  const dir = snapshotDirFor(profileId);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  return files
    .map(f => {
      const m = f.match(/^v(\d+)\.md$/);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(v => v != null)
    .sort((a, b) => b - a);
}

async function pruneSnapshots(profileId) {
  const versions = await listSnapshotVersions(profileId);
  const dir = snapshotDirFor(profileId);
  for (const v of versions.slice(MAX_SNAPSHOTS)) {
    await fs.rm(path.join(dir, `v${v}.md`)).catch(() => {});
  }
}

/**
 * Shared write path: snapshot the prior file, bump the version, write atomically.
 * `current` must be the result of a fresh `readMemory` so the snapshot captures
 * the exact bytes being replaced.
 */
async function persistBody(profileId, current, nextBody, { summary, updatedBy }) {
  await snapshotCurrent(profileId, current);

  const nextVersion = current.version + 1;
  const frontmatter = buildFrontmatter({
    profileId,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || 'system',
    version: nextVersion,
    ...(summary ? { summary } : {})
  });

  await fs.mkdir(memoryBaseDir(), { recursive: true });
  const file = await memoryPath(profileId);
  // lgtm[js/path-injection] -- profileId validated by AGENT_PROFILE_ID_PATTERN; path canonicalized by resolveAndValidatePath.
  await atomicWriteFile(file, `${frontmatter}${nextBody}`);
  return { version: nextVersion, body: nextBody };
}

export async function writeMemory(
  profileId,
  { mode = 'replace', content = '', summary, expectedVersion, updatedBy }
) {
  const current = await readMemory(profileId);
  if (typeof expectedVersion === 'number' && expectedVersion !== current.version) {
    const conflictErr = new Error(
      `Memory version mismatch: expected ${expectedVersion}, found ${current.version}`
    );
    conflictErr.code = 'VERSION_CONFLICT';
    conflictErr.currentVersion = current.version;
    throw conflictErr;
  }

  let nextBody;
  if (mode === 'append') {
    nextBody = current.body ? `${current.body.replace(/\n*$/, '\n')}${content}\n` : `${content}\n`;
  } else if (mode === 'replace') {
    nextBody = content.endsWith('\n') ? content : `${content}\n`;
  } else {
    throw new Error(`Unsupported writeMemory mode: ${mode}`);
  }

  const result = await persistBody(profileId, current, nextBody, { summary, updatedBy });
  logger.info('Memory written', {
    component: 'MemoryFile',
    profileId,
    version: result.version,
    mode,
    updatedBy
  });
  return result;
}

/**
 * Apply a structured memory delta from the memory composer. Merges the delta
 * into the three canonical sections, keeping human-authored entries immutable.
 *
 * @param {string} profileId
 * @param {object} delta `{ mode, sections|content, summary }`
 * @param {object} [opts]
 * @param {number} [opts.expectedVersion] optimistic-concurrency guard
 * @param {string} [opts.updatedBy]
 * @returns {Promise<{ version:number, body:string, skipped?:boolean, sections?:string[] }>}
 */
export async function applyMemoryDelta(profileId, delta, { expectedVersion, updatedBy } = {}) {
  const current = await readMemory(profileId);
  if (typeof expectedVersion === 'number' && expectedVersion !== current.version) {
    const conflictErr = new Error(
      `Memory version mismatch: expected ${expectedVersion}, found ${current.version}`
    );
    conflictErr.code = 'VERSION_CONFLICT';
    conflictErr.currentVersion = current.version;
    throw conflictErr;
  }

  const normalized = normalizeDelta(delta);
  const touchedSections = Object.keys(normalized.sections);
  if (touchedSections.length === 0) {
    return { version: current.version, body: current.body, skipped: true };
  }

  const nextBody = applyDeltaToBody(current.body, normalized);
  const summary = typeof delta?.summary === 'string' ? delta.summary : undefined;
  const result = await persistBody(profileId, current, nextBody, {
    summary,
    updatedBy: updatedBy || 'memory-finalize'
  });
  logger.info('Memory delta applied', {
    component: 'MemoryFile',
    profileId,
    version: result.version,
    mode: normalized.mode,
    sections: touchedSections,
    updatedBy
  });
  return { ...result, sections: touchedSections };
}

/**
 * List retained snapshots for a profile, newest first.
 * @returns {Promise<Array<{ version:number, updatedAt:?string, updatedBy:?string, bytes:number }>>}
 */
export async function listSnapshots(profileId) {
  const versions = await listSnapshotVersions(profileId);
  const dir = snapshotDirFor(profileId);
  const out = [];
  for (const version of versions) {
    try {
      const raw = await fs.readFile(path.join(dir, `v${version}.md`), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      out.push({
        version,
        updatedAt: frontmatter.updatedAt || null,
        updatedBy: frontmatter.updatedBy || null,
        bytes: Buffer.byteLength(raw, 'utf8')
      });
    } catch {
      // Skip unreadable snapshot — don't fail the whole listing.
    }
  }
  return out;
}

/**
 * Read a single snapshot's body + metadata.
 */
export async function readSnapshot(profileId, version) {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Invalid snapshot version: ${version}`);
  }
  const file = await snapshotPath(profileId, version);
  const raw = await fs.readFile(file, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return {
    profileId,
    version,
    raw,
    body,
    updatedAt: frontmatter.updatedAt || null,
    updatedBy: frontmatter.updatedBy || null
  };
}

/**
 * Restore a snapshot as the new current memory. The current file is itself
 * snapshotted first (via the normal write path) so the restore is reversible.
 */
export async function restoreSnapshot(profileId, version, { updatedBy, expectedVersion } = {}) {
  const snapshot = await readSnapshot(profileId, version);
  return writeMemory(profileId, {
    mode: 'replace',
    content: snapshot.body,
    summary: `restored from v${version}`,
    expectedVersion,
    updatedBy: updatedBy || 'restore'
  });
}

/**
 * Return memory body truncated to maxBytes. Source markers are stripped so the
 * agent prompt isn't polluted with `<!-- src:* -->` comments. Returns null when
 * memory is empty.
 */
export async function readMemoryBodyForPrompt(profileId, maxBytes = 8192) {
  const mem = await readMemory(profileId);
  if (!mem.body || mem.body.trim().length === 0) return null;
  const clean = stripSourceMarkers(mem.body).replace(/\n{3,}/g, '\n\n');
  if (clean.length <= maxBytes) {
    return { body: clean, truncated: false, version: mem.version, updatedAt: mem.updatedAt };
  }
  return {
    body: `${clean.slice(0, maxBytes)}\n\n[memory truncated — use readMemory tool to fetch full body]`,
    truncated: true,
    version: mem.version,
    updatedAt: mem.updatedAt
  };
}

export default {
  readMemory,
  writeMemory,
  applyMemoryDelta,
  listSnapshots,
  readSnapshot,
  restoreSnapshot,
  readMemoryBodyForPrompt
};

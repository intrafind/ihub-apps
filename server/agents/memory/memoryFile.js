/**
 * Memory File
 *
 * Per-profile long-term memory stored as plain markdown with optional YAML
 * frontmatter at `contents/agents/memory/<profileId>.md`. V1 is single-section
 * (no Semantic/Episodic/Procedural split) — that's a V1.5 evolution.
 *
 * Writers use optimistic concurrency: each write must specify the expected
 * version (if `expectedVersion` is omitted, last-write-wins).
 */

import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteFile } from '../../utils/atomicWrite.js';
import logger from '../../utils/logger.js';
import { AGENT_PROFILE_ID_PATTERN } from '../../validators/agentProfileSchema.js';

const MEMORY_DIR = 'agents/memory';

function memoryPath(profileId) {
  if (!AGENT_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(`Invalid profile id: ${profileId}`);
  }
  return path.join(getRootDir(), 'contents', MEMORY_DIR, `${profileId}.md`);
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
  const file = memoryPath(profileId);
  try {
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

  const nextVersion = current.version + 1;
  const frontmatter = buildFrontmatter({
    profileId,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || 'system',
    version: nextVersion,
    ...(summary ? { summary } : {})
  });

  const file = memoryPath(profileId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, `${frontmatter}${nextBody}`);
  logger.info('Memory written', {
    component: 'MemoryFile',
    profileId,
    version: nextVersion,
    mode,
    updatedBy
  });
  return { version: nextVersion, body: nextBody };
}

/**
 * Return memory body truncated to maxBytes. Returns null when memory is empty.
 */
export async function readMemoryBodyForPrompt(profileId, maxBytes = 8192) {
  const mem = await readMemory(profileId);
  if (!mem.body || mem.body.trim().length === 0) return null;
  if (mem.body.length <= maxBytes) {
    return { body: mem.body, truncated: false, version: mem.version, updatedAt: mem.updatedAt };
  }
  return {
    body: `${mem.body.slice(0, maxBytes)}\n\n[memory truncated — use readMemory tool to fetch full body]`,
    truncated: true,
    version: mem.version,
    updatedAt: mem.updatedAt
  };
}

export default { readMemory, writeMemory, readMemoryBodyForPrompt };

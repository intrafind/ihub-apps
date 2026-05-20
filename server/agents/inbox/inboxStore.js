/**
 * Inbox Store
 *
 * Reads and writes per-inbox markdown files under contents/data/agent-inboxes/.
 *
 * Inbox format:
 *
 *   ---
 *   inboxId: engineering-todos
 *   updatedAt: 2026-05-19T08:00:00Z
 *   updatedBy: user:alice
 *   version: 7
 *   ---
 *   # Engineering TODOs
 *   - [ ] (P1) Review the staging deploy logs
 *   - [x] (P2) Triage Sentry  -- done by agent:todo-worker 2026-05-19T07:45Z
 */

import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteFile } from '../../utils/atomicWrite.js';
import { resolveAndValidatePath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import { INBOX_ID_PATTERN } from '../../validators/agentInboxSchema.js';

const INBOX_DIR = 'data/agent-inboxes';

function inboxBaseDir() {
  return path.join(getRootDir(), 'contents', INBOX_DIR);
}

// Validate inboxId with a strict regex AND canonicalize against the inbox
// base dir before returning the file path. Throws on traversal/invalid id.
async function inboxPath(inboxId) {
  if (typeof inboxId !== 'string' || !INBOX_ID_PATTERN.test(inboxId)) {
    throw new Error(`Invalid inbox id: ${inboxId}`);
  }
  const safe = await resolveAndValidatePath(`${inboxId}.md`, inboxBaseDir());
  if (!safe) {
    throw new Error(`Invalid inbox path for: ${inboxId}`);
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

function parseChecklistLine(line) {
  // Match: - [ ] or - [x] with optional priority (P1) and text
  const m = line.match(/^[-*]\s+\[( |x|X)\]\s+(?:\(([Pp][123])\)\s+)?(.+?)(?:\s+--\s+(.*))?$/);
  if (!m) return null;
  const status = m[1].toLowerCase() === 'x' ? 'done' : 'open';
  const priority = m[2] ? m[2].toLowerCase() : 'unprioritized';
  const text = m[3].trim();
  const note = m[4] ? m[4].trim() : undefined;
  return { status, priority, text, note };
}

export async function listInboxes() {
  const dir = path.join(getRootDir(), 'contents', INBOX_DIR);
  try {
    const entries = await fs.readdir(dir);
    const inboxes = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const id = entry.slice(0, -3);
      if (!INBOX_ID_PATTERN.test(id)) continue;
      try {
        const inbox = await readInboxRaw(id);
        const items = parseItems(inbox.body);
        inboxes.push({
          inboxId: id,
          version: inbox.frontmatter.version || 0,
          updatedAt: inbox.frontmatter.updatedAt || null,
          updatedBy: inbox.frontmatter.updatedBy || null,
          openCount: items.filter(i => i.status === 'open').length,
          totalCount: items.length
        });
      } catch (err) {
        logger.warn('Failed to load inbox metadata', {
          component: 'InboxStore',
          id,
          error: err.message
        });
      }
    }
    return inboxes;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function readInboxRaw(inboxId) {
  // inboxPath validates the id against INBOX_ID_PATTERN and canonicalizes the
  // result against the inbox base dir, blocking path traversal.
  await fs.mkdir(inboxBaseDir(), { recursive: true });
  const file = await inboxPath(inboxId);
  // lgtm[js/path-injection] -- inboxId validated by INBOX_ID_PATTERN; path canonicalized by resolveAndValidatePath.
  const raw = await fs.readFile(file, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return { inboxId, raw, frontmatter, body };
}

export function parseItems(body) {
  const items = [];
  const lines = body.split('\n');
  lines.forEach((line, idx) => {
    const parsed = parseChecklistLine(line);
    if (parsed) {
      items.push({
        line: idx,
        raw: line,
        ...parsed
      });
    }
  });
  return items;
}

export async function readInbox(inboxId, { status = 'all' } = {}) {
  const inbox = await readInboxRaw(inboxId);
  let items = parseItems(inbox.body);
  if (status === 'open') items = items.filter(i => i.status === 'open');
  else if (status === 'done') items = items.filter(i => i.status === 'done');
  return {
    inboxId,
    version: inbox.frontmatter.version || 0,
    updatedAt: inbox.frontmatter.updatedAt || null,
    updatedBy: inbox.frontmatter.updatedBy || null,
    items,
    body: inbox.body
  };
}

export async function writeInbox(inboxId, { body, expectedVersion, updatedBy }) {
  // inboxPath re-validates the id before constructing the absolute path.
  await fs.mkdir(inboxBaseDir(), { recursive: true });
  const file = await inboxPath(inboxId);
  let current = { frontmatter: { version: 0 }, body: '' };
  try {
    current = await readInboxRaw(inboxId);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const currentVersion = current.frontmatter.version || 0;
  if (typeof expectedVersion === 'number' && expectedVersion !== currentVersion) {
    const conflictErr = new Error(
      `Inbox version mismatch: expected ${expectedVersion}, found ${currentVersion}`
    );
    conflictErr.code = 'VERSION_CONFLICT';
    conflictErr.currentVersion = currentVersion;
    throw conflictErr;
  }
  const nextVersion = currentVersion + 1;
  const frontmatter = buildFrontmatter({
    inboxId,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || 'system',
    version: nextVersion
  });
  const content = `${frontmatter}${body}`;
  // lgtm[js/path-injection] -- inboxId validated by INBOX_ID_PATTERN; path canonicalized by resolveAndValidatePath.
  await atomicWriteFile(file, content);
  logger.info('Inbox written', {
    component: 'InboxStore',
    inboxId,
    version: nextVersion,
    updatedBy
  });
  return { version: nextVersion };
}

/**
 * Append a new checklist item to the inbox.
 */
export async function addInboxItem(inboxId, { text, priority, updatedBy, expectedVersion }) {
  const current = await readInboxRaw(inboxId).catch(err => {
    if (err.code === 'ENOENT') return { body: `# ${inboxId}\n` };
    throw err;
  });
  const prio = priority ? `(${priority.toUpperCase()}) ` : '';
  const newLine = `- [ ] ${prio}${text}`;
  const body = current.body.endsWith('\n')
    ? `${current.body}${newLine}\n`
    : `${current.body}\n${newLine}\n`;
  return writeInbox(inboxId, { body, expectedVersion, updatedBy });
}

/**
 * Mark an item done in the inbox by matching its text.
 */
export async function markInboxItemDone(inboxId, { text, note, updatedBy, expectedVersion }) {
  const current = await readInboxRaw(inboxId);
  const lines = current.body.split('\n');
  let matched = false;
  const updated = lines.map(line => {
    if (matched) return line;
    const parsed = parseChecklistLine(line);
    if (!parsed || parsed.status === 'done') return line;
    if (!parsed.text.includes(text.trim())) return line;
    matched = true;
    const noteSuffix = note
      ? `  -- ${note}`
      : `  -- done by ${updatedBy || 'agent'} ${new Date().toISOString()}`;
    return line.replace(/\[\s\]/, '[x]').replace(/$/, noteSuffix);
  });
  if (!matched) {
    const err = new Error(`No matching open item containing: ${text}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  return writeInbox(inboxId, {
    body: updated.join('\n'),
    expectedVersion,
    updatedBy
  });
}

export default {
  listInboxes,
  readInbox,
  writeInbox,
  addInboxItem,
  markInboxItemDone,
  parseItems
};

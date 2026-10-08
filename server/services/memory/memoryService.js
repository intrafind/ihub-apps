/**
 * Memory service — long-term notes that belong to a scope.
 *
 * Agent memory and scheduled-task memory are the same function: a markdown
 * body with a version, an author and a last-update time, read into the prompt
 * and written with `append` / `replace` and an optional `expectedVersion`. What
 * differs is only whose notes they are, so the service works on a **scope**
 * and each kind of scope brings its own store:
 *
 *   { kind: 'agent', profileId }                 → contents/agents/memory/<profileId>.md
 *   { kind: 'scheduled-task', taskId, ownerId }  → the scheduled-task memory namespace
 *
 * The scope is resolved from the trusted principal only (`user.profileId` for
 * an agent, `user.scheduledRun.taskId` for a scheduled run). It is never read
 * from a tool argument, so a run can only reach its own notes.
 *
 * @module services/memory/memoryService
 */
import memoryFile from '../../agents/memory/memoryFile.js';

/** Scope kinds. */
export const MEMORY_SCOPE_AGENT = 'agent';

/**
 * @typedef {Object} MemoryDocument
 * @property {string} body - Markdown notes.
 * @property {number} version - 0 when nothing was ever written.
 * @property {string|null} updatedAt
 * @property {string|null} updatedBy
 * @property {string|null} summary
 * @property {number} chars - `body.length`.
 */

/**
 * @typedef {Object} MemoryScopeHandler
 * @property {string} kind
 * @property {(user: Object|null) => Promise<Object|null>|Object|null} resolve
 *   The scope this principal may use, or null.
 * @property {(scope: Object) => Promise<MemoryDocument>} read
 * @property {(scope: Object, options: Object) => Promise<{version: number, body: string, chars: number}>} write
 * @property {(scope: Object, maxChars: number) => Promise<Object|null>} readForPrompt
 */

/** @type {MemoryScopeHandler} */
const agentHandler = {
  kind: MEMORY_SCOPE_AGENT,

  resolve(user) {
    if (user?.isAgent === true && user.profileId) {
      return { kind: MEMORY_SCOPE_AGENT, profileId: user.profileId };
    }
    return null;
  },

  async read(scope) {
    const mem = await memoryFile.readMemory(scope.profileId);
    return {
      body: mem.body,
      version: mem.version,
      updatedAt: mem.updatedAt,
      updatedBy: mem.updatedBy,
      summary: mem.frontmatter?.summary ?? null,
      chars: mem.body.length
    };
  },

  // Agent memory has no size cap on write; `maxChars` is a task-memory setting.
  async write(scope, { mode, content, summary, expectedVersion, updatedBy }) {
    const result = await memoryFile.writeMemory(scope.profileId, {
      mode,
      content,
      summary,
      expectedVersion,
      updatedBy
    });
    return { version: result.version, body: result.body, chars: result.body.length };
  },

  readForPrompt(scope, maxChars) {
    return memoryFile.readMemoryBodyForPrompt(scope.profileId, maxChars);
  }
};

/** @type {Map<string, MemoryScopeHandler>} */
const handlers = new Map([[agentHandler.kind, agentHandler]]);

/**
 * Add a kind of scope. Called once per kind, at import time.
 *
 * @param {MemoryScopeHandler} handler
 */
export function registerMemoryScopeHandler(handler) {
  if (!handler?.kind || typeof handler.resolve !== 'function') {
    throw new Error('A memory scope handler needs a kind and a resolve function');
  }
  handlers.set(handler.kind, handler);
}

function handlerFor(scope) {
  const handler = scope && handlers.get(scope.kind);
  if (!handler) throw new Error(`No memory store for scope ${scope?.kind ?? '(none)'}`);
  return handler;
}

/**
 * The memory scope a principal may use, from the principal alone.
 *
 * @param {Object|null} user - The trusted principal of the turn.
 * @returns {Promise<Object|null>} Null when this principal has no memory here.
 */
export async function resolveMemoryScope(user) {
  if (!user) return null;
  for (const handler of handlers.values()) {
    const scope = await handler.resolve(user);
    if (scope) return scope;
  }
  return null;
}

/**
 * Read a scope's notes.
 *
 * @param {Object} scope
 * @returns {Promise<MemoryDocument>}
 */
export async function readMemory(scope) {
  return handlerFor(scope).read(scope);
}

/**
 * Write a scope's notes.
 *
 * Rejects with `code: 'VERSION_CONFLICT'` (and `currentVersion`) when
 * `expectedVersion` is a number that is not the stored version.
 *
 * @param {Object} scope
 * @param {Object} options
 * @param {'append'|'replace'} [options.mode='replace']
 * @param {string} options.content
 * @param {string} [options.summary]
 * @param {number} [options.expectedVersion]
 * @param {string} [options.updatedBy]
 * @param {number} [options.maxChars] - Size cap, for scopes that have one.
 * @returns {Promise<{version: number, body: string, chars: number}>}
 */
export async function writeMemory(scope, options = {}) {
  return handlerFor(scope).write(scope, options);
}

/**
 * The notes as they go into a prompt, capped at `maxChars` characters.
 *
 * @param {Object} scope
 * @param {number} [maxChars]
 * @returns {Promise<{body: string, truncated: boolean, version: number, updatedAt: string|null}|null>}
 *   Null when there are no notes.
 */
export async function readMemoryForPrompt(scope, maxChars) {
  return handlerFor(scope).readForPrompt(scope, maxChars);
}

export default {
  resolveMemoryScope,
  readMemory,
  writeMemory,
  readMemoryForPrompt,
  registerMemoryScopeHandler
};

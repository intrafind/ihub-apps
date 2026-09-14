/**
 * The raw configuration namespaces — which storage namespace is a view over
 * which directory of an installation's `contents/`.
 *
 * Configuration is not like the rest of the data a storage provider holds. It
 * is hand-edited, git-tracked, docker-mounted, seeded from `server/defaults/`
 * and read and written by checksum-frozen migrations, so it cannot be moved
 * under `contents/data/` and cannot be wrapped in the document envelope
 * `FilesystemDocumentStore` writes. A namespace listed here is therefore
 * declared **raw**: the JSON file at `<contents>/<dir>/<key>.json` *is* the
 * document body, byte for byte what `atomicWriteJSON` produces today, and an
 * installation's `contents/` is byte-identical before and after a release that
 * routes config through the provider. See `RawDocumentStore` for the semantics
 * that follow from that and `docs/storage.md` for the wider picture.
 *
 * This module is the single place the mapping is written down. Anything that
 * needs to know whether a namespace is raw, where it lives, or how a
 * contents-relative path relates to an `(ns, key)` pair asks here rather than
 * rebuilding the map — a second copy is how the map and the filesystem drift
 * apart.
 *
 * Only directories that hold **JSON documents one level deep** are listed.
 * `contents/pages/<lang>/<id>.md`, `contents/sources/*.md`,
 * `contents/renderers/*.jsx` and `contents/skills/**` are text or nested and
 * are not raw namespaces; they are served by their own callers.
 *
 * @module storage/namespaces
 */
import { isValidId } from '../utils/pathSecurity.js';
import { InvalidKeyError, StorageError } from './errors.js';

/** Extension every raw document file carries. */
export const RAW_DOC_EXT = '.json';

/**
 * Directory holding the raw store's lock files, relative to the provider's
 * base directory (`contents/data` by default).
 *
 * Locks live **outside** the namespace directories on purpose: `resourceLoader`
 * loads every `*.json` under `contents/apps` as an app, so a `.locks` sidecar
 * next to a config file would eventually be loaded as one. Keeping the lock
 * tree in the provider's own data directory is what makes "the contents tree
 * is unchanged" true rather than nearly true.
 */
export const CONFIG_LOCK_DIR = '.config-locks';

/**
 * A raw namespace declaration.
 *
 * @typedef {Object} RawNamespace
 * @property {string} dir - Directory under `contents/`, `/`-separated. May be
 *   more than one segment (`agents/profiles`).
 * @property {boolean} raw - Always true here; the flag is explicit so a future
 *   enveloped namespace can be declared in the same map without the reader
 *   having to know which map it is looking at.
 */

/**
 * Namespace → directory under `contents/`.
 *
 * @type {Readonly<Object<string, RawNamespace>>}
 */
export const CONFIG_NAMESPACES = Object.freeze({
  /** `contents/config/*.json` — platform, ui, groups, features, providers, … */
  config: Object.freeze({ dir: 'config', raw: true }),
  /** `contents/apps/*.json` — one file per AI app. */
  apps: Object.freeze({ dir: 'apps', raw: true }),
  /** `contents/models/*.json` — one file per LLM model. */
  models: Object.freeze({ dir: 'models', raw: true }),
  /** `contents/prompts/*.json` — one file per prompt. */
  prompts: Object.freeze({ dir: 'prompts', raw: true }),
  /** `contents/tools/*.json` — one file per tool definition. */
  tools: Object.freeze({ dir: 'tools', raw: true }),
  /** `contents/workflows/*.json` — one file per workflow. */
  workflows: Object.freeze({ dir: 'workflows', raw: true }),
  /** `contents/agents/profiles/*.json` — agent profiles; `agents/memory` is runtime state. */
  agents: Object.freeze({ dir: 'agents/profiles', raw: true }),
  /** `contents/locales/<lang>.json` — translation overrides layered over the builtin locales. */
  locales: Object.freeze({ dir: 'locales', raw: true })
});

/**
 * Every namespace that holds runtime state rather than configuration.
 *
 * Declared here, next to the raw ones, because the distinction is a routing
 * decision and routing is decided in this file. A raw namespace *is* an
 * installation's `contents/<dir>/` tree — git-tracked, hand-edited, backed up —
 * and a runtime namespace is the provider's own storage. Nothing stopped a
 * later feature from picking a name that is already raw: `documents.put` would
 * have routed it to `RawDocumentStore` and written runtime state into
 * `contents/tools/`, where `resourceLoader` would then load it as a tool.
 *
 * It also gives `runtime-imports` one definition. It had three, in three
 * modules that share the marker, which is one spelling mistake away from two
 * importers each believing it has already run.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const RUNTIME_NAMESPACES = Object.freeze({
  /** Chat documents. */
  chats: 'chats',
  /** Chat transcripts, one document per chat. */
  chatMessages: 'chat-messages',
  /** Per-run summaries for the history and retention views. */
  runs: 'runs',
  /** Pending and recently settled human interactions. */
  interactions: 'interactions',
  /** Workflow execution state and checkpoints. */
  workflowState: 'workflow-state',
  /** Conversation state for the integration adapters. */
  integrationConversations: 'integration-conversations',
  /** One-time import markers, shared by every runtime store that has one. */
  runtimeImports: 'runtime-imports'
});

/**
 * Namespace names in ascending order — what a provider reports as
 * `getCapabilities().rawNamespaces`.
 *
 * @type {ReadonlyArray<string>}
 */
export const RAW_NAMESPACE_NAMES = Object.freeze(Object.keys(CONFIG_NAMESPACES).sort());

/** Directory (as declared) → namespace, for the path → (ns, key) direction. */
const NAMESPACE_BY_DIR = new Map(
  Object.entries(CONFIG_NAMESPACES).map(([ns, descriptor]) => [descriptor.dir, ns])
);

/**
 * The declaration for a namespace, or null when it is not raw.
 *
 * `Object.hasOwn` rather than a plain property read: namespace names reach
 * this from callers, and `CONFIG_NAMESPACES['constructor']` would otherwise
 * answer with something that is not a declaration at all.
 *
 * @param {string} ns - Namespace name
 * @returns {RawNamespace|null} The declaration, or null
 */
export function getRawNamespace(ns) {
  if (typeof ns !== 'string' || !Object.hasOwn(CONFIG_NAMESPACES, ns)) return null;
  return CONFIG_NAMESPACES[ns];
}

/**
 * The contents-relative path of one raw document.
 *
 * @param {string} ns - Raw namespace name
 * @param {string} key - Document key
 * @returns {string} Path relative to `contents/`, e.g. `apps/chat.json`
 * @throws {StorageError} Code `UNKNOWN_NAMESPACE` when `ns` is not declared raw
 * @throws {InvalidKeyError} When `key` is not a safe id
 */
export function rawRelPath(ns, key) {
  const descriptor = getRawNamespace(ns);
  if (!descriptor) {
    throw new StorageError(`Not a raw storage namespace: ${String(ns).slice(0, 64)}`, {
      code: 'UNKNOWN_NAMESPACE'
    });
  }
  if (!isValidId(key)) {
    throw new InvalidKeyError(`Invalid storage key: ${String(key).slice(0, 64)}`);
  }
  return `${descriptor.dir}/${key}${RAW_DOC_EXT}`;
}

/**
 * The `(ns, key)` pair a contents-relative path addresses, or null when the
 * path is not a raw document.
 *
 * Null is the ordinary answer for a path that is simply not one of these —
 * a page body, a `.md` source, a file two levels deep in a namespace — so
 * callers branch on it instead of catching.
 *
 * @param {string} relPath - Path relative to `contents/`, e.g. `config/platform.json`
 * @returns {{ns: string, key: string}|null} The pair, or null
 */
export function parseRawRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  // Windows separators and a leading `./` are both shapes callers pass; every
  // other oddity (absolute paths, `..`) falls out below because no declared
  // directory can match it.
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.endsWith(RAW_DOC_EXT)) return null;
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const ns = NAMESPACE_BY_DIR.get(normalized.slice(0, lastSlash));
  if (!ns) return null;
  const key = normalized.slice(lastSlash + 1, -RAW_DOC_EXT.length);
  if (!isValidId(key)) return null;
  return { ns, key };
}

export default CONFIG_NAMESPACES;

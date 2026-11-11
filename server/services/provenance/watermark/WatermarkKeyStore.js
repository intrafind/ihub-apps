// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Encrypted store of the text watermark keys (#3331).
 *
 * Keys are safe integers (vLLM takes an integer key; JavaScript loses
 * precision above 2^53, so v1 never stores or sends anything larger). Each key
 * has a server-assigned id `wm-<product>-<installation id>-<year>-<seq>` that is never
 * reused and does not clash with another installation's, and a status:
 * exactly one `active` key (the one vLLM should be started with) once any key
 * exists, the rest `retired` (detection only).
 *
 * The file lives in `config/watermark-keys.json`, not in `platform.json`
 * (a stale admin tab rewrites that whole file) and it is never loaded into
 * `configCache`: values are decrypted here, at use, and only
 * {@link WatermarkKeyStore#getKeysForDetection} and
 * {@link WatermarkKeyStore#reveal} hand one out. Callers that only need ids use
 * {@link getActiveKeyId}, a synchronous in-memory snapshot of ids.
 *
 * @module services/provenance/watermark/WatermarkKeyStore
 */
import { randomInt } from 'node:crypto';
import configStore from '../../config/ConfigStore.js';
import tokenStorageService from '../../TokenStorageService.js';
import { ServiceError } from '../../../utils/ServiceError.js';
import { getProvenanceStore } from '../ProvenanceStore.js';
import logger from '../../../utils/logger.js';
import { getActiveKeyId, setActiveKeyIdSnapshot } from './activeKeySnapshot.js';

export { getActiveKeyId, setActiveKeyIdSnapshot };

const COMPONENT = 'WatermarkKeyStore';

export const WATERMARK_KEYS_FILE = 'config/watermark-keys.json';

/** Largest key that survives a JSON round trip. */
export const MAX_KEY = Number.MAX_SAFE_INTEGER;

/** Generated keys are below 2^48; entered keys under 2^32 get a `weakKey` warning. */
const GENERATED_KEY_LIMIT = 2 ** 48;
const WEAK_KEY_LIMIT = 2 ** 32;

/**
 * Parse an admin- or user-entered key. Accepts a number or a decimal string,
 * and never goes through `Number()` for something above 2^53.
 *
 * @param {unknown} value
 * @returns {number}
 * @throws {ServiceError} WATERMARK_KEY_INVALID
 */
export function parseKey(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) text = null;
    else text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    text = null;
  }
  if (text === null || !/^[0-9]{1,16}$/.test(text)) {
    throw new ServiceError('WATERMARK_KEY_INVALID', 'The watermark key must be a safe integer');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ServiceError('WATERMARK_KEY_INVALID', 'The watermark key must be a safe integer');
  }
  return parsed;
}

function publicItem(entry) {
  const item = {
    keyId: entry.keyId,
    status: entry.status,
    source: entry.source,
    createdAt: entry.createdAt
  };
  if (entry.label) item.label = entry.label;
  if (entry.createdBy) item.createdBy = entry.createdBy;
  if (entry.retiredAt) item.retiredAt = entry.retiredAt;
  return item;
}

async function ensureEncryptionKey() {
  if (!tokenStorageService.encryptionKey) await tokenStorageService.initializeEncryptionKey();
}

function decryptKey(entry) {
  const plain = tokenStorageService.decryptString(entry.key);
  return parseKey(plain);
}

/** Keep the id snapshot in step with the stored file. */
function refreshSnapshot(store) {
  const active = (store?.keys || []).find(entry => entry.status === 'active');
  setActiveKeyIdSnapshot(active ? active.keyId : null);
}

/** `{ version, nextSeq, keys }`; the empty state is the ordinary first run. */
function normalize(current) {
  const store =
    current && typeof current === 'object' && Array.isArray(current.keys)
      ? current
      : { version: 1, nextSeq: {}, keys: [] };
  store.nextSeq = store.nextSeq && typeof store.nextSeq === 'object' ? store.nextSeq : {};
  return store;
}

/** One active key once any key exists; asserted inside every mutation. */
function assertInvariant(store) {
  const active = store.keys.filter(entry => entry.status === 'active').length;
  if (store.keys.length > 0 && active !== 1) {
    throw new Error(`Watermark key store invariant broken: ${active} active keys`);
  }
}

/** Product segment of a key id. */
export const KEY_ID_PRODUCT = 'ihub';

/**
 * An installation id as it appears inside a key id: without its `inst_` prefix (the
 * `wm-<product>-` part already says what it is), and safe for an id (the env
 * override is free text).
 */
function idSegment(value) {
  return String(value || 'unknown')
    .replace(/^inst_/, '')
    .replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * `wm-<product>-<installation uuid>-<year>-<seq>`. The product and the installation
 * id (the uuid of `generator.installation_id` in provenance objects, without `inst_`) say
 * where a key id comes from when it travels alone, in detector requests and logs,
 * and keep two installations (a clone, a restored backup, a shared detector) from
 * handing out the same id. The sequence stays for people to read.
 */
function allocateKeyId(store, now, installationId) {
  const year = String(now.getUTCFullYear());
  const existing = store.keys
    .map(entry => /-(\d{4})-(\d+)$/.exec(entry.keyId))
    .filter(match => match && match[1] === year)
    .map(match => Number(match[2]));
  // The counter survives deletion; the max of what is stored guards a hand-edited file.
  const seq = Math.max(store.nextSeq[year] || 1, ...existing.map(n => n + 1));
  store.nextSeq[year] = seq + 1;
  return `wm-${KEY_ID_PRODUCT}-${idSegment(installationId)}-${year}-${seq}`;
}

/**
 * The vLLM start-up flag for a key. The key is an unquoted integer;
 * `enforce: true` stops a client from switching the watermark off.
 *
 * @param {number|string} keyValue
 * @param {{contextWidth?: number}} [options]
 * @returns {string}
 */
export function buildVllmConfigSnippet(keyValue, { contextWidth } = {}) {
  const key = parseKey(keyValue);
  const width = Number.isInteger(contextWidth) ? `,"context_width":${contextWidth}` : '';
  return `--watermark-config '{"algorithm":"gumbel","key":${key}${width},"enforce":true}'`;
}

export class WatermarkKeyStore {
  constructor({
    store = configStore,
    now = () => new Date(),
    installationId = () => getProvenanceStore().installationId()
  } = {}) {
    this.store = store;
    this.now = now;
    this.installationId = installationId;
  }

  async #read() {
    const parsed = await this.store.readJsonStrict(WATERMARK_KEYS_FILE);
    return normalize(parsed);
  }

  /** Load the id snapshot at start-up and after changes by another worker. */
  async init() {
    try {
      refreshSnapshot(await this.#read());
    } catch (error) {
      // A corrupt file leaves the snapshot empty ("no_active_key"), never claims a key.
      setActiveKeyIdSnapshot(null);
      logger.error('Could not read the watermark key store', {
        component: COMPONENT,
        error: error.message
      });
    }
  }

  /** @returns {Promise<Object[]>} Items without any key value. */
  async list() {
    const store = await this.#read();
    refreshSnapshot(store);
    return store.keys.map(publicItem);
  }

  /**
   * Create a key (generated, or entered by the admin) and make it active; the
   * previous active key becomes retired, in one atomic update.
   *
   * @param {{key?: unknown, label?: string}} [input]
   * @param {string} [actor]
   * @returns {Promise<{item: Object, key: number, weakKey: boolean, previousActiveKeyId: string|null}>}
   */
  async create({ key, label } = {}, actor = 'unknown') {
    await ensureEncryptionKey();
    const entered = key !== undefined && key !== null && key !== '';
    const value = entered ? parseKey(key) : randomInt(1, GENERATED_KEY_LIMIT);
    const installation = await this.installationId();
    const safeLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 100) : null;
    let created = null;
    let previous = null;
    const { data } = await this.store.updateJson(WATERMARK_KEYS_FILE, current => {
      const store = normalize(current);
      for (const entry of store.keys) {
        if (decryptKey(entry) === value) {
          throw new ServiceError('WATERMARK_KEY_DUPLICATE', 'This key value is already stored', {
            details: { keyId: entry.keyId }
          });
        }
      }
      const now = this.now();
      const stamp = now.toISOString();
      previous = null;
      for (const entry of store.keys) {
        if (entry.status === 'active') {
          previous = entry.keyId;
          entry.status = 'retired';
          entry.retiredAt = stamp;
        }
      }
      created = {
        keyId: allocateKeyId(store, now, installation),
        status: 'active',
        key: tokenStorageService.encryptString(String(value)),
        source: entered ? 'entered' : 'generated',
        createdAt: stamp,
        createdBy: actor
      };
      if (safeLabel) created.label = safeLabel;
      store.keys.push(created);
      assertInvariant(store);
      return store;
    });
    refreshSnapshot(data);
    return {
      item: publicItem(created),
      key: value,
      weakKey: entered && value < WEAK_KEY_LIMIT,
      previousActiveKeyId: previous
    };
  }

  /**
   * Make a retired key active again (rollback when vLLM was not updated).
   *
   * @returns {Promise<{item: Object, previousActiveKeyId: string|null}>}
   */
  async activate(keyId) {
    let target = null;
    let previous = null;
    const { data } = await this.store.updateJson(WATERMARK_KEYS_FILE, current => {
      const store = normalize(current);
      target = store.keys.find(entry => entry.keyId === keyId);
      if (!target) throw new ServiceError('WATERMARK_KEY_NOT_FOUND', 'Watermark key not found');
      if (target.status === 'active') {
        previous = target.keyId;
        return undefined;
      }
      const stamp = this.now().toISOString();
      previous = null;
      for (const entry of store.keys) {
        if (entry.status === 'active') {
          previous = entry.keyId;
          entry.status = 'retired';
          entry.retiredAt = stamp;
        }
      }
      target.status = 'active';
      delete target.retiredAt;
      assertInvariant(store);
      return store;
    });
    refreshSnapshot(data);
    const entry = data.keys.find(item => item.keyId === keyId);
    return { item: publicItem(entry), previousActiveKeyId: previous };
  }

  /**
   * The value of one key, for the admin who must reconfigure vLLM. The caller
   * audits the reveal before it responds.
   *
   * @returns {Promise<{keyId: string, key: number}>}
   */
  async reveal(keyId) {
    await ensureEncryptionKey();
    const store = await this.#read();
    const entry = store.keys.find(item => item.keyId === keyId);
    if (!entry) throw new ServiceError('WATERMARK_KEY_NOT_FOUND', 'Watermark key not found');
    return { keyId, key: decryptKey(entry) };
  }

  /**
   * Delete a retired key: output made with it can no longer be recognised, and
   * its id is never handed out again.
   */
  async remove(keyId) {
    const { data } = await this.store.updateJson(WATERMARK_KEYS_FILE, current => {
      const store = normalize(current);
      const entry = store.keys.find(item => item.keyId === keyId);
      if (!entry) throw new ServiceError('WATERMARK_KEY_NOT_FOUND', 'Watermark key not found');
      if (entry.status === 'active') {
        throw new ServiceError('WATERMARK_KEY_ACTIVE', 'The active key cannot be deleted');
      }
      store.keys = store.keys.filter(item => item.keyId !== keyId);
      assertInvariant(store);
      return store;
    });
    refreshSnapshot(data);
  }

  /**
   * Every key for the detector, active first. Only the detector client calls this.
   *
   * @returns {Promise<Array<{keyId: string, key: number, status: string}>>}
   */
  async getKeysForDetection() {
    await ensureEncryptionKey();
    const store = await this.#read();
    return [...store.keys]
      .sort((a, b) => (a.status === 'active' ? -1 : 0) - (b.status === 'active' ? -1 : 0))
      .map(entry => ({ keyId: entry.keyId, key: decryptKey(entry), status: entry.status }));
  }
}

let instance = null;

/** The process-wide store. */
export function getWatermarkKeyStore() {
  if (!instance) instance = new WatermarkKeyStore();
  return instance;
}

/**
 * Load the id snapshot and keep it fresh against changes by another worker.
 * Ids only: no key value is read into memory beyond the call that needs it.
 */
export function startWatermarkKeySnapshot({ intervalMs = 30_000 } = {}) {
  getWatermarkKeyStore()
    .init()
    .catch(() => {});
  const timer = setInterval(() => {
    getWatermarkKeyStore()
      .init()
      .catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/** Test hook: drop the singleton. */
export function resetWatermarkKeyStore() {
  instance = null;
  setActiveKeyIdSnapshot(null);
}

export default getWatermarkKeyStore;

/**
 * Key material for EU AI Act marking: C2PA signing certificates and text
 * watermark key groups, in `contents/.ai-provenance/keystore.json`.
 *
 * Every private key and watermark key is encrypted with the installation's
 * `contents/.encryption-key` (AES-256-GCM via TokenStorageService) before it
 * is written, and only ever decrypted in memory. Nothing in here is logged or
 * returned by an API in plaintext: status views go through `describe*`.
 *
 * The file is shared by every worker (same contents directory). Writes are
 * read-modify-write under an in-process lock with an atomic rename; the
 * first certificate is created with an exclusive create so two workers
 * starting at once agree on one CA.
 *
 * @module services/provenance/keyStore
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import { getRootDir } from '../../pathUtils.js';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';

export const KEYSTORE_DIR = '.ai-provenance';
export const KEYSTORE_FILE = 'keystore.json';
const COMPONENT = 'ProvenanceKeyStore';

function emptyStore() {
  return { version: 1, certificates: [], keyGroups: [] };
}

class KeyStore {
  constructor() {
    this._cache = null;
    this._cacheMtime = 0;
    this._lock = Promise.resolve();
    this._pathOverride = null;
  }

  /** Test hook: point the store at another file. */
  _setPath(filePath) {
    this._pathOverride = filePath;
    this._cache = null;
    this._cacheMtime = 0;
  }

  get filePath() {
    return (
      this._pathOverride ||
      path.join(getRootDir(), config.CONTENTS_DIR, KEYSTORE_DIR, KEYSTORE_FILE)
    );
  }

  /**
   * The store, re-read when the file changed (another worker wrote it).
   * @returns {Promise<{version: number, certificates: Object[], keyGroups: Object[]}>}
   */
  async read() {
    try {
      const stat = await fs.stat(this.filePath);
      if (this._cache && stat.mtimeMs === this._cacheMtime) return this._cache;
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this._cache = {
        ...emptyStore(),
        ...parsed,
        certificates: Array.isArray(parsed.certificates) ? parsed.certificates : [],
        keyGroups: Array.isArray(parsed.keyGroups) ? parsed.keyGroups : []
      };
      this._cacheMtime = stat.mtimeMs;
      return this._cache;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyStore();
      logger.error('AI provenance keystore is unreadable', {
        component: COMPONENT,
        error: error.message
      });
      throw error;
    }
  }

  async _write(store) {
    const file = this.filePath;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
    const stat = await fs.stat(file);
    this._cache = store;
    this._cacheMtime = stat.mtimeMs;
  }

  /**
   * Read, change and write the store under the lock.
   * @template T
   * @param {(store: Object) => (T|Promise<T>)} mutator - edits `store` in place; its return value is passed through
   * @returns {Promise<T>}
   */
  update(mutator) {
    const run = async () => {
      this._cache = null;
      const store = JSON.parse(JSON.stringify(await this.read()));
      const result = await mutator(store);
      await this._write(store);
      return result;
    };
    const next = this._lock.then(run, run);
    this._lock = next.catch(() => {});
    return next;
  }

  /**
   * Create the store with a first certificate unless another worker did so
   * first. Returns true when this call created it.
   * @param {Object} certificate
   * @returns {Promise<boolean>}
   */
  async createWithCertificate(certificate) {
    const file = this.filePath;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const store = { ...emptyStore(), certificates: [certificate] };
    try {
      await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      this._cache = null;
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  }
}

/** Encrypt a secret for the keystore. */
export function sealSecret(plaintext) {
  return tokenStorageService.encryptString(String(plaintext));
}

/** Decrypt a keystore secret. */
export function openSecret(sealed) {
  if (typeof sealed !== 'string' || !sealed) return null;
  if (!tokenStorageService.isEncrypted(sealed)) return sealed;
  return tokenStorageService.decryptString(sealed);
}

const keyStore = new KeyStore();
export default keyStore;

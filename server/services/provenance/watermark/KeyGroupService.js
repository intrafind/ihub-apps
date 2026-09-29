/**
 * Text-watermark key groups (concept §8.4, issue #2572).
 *
 * A self-hosted vLLM server watermarks with a secret integer key
 * (`vllm serve … --watermark-config '{"algorithm":"gumbel","key":<key>}'`),
 * and detection needs the same key and the model's tokenizer. Keys belong to
 * a **key group** — typically one per customer, not per installation — so the
 * customer's installations watermark with and detect the same key:
 *
 * - an admin exports the group as an **encrypted key bundle** (scrypt +
 *   AES-256-GCM under a passphrase) and imports it elsewhere;
 * - rotation creates a new key version; old versions stay **detect-only**, so
 *   older text still verifies (CoP 2.1.4).
 *
 * Keys are stored encrypted in the keystore and only decrypted in memory for
 * detection or when an admin explicitly reveals the vLLM config.
 *
 * @module services/provenance/watermark/KeyGroupService
 */
import crypto from 'node:crypto';
import keyStore, { openSecret, sealSecret } from '../keyStore.js';
import { getInstallationId } from '../installation.js';

const BUNDLE_FORMAT = 'ihub-watermark-keybundle';
const ID_RE = /^[a-z0-9._-]{1,64}$/;
const DEFAULT_CONTEXT_WIDTH = 4;

export class KeyGroupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'KeyGroupError';
    this.status = status;
  }
}

/** A random positive 63-bit integer, as vLLM's `key` expects. */
function newWatermarkKey() {
  const n = crypto.randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn;
  return (n === 0n ? 1n : n).toString();
}

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(`ihub-wm:${key}`).digest('hex').slice(0, 16);
}

/** Public view: never the key. */
function describe(group) {
  const versions = (group.versions || []).map(v => ({
    version: v.version,
    status: v.status,
    createdAt: v.createdAt,
    fingerprint: v.fingerprint,
    importedFrom: v.importedFrom || undefined
  }));
  const active = versions.find(v => v.status === 'active') || null;
  return {
    id: group.id,
    name: group.name || group.id,
    algorithm: group.algorithm || 'gumbel',
    contextWidth: group.contextWidth || DEFAULT_CONTEXT_WIDTH,
    detectorUrl: group.detectorUrl || '',
    createdAt: group.createdAt,
    activeVersion: active ? active.version : null,
    versions
  };
}

class KeyGroupService {
  /** All key groups (public view). */
  async list() {
    const store = await keyStore.read();
    return store.keyGroups.map(describe);
  }

  /** One key group (public view) or null. */
  async get(id) {
    const store = await keyStore.read();
    const group = store.keyGroups.find(g => g.id === id);
    return group ? describe(group) : null;
  }

  /**
   * Create a key group with a first key.
   * @param {{id: string, name?: string, detectorUrl?: string, contextWidth?: number}} input
   */
  async create({ id, name, detectorUrl = '', contextWidth = DEFAULT_CONTEXT_WIDTH }) {
    if (!ID_RE.test(String(id || ''))) {
      throw new KeyGroupError('Key group id must be lowercase letters, digits, ".", "_" or "-"');
    }
    return keyStore.update(store => {
      if (store.keyGroups.some(g => g.id === id)) {
        throw new KeyGroupError(`Key group "${id}" already exists`, 409);
      }
      const key = newWatermarkKey();
      const group = {
        id,
        name: name || id,
        algorithm: 'gumbel',
        contextWidth: Number(contextWidth) || DEFAULT_CONTEXT_WIDTH,
        detectorUrl: String(detectorUrl || ''),
        createdAt: new Date().toISOString(),
        versions: [
          {
            version: 1,
            status: 'active',
            keyEnc: sealSecret(key),
            fingerprint: keyFingerprint(key),
            createdAt: new Date().toISOString()
          }
        ]
      };
      store.keyGroups.push(group);
      return describe(group);
    });
  }

  /** Change name, detector URL or context width. */
  async update(id, { name, detectorUrl, contextWidth } = {}) {
    return keyStore.update(store => {
      const group = store.keyGroups.find(g => g.id === id);
      if (!group) throw new KeyGroupError('Unknown key group', 404);
      if (name !== undefined) group.name = String(name);
      if (detectorUrl !== undefined) group.detectorUrl = String(detectorUrl);
      if (contextWidth !== undefined) group.contextWidth = Number(contextWidth) || DEFAULT_CONTEXT_WIDTH;
      return describe(group);
    });
  }

  /** New active key version; the previous one becomes detect-only. */
  async rotate(id) {
    return keyStore.update(store => {
      const group = store.keyGroups.find(g => g.id === id);
      if (!group) throw new KeyGroupError('Unknown key group', 404);
      for (const v of group.versions) if (v.status === 'active') v.status = 'detect-only';
      const key = newWatermarkKey();
      const version = Math.max(0, ...group.versions.map(v => v.version)) + 1;
      group.versions.push({
        version,
        status: 'active',
        keyEnc: sealSecret(key),
        fingerprint: keyFingerprint(key),
        createdAt: new Date().toISOString()
      });
      return describe(group);
    });
  }

  /**
   * The `--watermark-config` for the vLLM server of this group (reveals the
   * active key — admin only, audited by the route).
   * @param {string} id
   */
  async vllmConfig(id) {
    const store = await keyStore.read();
    const group = store.keyGroups.find(g => g.id === id);
    if (!group) throw new KeyGroupError('Unknown key group', 404);
    const active = group.versions.find(v => v.status === 'active');
    if (!active) throw new KeyGroupError('Key group has no active key');
    const key = openSecret(active.keyEnc);
    const config = {
      algorithm: group.algorithm || 'gumbel',
      key: Number.isSafeInteger(Number(key)) ? Number(key) : key,
      context_width: group.contextWidth || DEFAULT_CONTEXT_WIDTH
    };
    const json = JSON.stringify(config).replace(`"key":"${key}"`, `"key":${key}`);
    return { version: active.version, watermarkConfig: json };
  }

  /**
   * Every key version of a group with the decrypted key, newest first — for
   * detection only, never returned by an API.
   * @param {string} id
   * @returns {Promise<{group: Object, keys: {version: number, status: string, key: string}[]}|null>}
   */
  async detectionKeys(id) {
    const store = await keyStore.read();
    const group = store.keyGroups.find(g => g.id === id);
    if (!group) return null;
    const keys = group.versions
      .map(v => ({ version: v.version, status: v.status, key: openSecret(v.keyEnc) }))
      .filter(k => k.key)
      .sort((a, b) => b.version - a.version);
    return { group: describe(group), keys };
  }

  /** The active version of a group, or null. */
  async activeVersion(id) {
    const group = await this.get(id);
    return group?.activeVersion ?? null;
  }

  /**
   * Export groups as an encrypted bundle.
   * @param {string[]} ids
   * @param {string} passphrase - at least 12 characters
   * @returns {Promise<Object>} the bundle (JSON-serialisable)
   */
  async exportBundle(ids, passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < 12) {
      throw new KeyGroupError('The passphrase must have at least 12 characters');
    }
    const store = await keyStore.read();
    const groups = store.keyGroups.filter(g => ids.includes(g.id));
    if (!groups.length) throw new KeyGroupError('No key group selected', 404);
    const plaintext = JSON.stringify({
      exportedAt: new Date().toISOString(),
      fromInstallation: getInstallationId(),
      keyGroups: groups.map(g => ({
        id: g.id,
        name: g.name,
        algorithm: g.algorithm || 'gumbel',
        contextWidth: g.contextWidth || DEFAULT_CONTEXT_WIDTH,
        versions: g.versions.map(v => ({
          version: v.version,
          status: v.status,
          createdAt: v.createdAt,
          key: openSecret(v.keyEnc)
        }))
      }))
    });
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      format: BUNDLE_FORMAT,
      version: 1,
      kdf: { name: 'scrypt', N: 2 ** 15, r: 8, p: 1, salt: salt.toString('base64') },
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      groups: groups.map(g => g.id),
      ciphertext: ciphertext.toString('base64')
    };
  }

  /**
   * Import an encrypted bundle. Versions a group already has are kept; new
   * versions are added. An imported version that is active in the bundle
   * becomes active here too, unless this installation already has a newer
   * active version.
   * @param {Object} bundle
   * @param {string} passphrase
   * @returns {Promise<Object[]>} imported groups (public view)
   */
  async importBundle(bundle, passphrase) {
    if (bundle?.format !== BUNDLE_FORMAT || bundle.version !== 1) {
      throw new KeyGroupError('Not an iHub watermark key bundle');
    }
    let payload;
    try {
      const kdf = bundle.kdf || {};
      const key = crypto.scryptSync(String(passphrase || ''), Buffer.from(kdf.salt, 'base64'), 32, {
        N: kdf.N,
        r: kdf.r,
        p: kdf.p,
        maxmem: 64 * 1024 * 1024
      });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(bundle.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(bundle.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf8');
      payload = JSON.parse(plaintext);
    } catch {
      throw new KeyGroupError('Wrong passphrase or damaged bundle');
    }
    return keyStore.update(store => {
      const imported = [];
      for (const incoming of payload.keyGroups || []) {
        if (!ID_RE.test(String(incoming.id || ''))) continue;
        let group = store.keyGroups.find(g => g.id === incoming.id);
        if (!group) {
          group = {
            id: incoming.id,
            name: incoming.name || incoming.id,
            algorithm: incoming.algorithm || 'gumbel',
            contextWidth: incoming.contextWidth || DEFAULT_CONTEXT_WIDTH,
            detectorUrl: '',
            createdAt: new Date().toISOString(),
            versions: []
          };
          store.keyGroups.push(group);
        }
        for (const v of incoming.versions || []) {
          if (!v.key || group.versions.some(x => x.version === v.version)) continue;
          group.versions.push({
            version: v.version,
            status: 'detect-only',
            keyEnc: sealSecret(v.key),
            fingerprint: keyFingerprint(v.key),
            createdAt: v.createdAt || new Date().toISOString(),
            importedFrom: payload.fromInstallation || 'bundle',
            _activeInBundle: v.status === 'active'
          });
        }
        const bundleActive = group.versions.find(v => v._activeInBundle);
        const localActive = group.versions.find(v => v.status === 'active');
        if (bundleActive && (!localActive || localActive.version < bundleActive.version)) {
          if (localActive) localActive.status = 'detect-only';
          bundleActive.status = 'active';
        }
        for (const v of group.versions) delete v._activeInBundle;
        imported.push(describe(group));
      }
      return imported;
    });
  }

  /** Delete a key group (content marked with it can no longer be detected). */
  async remove(id) {
    return keyStore.update(store => {
      const before = store.keyGroups.length;
      store.keyGroups = store.keyGroups.filter(g => g.id !== id);
      if (store.keyGroups.length === before) throw new KeyGroupError('Unknown key group', 404);
      return true;
    });
  }
}

const keyGroupService = new KeyGroupService();
export default keyGroupService;

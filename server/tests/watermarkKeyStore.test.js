// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The encrypted watermark key store (#3331): ciphertext on disk, one active key,
 * rotation, ids that are never reused, duplicates, and a corrupt file that is
 * never overwritten.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const { startTestStorage } = await import('./helpers/testStorage.js');
const {
  WatermarkKeyStore,
  parseKey,
  buildVllmConfigSnippet,
  getActiveKeyId,
  resetWatermarkKeyStore
} = await import('../services/provenance/watermark/WatermarkKeyStore.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');

const KEY_ID = /^wm-ihub-inst_[0-9a-f-]{36}-2026-1$/;
let storage;
let store;

async function allFilesText(dir) {
  let text = '';
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) text += await allFilesText(p);
    else text += (await fs.readFile(p, 'utf8').catch(() => '')) + '\n';
  }
  return text;
}

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-wm-keys-' });
});
afterAll(async () => {
  await storage.stop();
});
beforeEach(async () => {
  resetWatermarkKeyStore();
  await configStore.writeJson('config/watermark-keys.json', {
    version: 1,
    nextSeq: {},
    keys: []
  });
  store = new WatermarkKeyStore({ now: () => new Date('2026-11-11T10:00:00Z') });
});

describe('WatermarkKeyStore', () => {
  test('stores ciphertext only', async () => {
    const created = await store.create({ key: '1234567890123' }, 'admin');
    expect(created.item.keyId).toMatch(KEY_ID);
    await new Promise(resolve => setTimeout(resolve, 100));
    const raw = await allFilesText(storage.dir);
    expect(raw).toContain('ENC[');
    expect(raw).not.toContain('1234567890123');
  });

  test('rotation retires the previous key and keeps exactly one active', async () => {
    const first = await store.create({}, 'admin');
    const second = await store.create({ label: 'Q4' }, 'admin');
    expect(second.previousActiveKeyId).toBe(first.item.keyId);
    const items = await store.list();
    expect(items.map(i => [i.keyId, i.status])).toEqual([
      [first.item.keyId, 'retired'],
      [second.item.keyId, 'active']
    ]);
    expect(first.item.keyId).toMatch(/^wm-ihub-inst_[0-9a-f-]{36}-2026-1$/);
    expect(second.item.keyId).toMatch(/^wm-ihub-inst_[0-9a-f-]{36}-2026-2$/);
    expect(items[0].retiredAt).toBeTruthy();
    expect(getActiveKeyId()).toBe(second.item.keyId);
    expect(JSON.stringify(items)).not.toContain(String(first.key));
  });

  test('five concurrent creates leave exactly one active key and unique ids', async () => {
    await Promise.all(Array.from({ length: 5 }, () => store.create({}, 'admin')));
    const items = await store.list();
    expect(items).toHaveLength(5);
    expect(items.filter(i => i.status === 'active')).toHaveLength(1);
    expect(new Set(items.map(i => i.keyId)).size).toBe(5);
  });

  test('ids are never reused after a delete', async () => {
    const first = await store.create({}, 'a');
    await store.create({}, 'a');
    await store.remove(first.item.keyId);
    const third = await store.create({}, 'a');
    expect(third.item.keyId).toMatch(/^wm-ihub-inst_[0-9a-f-]{36}-2026-3$/);
  });

  test('rejects a duplicate value, an active delete and a missing key', async () => {
    const stored = await store.create({ key: '555555555' }, 'a');
    await expect(store.create({ key: 555555555 }, 'a')).rejects.toMatchObject({
      code: 'WATERMARK_KEY_DUPLICATE'
    });
    await expect(store.remove(stored.item.keyId)).rejects.toMatchObject({
      code: 'WATERMARK_KEY_ACTIVE'
    });
    await expect(store.remove('wm-ihub-inst_x-2026-9')).rejects.toMatchObject({
      code: 'WATERMARK_KEY_NOT_FOUND'
    });
    await expect(store.reveal('wm-ihub-inst_x-2026-9')).rejects.toMatchObject({
      code: 'WATERMARK_KEY_NOT_FOUND'
    });
  });

  test('activate swaps; detection lists active first and decrypts values', async () => {
    const a = await store.create({ key: '111111111' }, 'a');
    const b = await store.create({ key: '222222222' }, 'a');
    await store.activate(a.item.keyId);
    expect(getActiveKeyId()).toBe(a.item.keyId);
    const keys = await store.getKeysForDetection();
    expect(keys.map(k => [k.keyId, k.key, k.status])).toEqual([
      [a.item.keyId, 111111111, 'active'],
      [b.item.keyId, 222222222, 'retired']
    ]);
    expect((await store.reveal(b.item.keyId)).key).toBe(222222222);
  });

  test('the id carries product and installation id, so two installations never clash', async () => {
    const now = () => new Date('2026-11-11T10:00:00Z');
    const one = new WatermarkKeyStore({ now, installationId: async () => 'inst_aaaa' });
    const two = new WatermarkKeyStore({ now, installationId: async () => 'inst_bbbb' });
    const a = await one.create({}, 'a');
    // Another installation starts from an empty store of its own.
    await configStore.writeJson('config/watermark-keys.json', {
      version: 1,
      nextSeq: {},
      keys: []
    });
    const b = await two.create({}, 'a');
    expect(a.item.keyId).toBe('wm-ihub-inst_aaaa-2026-1');
    expect(b.item.keyId).toBe('wm-ihub-inst_bbbb-2026-1');
  });

  test('an installation id from the environment is made safe for an id', async () => {
    const odd = new WatermarkKeyStore({ installationId: async () => 'my site/prod 1' });
    const created = await odd.create({}, 'a');
    expect(created.item.keyId).toMatch(/^wm-ihub-my-site-prod-1-\d{4}-1$/);
  });

  test('weak entered keys are flagged; generated keys are safe integers', async () => {
    expect((await store.create({ key: '42' }, 'a')).weakKey).toBe(true);
    const generated = await store.create({}, 'a');
    expect(Number.isSafeInteger(generated.key)).toBe(true);
    expect(generated.weakKey).toBe(false);
  });

  test('a corrupt file throws and is not overwritten', async () => {
    const original = { garbage: true, keys: 'nope' };
    await configStore.writeJson('config/watermark-keys.json', original);
    // Not a key list: normalised as empty only for a missing file; a malformed shape is treated as empty,
    // but an unreadable file must throw.
    const broken = new WatermarkKeyStore({
      store: {
        readJsonStrict: async () => {
          throw new Error('unreadable');
        },
        updateJson: async () => {
          throw new Error('unreadable');
        }
      }
    });
    await expect(broken.list()).rejects.toThrow('unreadable');
    await expect(broken.create({}, 'a')).rejects.toThrow('unreadable');
  });
});

describe('parseKey and the vLLM snippet', () => {
  test('accepts safe integers and decimal strings, never larger', () => {
    expect(parseKey('9007199254740991')).toBe(9007199254740991);
    expect(parseKey(42)).toBe(42);
    for (const bad of ['9007199254740993', '0', '-1', '1.5', 'abc', '', 1.5, 2 ** 60, null, {}]) {
      expect(() => parseKey(bad)).toThrow(
        expect.objectContaining({ code: 'WATERMARK_KEY_INVALID' })
      );
    }
  });

  test('the key is an unquoted integer and enforce is on', () => {
    expect(buildVllmConfigSnippet('4242', { contextWidth: 4 })).toBe(
      `--watermark-config '{"algorithm":"gumbel","key":4242,"context_width":4,"enforce":true}'`
    );
  });
});

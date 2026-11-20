// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Nothing readable in the bucket" against a REAL S3-compatible server (the
 * one named by `IHUB_TEST_S3_ENDPOINT`, see `support/s3TestBackend.js`).
 *
 * `storage-s3-nothing-readable.test.js` proves it on the in-repo fake, where
 * the raw bytes come from the fake's own memory. Here every object is fetched
 * back from the server with a second client, so the proof covers what a
 * person with read access to the real bucket would download.
 *
 * Blobs are written through the storage provider as the registry composes it
 * from a `platform.json` `storage` section, into every declared blob
 * namespace.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReadableScanner, entropy } from './support/readableScanner.js';
import { describeS3Targets } from './support/s3TestBackend.js';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-ext-readable-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
const storage = await import('../storage/index.js');
const { BLOB_NAMESPACES } = await import('../storage/namespaces.js');

const scanner = createReadableScanner();

after(() => fs.rm(scratch, { recursive: true, force: true }));

describeS3Targets(
  'S3 blob backend: nothing readable in the bucket',
  target => {
    let s3;
    let provider;
    const dataDir = path.join(scratch, 'data');

    before(async () => {
      s3 = await target.open();
      provider = await storage.initializeStorage({
        env: {},
        platformConfig: {
          storage: {
            provider: 'filesystem',
            filesystem: { baseDir: dataDir },
            encryption: { enabled: true },
            blobs: { provider: 's3', s3: s3.config() }
          }
        }
      });
      for (const ns of Object.values(BLOB_NAMESPACES)) {
        for (const [kind, data] of Object.entries(scanner.payloads())) {
          await provider.blobs.put(ns, `scope__owner__${kind}`, data, {
            contentType: `text/x-${scanner.marker}`
          });
        }
      }
    });

    after(async () => {
      await storage.shutdownStorage();
      await s3?.close();
    });

    it('holds one envelope per blob plus the key check object, and nothing else', async () => {
      const objects = await s3.rawObjects();
      const namespaces = Object.values(BLOB_NAMESPACES);
      assert.equal(objects.length, namespaces.length * 6 + 1);
      const allowed = new Set([...namespaces, '_ihub']);
      for (const { key } of objects) {
        const [prefix, tenant, ns, name, ...rest] = key.split('/');
        assert.deepEqual([prefix, tenant, rest.length], [s3.prefix, 'default', 0], key);
        assert.ok(allowed.has(ns), `unexpected namespace in ${key}`);
        assert.match(name, /^[A-Za-z0-9._-]+$/);
        assert.deepEqual(scanner.find(Buffer.from(key)), [], `payload text in the name ${key}`);
      }
    });

    it('serves no payload marker and no payload bytes for any object', async () => {
      for (const { key, size } of await s3.rawObjects()) {
        const stored = await s3.rawGet(key);
        assert.equal(stored.length, size, key);
        assert.deepEqual(scanner.find(stored), [], `readable content in ${key}`);
        assert.equal(stored.toString('ascii', 0, 4), 'IHB1', `${key} is an envelope`);
        if (stored.length > 4096 + 512) {
          const bits = entropy(stored.subarray(512));
          assert.ok(bits > 7.5, `${key}: ciphertext entropy ${bits.toFixed(2)}`);
        }
      }
    });

    it('reads every payload back through the provider', async () => {
      for (const ns of Object.values(BLOB_NAMESPACES)) {
        for (const [kind, data] of Object.entries(scanner.payloads())) {
          const read = await provider.blobs.get(ns, `scope__owner__${kind}`);
          assert.ok(read.data.equals(data), `${ns}/${kind}`);
        }
      }
    });

    it('wrote no blob to local disk beside the bucket', () => {
      assert.equal(fsSync.existsSync(path.join(dataDir, 'blobs')), false);
    });

    it('would notice plaintext: the scanner finds what it is given unencrypted', () => {
      const payloads = scanner.payloads();
      assert.deepEqual(scanner.find(payloads.text), ['marker (UTF-8)']);
      assert.deepEqual(scanner.find(payloads.utf16), ['marker (UTF-16LE)']);
      assert.deepEqual(scanner.find(payloads.gzip), ['marker (gzip)']);
      assert.deepEqual(scanner.find(scanner.random.subarray(4000, 9000)), ['random payload bytes']);
      assert.ok(entropy(payloads.text) < 7.5);
    });

    it('refuses a plaintext object someone put into the bucket', async () => {
      const planted = `${s3.prefix}/default/chat-files/planted`;
      await s3.rawPut(planted, scanner.payloads().text);
      try {
        assert.deepEqual(scanner.find(await s3.rawGet(planted)), ['marker (UTF-8)']);
        await assert.rejects(provider.blobs.get('chat-files', 'planted'), { code: 'CORRUPT_BLOB' });
      } finally {
        await s3.rawDelete(planted);
      }
    });
  },
  { kinds: ['external'] }
);

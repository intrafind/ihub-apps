// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Nothing readable in the bucket": with `storage.encryption.enabled`, blobs
 * are written through the storage provider as the registry composes it from
 * `platform.json`, and then every object of the bucket is read raw from the
 * fake S3 server, behind the provider's back, and searched for the payloads.
 *
 * Every declared blob namespace is written to (`BLOB_NAMESPACES`), so a
 * namespace added later is covered without touching this file.
 *
 * What stays visible by design, and is asserted as such: object names (ids,
 * never payload text), object sizes and counts.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeS3Server } from './support/fakeS3Server.js';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-readable-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
const storage = await import('../storage/index.js');
const { BLOB_NAMESPACES } = await import('../storage/namespaces.js');

const BUCKET = 'ihub-test';
const PREFIX = 'installation-1';
const MARKER = `IHUB-PLAINTEXT-CANARY-${crypto.randomBytes(8).toString('hex')}`;
const RANDOM = crypto.randomBytes(64 * 1024);

/** What one blob of a namespace holds: text, UTF-16 text, JSON and binary. */
const payloads = () => ({
  text: Buffer.from(`${MARKER} `.repeat(200), 'utf8'),
  utf16: Buffer.from(`${MARKER} in UTF-16`, 'utf16le'),
  json: Buffer.from(JSON.stringify({ sha: { text: MARKER, note: 'evidence pack' } }), 'utf8'),
  binary: RANDOM,
  gzip: zlib.gzipSync(Buffer.from(`${MARKER} compressed`, 'utf8')),
  empty: Buffer.alloc(0)
});

/** Shannon entropy of a buffer, in bits per byte. */
function entropy(buffer) {
  const counts = new Array(256).fill(0);
  for (const byte of buffer) counts[byte] += 1;
  let bits = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / buffer.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Every way a payload of this test can show in stored bytes.
 *
 * @param {Buffer} stored - Raw object bytes (or an object name).
 * @returns {string[]} What was found; empty when nothing is readable.
 */
function readable(stored) {
  const found = [];
  const needles = {
    'marker (UTF-8)': Buffer.from(MARKER, 'utf8'),
    'marker (UTF-16LE)': Buffer.from(MARKER, 'utf16le'),
    'marker (base64)': Buffer.from(Buffer.from(MARKER).toString('base64').slice(0, 24)),
    'marker (hex)': Buffer.from(Buffer.from(MARKER).toString('hex'))
  };
  for (const [name, needle] of Object.entries(needles)) {
    if (stored.includes(needle)) found.push(name);
  }
  // Binary content: any 16-byte window of the random payload, at 16-byte steps
  // of the payload (each window is looked for at every offset of the object).
  for (let offset = 0; offset + 16 <= RANDOM.length; offset += 4096) {
    if (stored.includes(RANDOM.subarray(offset, offset + 16))) {
      found.push('random payload bytes');
      break;
    }
  }
  try {
    if (zlib.gunzipSync(stored).includes(MARKER)) found.push('marker (gzip)');
  } catch {
    // Not gzip.
  }
  return found;
}

let s3;
let provider;
let dataDir;

before(async () => {
  s3 = await startFakeS3Server({ buckets: [BUCKET] });
  dataDir = path.join(scratch, 'data');
  provider = await storage.initializeStorage({
    env: {},
    platformConfig: {
      storage: {
        provider: 'filesystem',
        filesystem: { baseDir: dataDir },
        encryption: { enabled: true },
        blobs: {
          provider: 's3',
          s3: {
            endpoint: s3.endpoint,
            bucket: BUCKET,
            prefix: PREFIX,
            accessKeyId: s3.accessKeyId,
            secretAccessKey: s3.secretAccessKey
          }
        }
      }
    }
  });
  for (const ns of Object.values(BLOB_NAMESPACES)) {
    for (const [kind, data] of Object.entries(payloads())) {
      await provider.blobs.put(ns, `scope__owner__${kind}`, data, {
        contentType: `text/x-${MARKER}`
      });
    }
  }
});

after(async () => {
  await storage.shutdownStorage();
  await s3?.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('S3 blob backend: nothing readable in the bucket', () => {
  it('wrote every declared blob namespace, including artifacts and website corpora', () => {
    const namespaces = Object.values(BLOB_NAMESPACES);
    assert.ok(namespaces.includes('artifacts') && namespaces.includes('website-corpora'));
    const written = new Set(
      s3.rawObjects(BUCKET).map(object => object.key.split('/').slice(0, 3).join('/'))
    );
    for (const ns of namespaces) {
      assert.ok(written.has(`${PREFIX}/default/${ns}`), `objects under ${ns}`);
    }
  });

  it('holds no payload marker and no payload bytes in any object', () => {
    const objects = s3.rawObjects(BUCKET);
    assert.equal(objects.length, Object.values(BLOB_NAMESPACES).length * 6 + 1);
    for (const object of objects) {
      const stored = s3.rawGet(BUCKET, object.key);
      assert.deepEqual(readable(stored), [], `readable content in ${object.key}`);
      assert.equal(stored.toString('ascii', 0, 4), 'IHB1', `${object.key} is an envelope`);
      assert.deepEqual(
        readable(Buffer.from(object.key)),
        [],
        `payload text in the name ${object.key}`
      );
      assert.equal(object.contentType, 'application/octet-stream', object.key);
      if (stored.length > 4096 + 512) {
        const bits = entropy(stored.subarray(512));
        assert.ok(bits > 7.5, `${object.key}: ciphertext entropy ${bits.toFixed(2)}`);
      }
    }
  });

  it('keeps every object under <prefix>/<tenant>/<namespace>/ and sends no metadata', () => {
    const allowed = new Set([...Object.values(BLOB_NAMESPACES), '_ihub']);
    for (const { key } of s3.rawObjects(BUCKET)) {
      const [prefix, tenant, ns, name, ...rest] = key.split('/');
      assert.deepEqual([prefix, tenant, rest.length], [PREFIX, 'default', 0], key);
      assert.ok(allowed.has(ns), `unexpected namespace in ${key}`);
      assert.match(name, /^[A-Za-z0-9._-]+$/);
    }
    for (const request of s3.requests) {
      const text = JSON.stringify([request.query, request.headers]);
      assert.equal(text.includes(MARKER), false, `${request.op} carries the marker`);
      assert.equal(
        Object.keys(request.headers).some(name => name.startsWith('x-amz-meta-')),
        false
      );
    }
  });

  it('reads every payload back through the provider', async () => {
    for (const ns of Object.values(BLOB_NAMESPACES)) {
      for (const [kind, data] of Object.entries(payloads())) {
        const read = await provider.blobs.get(ns, `scope__owner__${kind}`);
        assert.ok(read.data.equals(data), `${ns}/${kind}`);
      }
    }
  });

  it('wrote no blob to local disk beside the bucket', () => {
    assert.equal(fsSync.existsSync(path.join(dataDir, 'blobs')), false);
  });

  it('would notice plaintext: the scanner finds an object planted without encryption', () => {
    // A scanner that cannot fail proves nothing.
    assert.deepEqual(readable(payloads().text), ['marker (UTF-8)']);
    assert.deepEqual(readable(payloads().utf16), ['marker (UTF-16LE)']);
    assert.deepEqual(readable(payloads().gzip), ['marker (gzip)']);
    assert.deepEqual(readable(RANDOM.subarray(4000, 9000)), ['random payload bytes']);
    assert.ok(
      readable(Buffer.from(Buffer.from(MARKER).toString('base64'))).includes('marker (base64)')
    );
    assert.ok(readable(Buffer.from(Buffer.from(MARKER).toString('hex'))).includes('marker (hex)'));
    assert.ok(entropy(payloads().text) < 7.5);
  });

  it('refuses a plaintext object someone put into the bucket', async () => {
    s3.rawPut(BUCKET, `${PREFIX}/default/chat-files/planted`, payloads().text);
    try {
      await assert.rejects(provider.blobs.get('chat-files', 'planted'), { code: 'CORRUPT_BLOB' });
    } finally {
      s3.rawDelete(BUCKET, `${PREFIX}/default/chat-files/planted`);
    }
  });
});

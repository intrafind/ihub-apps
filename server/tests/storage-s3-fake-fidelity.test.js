// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tests of the in-repo fake S3 server itself (`support/fakeS3Server.js`).
 *
 * Most S3 suites run on the fake. Their results only mean something if the
 * fake behaves like S3 where the adapter depends on it: listing order, paging,
 * XML escaping, error answers, and refusing a request without credentials.
 * These tests talk to the fake with plain HTTP, not through the AWS SDK and
 * not through the adapter, so they do not inherit a misunderstanding from
 * either. The expectations are taken from the S3 API reference
 * (ListObjectsV2, GetObject, DeleteObject, error responses).
 *
 * One case states a limit instead of a feature: the fake does not verify
 * request signatures. Signing is only proven by a run against a real server
 * (`IHUB_TEST_S3_ENDPOINT`, see `support/s3TestBackend.js`).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAKE_S3_ACCESS_KEY_ID,
  FAKE_S3_SECRET_ACCESS_KEY,
  startFakeS3Server
} from './support/fakeS3Server.js';

const BUCKET = 'fidelity-test';
const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-fidelity-'));

/** A header that looks like SigV4 for an access key. The signature is not a real one. */
const authorization = (accessKeyId = FAKE_S3_ACCESS_KEY_ID) =>
  `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260101/us-east-1/s3/aws4_request, ` +
  'SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=' +
  '0'.repeat(64);

/** The path of an object, encoded as a client puts it on the wire. */
const objectPath = key => `/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

let s3;

/**
 * One plain HTTP request to the fake.
 *
 * @param {string} method
 * @param {string} pathAndQuery
 * @param {Object} [options]
 * @param {Buffer|string} [options.body]
 * @param {Object} [options.headers] - `authorization: null` sends none.
 * @param {Object} [options.server] - Another fake than the shared one.
 * @returns {Promise<{status: number, headers: Headers, text: string, bytes: Buffer}>}
 */
async function raw(method, pathAndQuery, { body, headers = {}, server = s3 } = {}) {
  const all = { authorization: authorization(), ...headers };
  for (const name of Object.keys(all)) if (all[name] === null) delete all[name];
  const response = await fetch(`${server.endpoint}${pathAndQuery}`, { method, headers: all, body });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    text: bytes.toString('utf8'),
    bytes
  };
}

/** The text of every `<tag>` element, unescaped the way an XML parser would. */
function elements(xmlText, tag) {
  const unescape = text =>
    text
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&');
  return [...xmlText.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(match =>
    unescape(match[1])
  );
}

/** List with query parameters; returns the parsed parts of the answer. */
async function list(params, options) {
  const query = new URLSearchParams({ 'list-type': '2', ...params });
  const answer = await raw('GET', `/${BUCKET}?${query}`, options);
  return {
    ...answer,
    keys: elements(answer.text, 'Key'),
    truncated: elements(answer.text, 'IsTruncated')[0],
    next: elements(answer.text, 'NextContinuationToken')[0],
    keyCount: elements(answer.text, 'KeyCount')[0]
  };
}

before(async () => {
  s3 = await startFakeS3Server({ buckets: [BUCKET] });
});

after(async () => {
  await s3.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('fake S3 server: credentials', () => {
  it('refuses a request without an Authorization header, with 403 AccessDenied', async () => {
    for (const [method, target] of [
      ['GET', `/${BUCKET}?list-type=2`],
      ['GET', objectPath('k')],
      ['HEAD', objectPath('k')],
      ['HEAD', `/${BUCKET}`],
      ['PUT', objectPath('unsigned')],
      ['DELETE', objectPath('k')]
    ]) {
      const answer = await raw(method, target, {
        headers: { authorization: null },
        body: method === 'PUT' ? 'x' : undefined
      });
      assert.equal(answer.status, 403, `${method} ${target}`);
      if (method !== 'HEAD') assert.deepEqual(elements(answer.text, 'Code'), ['AccessDenied']);
    }
    assert.equal(s3.rawGet(BUCKET, 'unsigned'), null, 'an unsigned PUT stored an object');
  });

  it('refuses another authentication scheme and an unknown access key', async () => {
    for (const header of ['Bearer abc', 'Basic aWh1Yjp4', 'AWS ihub-dev-not-a-secret:sig', '']) {
      const answer = await raw('GET', `/${BUCKET}?list-type=2`, {
        headers: { authorization: header || null }
      });
      assert.equal(answer.status, 403, JSON.stringify(header));
    }
    const unknown = await raw('GET', `/${BUCKET}?list-type=2`, {
      headers: { authorization: authorization('someone-else') }
    });
    assert.equal(unknown.status, 403);
    assert.deepEqual(elements(unknown.text, 'Code'), ['InvalidAccessKeyId']);
    const put = await raw('PUT', objectPath('by-someone-else'), {
      headers: { authorization: authorization('someone-else') },
      body: 'x'
    });
    assert.equal(put.status, 403);
    assert.equal(s3.rawGet(BUCKET, 'by-someone-else'), null);
  });

  it('KNOWN LIMIT: accepts any signature for the right access key (signing is not tested on the fake)', async () => {
    // If this ever fails because the fake started to verify signatures, good:
    // delete this case and the caveat in the module header.
    const answer = await raw('GET', `/${BUCKET}?list-type=2`);
    assert.equal(answer.status, 200);
    assert.equal(
      FAKE_S3_ACCESS_KEY_ID,
      FAKE_S3_SECRET_ACCESS_KEY,
      'fixed, public development values'
    );
    assert.match(FAKE_S3_ACCESS_KEY_ID, /not-a-secret/);
  });
});

describe('fake S3 server: listing', () => {
  const PREFIX = `order-${crypto.randomBytes(3).toString('hex')}/`;
  // Chosen so that UTF-8 byte order, UTF-16 code unit order and locale order all differ.
  const names = [
    'a',
    'B',
    'a b',
    'a/b',
    'a-b',
    'a.b',
    'a_b',
    'ab',
    'Z',
    '0',
    '~',
    'é',
    'z',
    '\u{ff5e}', // U+FF5E: one UTF-16 unit, three UTF-8 bytes (EF BD 9E)
    '\u{1f600}', // U+1F600: surrogate pair D83D DE00, UTF-8 F0 9F 98 80
    'a&b',
    'a<b>',
    'a"b\'',
    'a+b',
    'a%2Fb',
    'a?b#c',
    'ü'
  ];
  const byUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const expected = names.map(name => PREFIX + name).sort(byUtf8);

  before(async () => {
    for (const name of names) {
      const answer = await raw('PUT', objectPath(PREFIX + name), { body: `payload of ${name}` });
      assert.equal(answer.status, 200, name);
    }
  });

  it('lists in UTF-8 byte order, which is not UTF-16 or locale order', async () => {
    const { keys, truncated, keyCount, status } = await list({ prefix: PREFIX });
    assert.equal(status, 200);
    assert.deepEqual(keys, expected);
    assert.equal(truncated, 'false');
    assert.equal(keyCount, String(names.length));
    // The fixture really tells the orders apart.
    assert.notDeepEqual(expected, [...expected].sort(), 'UTF-16 order would pass as well');
    assert.notDeepEqual(
      expected,
      [...expected].sort((a, b) => a.localeCompare(b))
    );
  });

  it('escapes names in XML and returns them unchanged; encoding-type=url percent-encodes them', async () => {
    const plain = await list({ prefix: PREFIX });
    assert.equal(/<Key>[^<]*[&](?!amp;|lt;|gt;|quot;|apos;)/.test(plain.text), false, 'a bare &');
    assert.ok(plain.text.includes('a&amp;b') && plain.text.includes('a&lt;b&gt;'));
    assert.deepEqual(elements(plain.text, 'Prefix'), [PREFIX]);

    const encoded = await list({ prefix: PREFIX, 'encoding-type': 'url' });
    assert.deepEqual(elements(encoded.text, 'EncodingType'), ['url']);
    assert.deepEqual(
      encoded.keys.map(key => decodeURIComponent(key)),
      expected
    );
    for (const key of encoded.keys) assert.match(key, /^[A-Za-z0-9._~!*'()\/%-]+$/, key);
    assert.ok(
      encoded.keys.includes(`${PREFIX}a%252Fb`),
      'a literal %2F in a name is encoded again'
    );
    assert.ok(encoded.keys.includes(`${PREFIX}a/b`), 'a slash stays a slash');
  });

  it('serves each of those names back byte for byte', async () => {
    for (const name of names) {
      const answer = await raw('GET', objectPath(PREFIX + name));
      assert.equal(answer.status, 200, name);
      assert.equal(answer.text, `payload of ${name}`, name);
    }
    // Names that differ only in encoding are different objects.
    assert.equal((await raw('GET', objectPath(`${PREFIX}a/b`))).text, 'payload of a/b');
    assert.equal((await raw('GET', objectPath(`${PREFIX}a%2Fb`))).text, 'payload of a%2Fb');
  });

  it('pages with max-keys and a continuation token: no repeat, no gap, no empty last page', async () => {
    for (const size of [1, 2, 7, names.length - 1, names.length, names.length + 1]) {
      const seen = [];
      let token;
      let pages = 0;
      do {
        const page = await list({
          prefix: PREFIX,
          'max-keys': String(size),
          ...(token ? { 'continuation-token': token } : {})
        });
        assert.ok(page.keys.length <= size, `page of ${page.keys.length} for max-keys ${size}`);
        assert.equal(page.keyCount, String(page.keys.length));
        assert.equal(elements(page.text, 'MaxKeys')[0], String(size));
        assert.equal(page.truncated, page.next ? 'true' : 'false');
        seen.push(...page.keys);
        token = page.next;
        pages += 1;
        assert.ok(pages <= names.length + 1, 'paging does not end');
      } while (token);
      assert.deepEqual(seen, expected, `max-keys ${size}`);
      assert.equal(pages, Math.ceil(names.length / size), `max-keys ${size}`);
    }
  });

  it('honours start-after, alone and together with a continuation token', async () => {
    const middle = expected[8];
    assert.deepEqual(
      (await list({ prefix: PREFIX, 'start-after': middle })).keys,
      expected.slice(9)
    );
    // start-after need not be an existing key.
    assert.deepEqual(
      (await list({ prefix: PREFIX, 'start-after': `${PREFIX}a` })).keys,
      expected.filter(key => byUtf8(key, `${PREFIX}a`) > 0)
    );
    assert.deepEqual(
      (await list({ prefix: PREFIX, 'start-after': `${PREFIX}\u{10ffff}` })).keys,
      []
    );
    const first = await list({ prefix: PREFIX, 'start-after': middle, 'max-keys': '3' });
    assert.deepEqual(first.keys, expected.slice(9, 12));
    const second = await list({
      prefix: PREFIX,
      'start-after': middle,
      'max-keys': '3',
      'continuation-token': first.next
    });
    assert.deepEqual(second.keys, expected.slice(12, 15));
  });

  it('matches a prefix literally and answers an empty listing for none', async () => {
    assert.deepEqual((await list({ prefix: `${PREFIX}a/` })).keys, [`${PREFIX}a/b`]);
    assert.deepEqual((await list({ prefix: `${PREFIX}a%` })).keys, [`${PREFIX}a%2Fb`]);
    const none = await list({ prefix: `${PREFIX}nothing-here` });
    assert.equal(none.status, 200);
    assert.deepEqual(
      [none.keys, none.truncated, none.keyCount, none.next],
      [[], 'false', '0', undefined]
    );
    const zero = await list({ prefix: PREFIX, 'max-keys': '0' });
    assert.deepEqual([zero.keys, zero.truncated], [[], 'false']);
  });

  it('caps a page at 1000 keys whatever max-keys says', async () => {
    const many = `many-${crypto.randomBytes(3).toString('hex')}/`;
    for (let index = 0; index < 1001; index++) {
      s3.rawPut(BUCKET, `${many}${String(index).padStart(4, '0')}`, 'x');
    }
    const first = await list({ prefix: many, 'max-keys': '5000' });
    assert.equal(first.keys.length, 1000);
    assert.equal(first.truncated, 'true');
    assert.equal(elements(first.text, 'MaxKeys')[0], '1000');
    const second = await list({ prefix: many, 'continuation-token': first.next });
    assert.deepEqual(second.keys, [`${many}1000`]);
    assert.equal(second.truncated, 'false');
    assert.equal((await list({ prefix: many })).keys.length, 1000, 'the default page is 1000');
  });

  it('reports the stored size and an MD5 ETag per object', async () => {
    const key = `${PREFIX}a`;
    const page = await list({ prefix: key, 'max-keys': '1' });
    assert.deepEqual(elements(page.text, 'Size'), [String(Buffer.byteLength('payload of a'))]);
    const md5 = crypto.createHash('md5').update('payload of a').digest('hex');
    assert.deepEqual(elements(page.text, 'ETag'), [`"${md5}"`]);
    assert.match(
      elements(page.text, 'LastModified')[0],
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
    );
  });
});

describe('fake S3 server: objects and errors', () => {
  it('answers a missing key with 404 NoSuchKey, a missing bucket with 404 NoSuchBucket, a HEAD with no body', async () => {
    const missing = await raw('GET', objectPath('not-there'));
    assert.equal(missing.status, 404);
    assert.deepEqual(elements(missing.text, 'Code'), ['NoSuchKey']);
    assert.match(missing.headers.get('content-type'), /xml/);

    for (const [method, target] of [
      ['GET', '/no-such-bucket/k'],
      ['PUT', '/no-such-bucket/k'],
      ['DELETE', '/no-such-bucket/k'],
      ['GET', '/no-such-bucket?list-type=2']
    ]) {
      const answer = await raw(method, target, { body: method === 'PUT' ? 'x' : undefined });
      assert.equal(answer.status, 404, `${method} ${target}`);
      assert.deepEqual(elements(answer.text, 'Code'), ['NoSuchBucket'], `${method} ${target}`);
    }
    for (const target of [objectPath('not-there'), '/no-such-bucket/k', '/no-such-bucket']) {
      const head = await raw('HEAD', target);
      assert.equal(head.status, 404, target);
      assert.equal(head.bytes.length, 0, 'a HEAD answer has no body, so no error code');
    }
    assert.equal((await raw('HEAD', `/${BUCKET}`)).status, 200);
  });

  it('answers DeleteObject with 204 whether or not the key existed', async () => {
    await raw('PUT', objectPath('to-delete'), { body: 'x' });
    assert.equal((await raw('DELETE', objectPath('to-delete'))).status, 204);
    assert.equal((await raw('DELETE', objectPath('to-delete'))).status, 204);
    assert.equal((await raw('DELETE', objectPath('never-existed'))).status, 204);
    assert.equal((await raw('GET', objectPath('to-delete'))).status, 404);
  });

  it('never creates, deletes or lists buckets', async () => {
    assert.equal((await raw('PUT', '/brand-new-bucket')).status, 501);
    assert.equal((await raw('DELETE', `/${BUCKET}`)).status, 501);
    assert.equal((await raw('GET', '/')).status, 501);
    assert.equal((await raw('HEAD', '/brand-new-bucket')).status, 404);
    assert.equal((await raw('GET', `/${BUCKET}`)).status, 501, 'ListObjects V1 is not implemented');
  });

  it('stores binary bodies unchanged, overwrites, and serves HEAD and ranges', async () => {
    const data = crypto.randomBytes(70_000);
    const key = objectPath('binary');
    const put = await raw('PUT', key, { body: data });
    assert.equal(put.status, 200);
    assert.equal(
      put.headers.get('etag'),
      `"${crypto.createHash('md5').update(data).digest('hex')}"`
    );
    const get = await raw('GET', key);
    assert.ok(get.bytes.equals(data));
    assert.equal(get.headers.get('content-length'), String(data.length));
    const head = await raw('HEAD', key);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(data.length));
    assert.equal(head.bytes.length, 0);
    const range = await raw('GET', key, { headers: { range: 'bytes=10-19' } });
    assert.equal(range.status, 206);
    assert.ok(range.bytes.equals(data.subarray(10, 20)));
    assert.equal(range.headers.get('content-range'), `bytes 10-19/${data.length}`);

    await raw('PUT', key, { body: '' });
    const empty = await raw('GET', key);
    assert.equal(empty.status, 200);
    assert.equal(empty.bytes.length, 0, 'an empty object is an object');
  });

  it('takes the payload out of an aws-chunked upload', async () => {
    const part = Buffer.from('chunked payload '.repeat(100));
    const frame = chunk =>
      Buffer.concat([
        Buffer.from(`${chunk.length.toString(16)};chunk-signature=${'0'.repeat(64)}\r\n`),
        chunk,
        Buffer.from('\r\n')
      ]);
    const body = Buffer.concat([
      frame(part),
      frame(part.subarray(0, 7)),
      Buffer.from(`0;chunk-signature=${'0'.repeat(64)}\r\nx-amz-checksum-crc32:AAAAAA==\r\n\r\n`)
    ]);
    const answer = await raw('PUT', objectPath('chunked'), {
      body,
      headers: {
        'content-encoding': 'aws-chunked',
        'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
        'x-amz-decoded-content-length': String(part.length + 7)
      }
    });
    assert.equal(answer.status, 200);
    assert.ok(s3.rawGet(BUCKET, 'chunked').equals(Buffer.concat([part, part.subarray(0, 7)])));
  });

  it('keeps objects across a restart when it persists to a directory', async () => {
    const dataDir = path.join(scratch, 'persist');
    const first = await startFakeS3Server({ buckets: [BUCKET], dataDir });
    await raw('PUT', objectPath('dir/kept & <odd>'), { body: 'still here', server: first });
    await raw('PUT', objectPath('dir/removed'), { body: 'x', server: first });
    await raw('DELETE', objectPath('dir/removed'), { server: first });
    await first.close();
    const second = await startFakeS3Server({ buckets: [BUCKET], dataDir });
    try {
      assert.equal(
        (await raw('GET', objectPath('dir/kept & <odd>'), { server: second })).text,
        'still here'
      );
      assert.deepEqual((await list({ prefix: 'dir/' }, { server: second })).keys, [
        'dir/kept & <odd>'
      ]);
    } finally {
      await second.close();
    }
  });
});

describe('fake S3 server: failure injection', () => {
  it('applies a rule to the named operation and key only, for the given number of requests', async () => {
    await raw('PUT', objectPath('inject/a'), { body: 'a' });
    await raw('PUT', objectPath('inject/b'), { body: 'b' });
    const release = s3.inject({
      op: 'GetObject',
      key: 'inject/a',
      status: 503,
      code: 'SlowDown',
      times: 2
    });
    try {
      assert.equal((await raw('GET', objectPath('inject/b'))).status, 200);
      assert.equal((await raw('HEAD', objectPath('inject/a'))).status, 200);
      const refused = await raw('GET', objectPath('inject/a'));
      assert.equal(refused.status, 503);
      assert.deepEqual(elements(refused.text, 'Code'), ['SlowDown']);
      assert.equal((await raw('GET', objectPath('inject/a'))).status, 503);
      assert.equal((await raw('GET', objectPath('inject/a'))).status, 200, 'the rule is used up');
    } finally {
      release();
    }
  });

  it('cuts a body short of its Content-Length, and logs what it was asked', async () => {
    await raw('PUT', objectPath('inject/long'), { body: Buffer.alloc(50_000, 1) });
    s3.clearRequests();
    s3.inject({ op: 'GetObject', truncateBody: 100, times: 1 });
    await assert.rejects(raw('GET', objectPath('inject/long')));
    assert.deepEqual(
      s3.requests.map(request => [request.method, request.op, request.bucket, request.key]),
      [['GET', 'GetObject', BUCKET, 'inject/long']]
    );
    assert.equal((await raw('GET', objectPath('inject/long'))).bytes.length, 50_000);
    s3.clearInjections();
  });
});

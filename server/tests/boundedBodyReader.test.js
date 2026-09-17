#!/usr/bin/env node

/**
 * Unit tests for `server/utils/boundedBodyReader.js`.
 *
 * Run directly with `node server/tests/boundedBodyReader.test.js`.
 */

import { Readable } from 'node:stream';
import { readBoundedBody, MAX_DOWNLOAD_BYTES } from '../utils/boundedBodyReader.js';

let failures = 0;
function check(label, expected, actual) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    console.log(`   expected: ${expected}`);
    console.log(`   actual:   ${actual}`);
  }
}

function mockResponse({ chunks, contentLength }) {
  const headers = new Map();
  if (contentLength !== undefined) {
    headers.set('content-length', String(contentLength));
  }
  return {
    headers: {
      get: k => headers.get(k.toLowerCase()) ?? null
    },
    body: Readable.from(chunks)
  };
}

console.log('🧪 readBoundedBody — under cap\n');
{
  const buf = await readBoundedBody(
    mockResponse({ chunks: [Buffer.from('hello '), Buffer.from('world')] }),
    1024,
    'test'
  );
  check('returns a Buffer', true, Buffer.isBuffer(buf));
  check('concatenates chunks', 'hello world', buf.toString('utf8'));
}

console.log('\n🧪 readBoundedBody — exact cap\n');
{
  const payload = Buffer.alloc(10, 0x41); // 10 bytes of 'A'
  const buf = await readBoundedBody(mockResponse({ chunks: [payload] }), 10, 'test');
  check('exact-cap body is returned in full', 10, buf.length);
}

console.log('\n🧪 readBoundedBody — Content-Length pre-check\n');
{
  let thrown = null;
  try {
    await readBoundedBody(
      mockResponse({ chunks: [Buffer.from('whatever')], contentLength: 999_999_999 }),
      1024,
      'big upstream'
    );
  } catch (e) {
    thrown = e;
  }
  check('throws when Content-Length > cap', true, !!thrown);
  check(
    'error message includes label and limit',
    true,
    !!thrown && thrown.message.includes('big upstream') && thrown.message.includes('1024')
  );
}

console.log('\n🧪 readBoundedBody — mid-stream cap (no Content-Length)\n');
{
  // 3 chunks of 5 bytes = 15 total; cap at 12 → must throw mid-stream.
  const chunks = [Buffer.alloc(5, 0x42), Buffer.alloc(5, 0x42), Buffer.alloc(5, 0x42)];
  let thrown = null;
  try {
    await readBoundedBody(mockResponse({ chunks }), 12, 'mid-stream test');
  } catch (e) {
    thrown = e;
  }
  check('throws when running total exceeds cap', true, !!thrown);
}

console.log('\n🧪 readBoundedBody — missing Content-Length, under cap\n');
{
  const buf = await readBoundedBody(
    mockResponse({ chunks: [Buffer.from('abc'), Buffer.from('def')] }),
    100,
    'test'
  );
  check('no Content-Length still works', 'abcdef', buf.toString('utf8'));
}

console.log('\n🧪 MAX_DOWNLOAD_BYTES default\n');
check('default download cap is 200 MiB', 200 * 1024 * 1024, MAX_DOWNLOAD_BYTES);

console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);

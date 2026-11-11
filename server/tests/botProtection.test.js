// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  classifyBlockedResponse,
  detectBotProtection,
  readBodyPrefix
} from '../services/pageReader/botProtection.js';

const headers = map => {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: name => lower[name.toLowerCase()] ?? null };
};

describe('detectBotProtection', () => {
  it('names each supported vendor', () => {
    const cases = [
      ['Akamai', { server: 'AkamaiGHost' }, ''],
      ['Akamai', {}, '<link href="/WAFfailoverassets/style.css">'],
      ['Cloudflare', { 'cf-mitigated': 'challenge' }, ''],
      ['Cloudflare', { server: 'cloudflare' }, '<title>Attention Required! | Cloudflare</title>'],
      ['Imperva', { 'x-iinfo': '1-2-3' }, ''],
      ['Imperva', {}, 'Request unsuccessful. Incapsula incident ID: 123-456'],
      ['DataDome', { 'x-datadome': 'protected' }, ''],
      ['DataDome', {}, '<script src="https://geo.captcha-delivery.com/c.js">'],
      ['PerimeterX', { 'set-cookie': '_pxhd=abc; Path=/' }, ''],
      ['PerimeterX', {}, '<div id="px-captcha"></div>'],
      ['Sucuri', { 'x-sucuri-id': '12345' }, '']
    ];
    for (const [vendor, hdrs, body] of cases) {
      const found = detectBotProtection({ status: 403, headers: headers(hdrs), body });
      assert.equal(found?.vendor, vendor, `${vendor}: ${JSON.stringify(hdrs)} ${body}`);
    }
  });

  it('extracts the reference id', () => {
    const akamai = detectBotProtection({
      status: 403,
      headers: headers({ server: 'AkamaiGHost' }),
      body: 'Access Denied ... Reference #18.2d351ab8.1557333295.a4e16ab'
    });
    assert.equal(akamai.reference, '18.2d351ab8.1557333295.a4e16ab');
  });

  it('does not flag a CDN header alone, a plain site, or a non-block status', () => {
    assert.equal(
      detectBotProtection({
        status: 403,
        headers: headers({ server: 'cloudflare' }),
        body: 'Forbidden'
      }),
      null
    );
    assert.equal(
      detectBotProtection({
        status: 403,
        headers: headers({ server: 'nginx' }),
        body: 'Forbidden'
      }),
      null
    );
    assert.equal(
      detectBotProtection({ status: 404, headers: headers({ server: 'AkamaiGHost' }), body: '' }),
      null
    );
  });
});

describe('classifyBlockedResponse', () => {
  it('reads a streamed body only up to the prefix', async () => {
    let cancelled = false;
    let reads = 0;
    const response = {
      status: 403,
      headers: headers({ server: 'nginx' }),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: new TextEncoder().encode('x'.repeat(3000)) };
          },
          cancel: async () => {
            cancelled = true;
          }
        })
      }
    };
    const text = await readBodyPrefix(response);
    assert.equal(text.length, 4096);
    assert.equal(cancelled, true);
    assert.equal(reads, 2);
  });

  it('reads a Node stream body (node-fetch) only up to the prefix, then destroys it', async () => {
    // What the page reader's HTTP client returns: no getReader, no text() call wanted.
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < 1000; i += 1) yield Buffer.from('x'.repeat(1000));
      })()
    );
    let textCalled = false;
    const response = {
      status: 403,
      headers: headers({ server: 'nginx' }),
      body,
      text: async () => {
        textCalled = true;
        return 'x'.repeat(1_000_000);
      }
    };
    const text = await readBodyPrefix(response);
    assert.equal(text.length, 4096);
    assert.equal(textCalled, false);
    assert.equal(body.destroyed, true);
  });

  it('stops waiting for a body that stalls and keeps what arrived', async () => {
    const body = Readable.from(
      (async function* () {
        yield Buffer.from('partial ');
        await new Promise(resolve => setTimeout(resolve, 500));
        yield Buffer.from('never read');
      })()
    );
    const started = Date.now();
    const text = await readBodyPrefix(
      { status: 403, headers: headers({}), body },
      { timeoutMs: 50 }
    );
    assert.equal(text, 'partial ');
    assert.ok(Date.now() - started < 400);
    assert.equal(body.destroyed, true);
  });

  it('returns null for a plain 429, and ACCESS_DENIED for a plain 403', async () => {
    assert.equal(
      await classifyBlockedResponse(
        { status: 429, headers: headers({}), text: async () => '' },
        'https://a.example/'
      ),
      null
    );
    const denied = await classifyBlockedResponse(
      { status: 403, headers: headers({}), text: async () => '' },
      'https://a.example/x'
    );
    assert.equal(denied.code, 'ACCESS_DENIED');
    assert.equal(denied.host, 'a.example');
  });
});

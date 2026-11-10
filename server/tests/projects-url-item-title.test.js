// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A URL item added without a name is named by its page's title; every URL
 * item records the page's title and description (#3539).
 */
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { urlKind } from '../services/projects/kinds/linkKinds.js';

describe('URL item name', () => {
  let server;
  let base;
  let previousPlatform;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>7. Ziele &amp; Bonus</title></head><body><p>Goals.</p></body></html>'
      );
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    previousPlatform = configCache.getPlatform();
    // The page reader's SSRF guard lets a whitelisted host through.
    configCache.setCacheEntry('config/platform.json', {
      ...previousPlatform,
      ssl: { domainWhitelist: ['127.0.0.1'] }
    });
  });

  after(async () => {
    configCache.setCacheEntry('config/platform.json', previousPlatform || {});
    await new Promise(resolve => server.close(resolve));
  });

  it("takes the page's title as its name and what it is about", async () => {
    const prepared = await urlKind.prepare({ url: `${base}/title` }, {});
    assert.equal(prepared.name, '7. Ziele & Bonus');
    assert.equal(prepared.info.title, '7. Ziele & Bonus');
  });

  it('keeps a name the caller gave and still records the page title', async () => {
    const prepared = await urlKind.prepare({ url: `${base}/named` }, { name: 'Mine' });
    assert.equal(prepared.name, undefined);
    assert.equal(prepared.info.title, '7. Ziele & Bonus');
  });

  it('adds a page that cannot be read under its URL', async () => {
    assert.equal(await urlKind.prepare({ url: 'http://10.255.255.1/x' }, {}), null);
  });
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A URL item added without a name is named by its page's title.
 */
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { urlKind } from '../services/projects/kinds/linkKinds.js';

describe('URL item name', () => {
  let server;
  let base;
  let requests = 0;
  let previousPlatform;

  before(async () => {
    server = http.createServer((req, res) => {
      requests++;
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

  it("takes the page's title", async () => {
    assert.deepEqual(await urlKind.prepare({ url: `${base}/title` }, {}), {
      name: '7. Ziele & Bonus'
    });
  });

  it('keeps a name the caller gave, without fetching', async () => {
    const before = requests;
    assert.equal(await urlKind.prepare({ url: `${base}/named` }, { name: 'Mine' }), null);
    assert.equal(requests, before);
  });

  it('adds a page that cannot be read under its URL', async () => {
    assert.equal(await urlKind.prepare({ url: 'http://10.255.255.1/x' }, {}), null);
  });
});

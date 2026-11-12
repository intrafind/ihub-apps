// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A URL item added without a name is named by its page's title; every URL
 * item records the page's title and description (#3539). Since web pages are
 * stored snapshots (#3622), the check on add hands the page it read to the
 * ingest job (`prefetched`), and the title comes from the extraction.
 */
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { urlKind } from '../services/projects/kinds/linkKinds.js';
import { extractText } from '../services/projects/extractText.js';

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
    assert.equal(prepared.nameFromTitle, true);
    assert.equal(prepared.prefetched.contentType, 'text/html');
    const extracted = await extractText({
      bytes: prepared.prefetched.bytes,
      contentType: prepared.prefetched.contentType,
      name: 'title'
    });
    assert.equal(extracted.title, '7. Ziele & Bonus');
  });

  it('keeps a name the caller gave and still hands the page on', async () => {
    const prepared = await urlKind.prepare({ url: `${base}/named` }, { name: 'Mine' });
    assert.equal(prepared.nameFromTitle, undefined);
    assert.ok(prepared.prefetched.bytes.length > 0);
  });

  it('adds a page that cannot be read now; its ingest job fetches it', async () => {
    const prepared = await urlKind.prepare({ url: 'http://10.255.255.1/x' }, {});
    assert.deepEqual(prepared, { nameFromTitle: true });
  });
});

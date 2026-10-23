// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The site crawler of the project URL picker: it stays on the start page's
 * site (and folder), lists documents without crawling them, drops dead links
 * and duplicate redirects, and stops at its page, depth and time bounds.
 */
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  crawlScope,
  crawlSite,
  extractPageLinks,
  inCrawlScope,
  linkTypeOf,
  normalizeCrawlUrl,
  readBoundedText
} from '../services/projects/siteCrawler.js';

const page = (title, hrefs) =>
  `<html><head><title>${title}</title></head><body>${hrefs
    .map(href => `<a href="${href}">link</a>`)
    .join('')}</body></html>`;

/** A fake site: `{ url: html | {redirect} | {status} | {contentType} }`. */
function fakeSite(pages) {
  const fetched = [];
  const fetchPage = async url => {
    fetched.push(url);
    const entry = pages[url];
    if (entry === undefined || entry.status) throw new Error(`HTTP ${entry?.status || 404}`);
    if (entry.redirect) {
      const target = pages[entry.redirect];
      return { finalUrl: entry.redirect, contentType: 'text/html', html: target };
    }
    if (entry.contentType) return { finalUrl: url, contentType: entry.contentType, html: null };
    return { finalUrl: url, contentType: 'text/html; charset=utf-8', html: entry };
  };
  return { fetchPage, fetched };
}

describe('site crawler helpers', () => {
  it('normalizes links to absolute http(s) URLs without fragments', () => {
    assert.equal(normalizeCrawlUrl('b#top', 'https://x.com/a/'), 'https://x.com/a/b');
    assert.equal(normalizeCrawlUrl('mailto:a@x.com', 'https://x.com/'), null);
    assert.equal(normalizeCrawlUrl('javascript:void(0)', 'https://x.com/'), null);
    assert.equal(normalizeCrawlUrl('https://u:p@x.com/a'), 'https://x.com/a');
  });

  it('keeps a crawl below the start folder', () => {
    const file = crawlScope('https://x.com/docs/intro.html');
    assert.deepEqual(file, { origin: 'https://x.com', path: '/docs/' });
    assert.ok(inCrawlScope('https://x.com/docs/a/b', file));
    assert.ok(!inCrawlScope('https://x.com/blog/', file));
    assert.ok(!inCrawlScope('https://other.com/docs/a', file));

    const folder = crawlScope('https://x.com/docs');
    assert.ok(inCrawlScope('https://x.com/docs', folder));
    assert.ok(inCrawlScope('https://x.com/docs/a', folder));
    assert.ok(!inCrawlScope('https://x.com/docsearch', folder));

    const site = crawlScope('https://x.com/docs/intro.html', { samePath: false });
    assert.ok(inCrawlScope('https://x.com/blog/', site));
    assert.ok(!inCrawlScope('http://x.com/blog/', site));
  });

  it('tells pages, documents and assets apart', () => {
    assert.equal(linkTypeOf('https://x.com/a'), 'page');
    assert.equal(linkTypeOf('https://x.com/a.html'), 'page');
    assert.equal(linkTypeOf('https://x.com/a.PDF'), 'document');
    assert.equal(linkTypeOf('https://x.com/logo.png'), null);
    assert.equal(linkTypeOf('https://x.com/app.js?v=1'), null);
  });

  it('reads the title and links of a page, honoring <base> and nofollow', () => {
    const html = `<html><head><title> Home
      page </title><base href="https://x.com/docs/"></head><body>
      <a href="a">A</a><a href="a#x">A again</a><a href="/b" rel="nofollow">B</a>
      <script>document.write('<a href="c">C</a>')</script></body></html>`;
    const { title, links } = extractPageLinks(html, 'https://x.com/');
    assert.equal(title, 'Home page');
    assert.deepEqual(links, ['https://x.com/docs/a']);
  });

  it('reads a body up to a bound and drops the rest', async () => {
    let destroyed = false;
    const endless = new Readable({
      read() {
        this.push(Buffer.from('a'.repeat(1024)));
      },
      destroy(error, cb) {
        destroyed = true;
        cb(error);
      }
    });
    const text = await readBoundedText(endless, { maxBytes: 4096, timeoutMs: 1000 });
    assert.equal(text.length, 4096);
    assert.ok(destroyed);
  });
});

describe('crawlSite', () => {
  it('lists the pages of a site breadth first, with documents and without dead links', async () => {
    const { fetchPage, fetched } = fakeSite({
      'https://x.com/docs/': page('Docs', [
        'intro',
        'guide/',
        'manual.pdf',
        'logo.png',
        'missing',
        'https://other.com/docs/',
        '/blog/'
      ]),
      'https://x.com/docs/intro': page('Intro', ['guide/', 'guide/deep']),
      'https://x.com/docs/guide/': page('Guide', ['deep']),
      'https://x.com/docs/guide/deep': page('Deep', ['deeper']),
      'https://x.com/docs/guide/deeper': page('Deeper', [])
    });
    const result = await crawlSite({ url: 'https://x.com/docs/', maxDepth: 2 }, { fetchPage });
    assert.deepEqual(
      result.pages.map(entry => [entry.url, entry.title, entry.depth, entry.type]),
      [
        ['https://x.com/docs/', 'Docs', 0, 'page'],
        ['https://x.com/docs/intro', 'Intro', 1, 'page'],
        ['https://x.com/docs/guide/', 'Guide', 1, 'page'],
        ['https://x.com/docs/manual.pdf', 'manual.pdf', 1, 'document'],
        ['https://x.com/docs/guide/deep', 'Deep', 2, 'page']
      ]
    );
    assert.equal(result.truncated, false);
    // Off-site, out-of-folder, asset and document links are never fetched,
    // and the links of a page at depth 2 are not followed.
    assert.deepEqual(fetched, [
      'https://x.com/docs/',
      'https://x.com/docs/intro',
      'https://x.com/docs/guide/',
      'https://x.com/docs/missing',
      'https://x.com/docs/guide/deep'
    ]);
  });

  it('stops at the page limit and says so', async () => {
    const links = Array.from({ length: 20 }, (_, index) => `p${index}`);
    const pages = { 'https://x.com/': page('Home', links) };
    for (const link of links) pages[`https://x.com/${link}`] = page(link, []);
    const { fetchPage, fetched } = fakeSite(pages);
    const result = await crawlSite({ url: 'https://x.com/', maxPages: 5 }, { fetchPage });
    assert.equal(result.pages.length, 5);
    assert.equal(result.truncated, true);
    assert.equal(fetched.length, 5);
  });

  it('gives the slot of a dead link to the next one', async () => {
    const { fetchPage } = fakeSite({
      'https://x.com/': page('Home', ['dead', 'a']),
      'https://x.com/a': page('A', ['b']),
      'https://x.com/b': page('B', [])
    });
    const result = await crawlSite({ url: 'https://x.com/', maxPages: 3 }, { fetchPage });
    assert.deepEqual(
      result.pages.map(entry => entry.url),
      ['https://x.com/', 'https://x.com/a', 'https://x.com/b']
    );
  });

  it('lists a page once when another link redirects onto it', async () => {
    const { fetchPage } = fakeSite({
      'https://x.com/': page('Home', ['a', 'old-a', 'gone']),
      'https://x.com/a': page('A', []),
      'https://x.com/old-a': { redirect: 'https://x.com/a' },
      'https://x.com/gone': { redirect: 'https://other.com/' },
      'https://other.com/': page('Other', [])
    });
    const result = await crawlSite({ url: 'https://x.com/' }, { fetchPage });
    assert.deepEqual(
      result.pages.map(entry => entry.url),
      ['https://x.com/', 'https://x.com/a']
    );
  });

  it('lists only the start page at depth 0', async () => {
    const { fetchPage, fetched } = fakeSite({ 'https://x.com/': page('Home', ['a']) });
    const result = await crawlSite({ url: 'https://x.com/', maxDepth: 0 }, { fetchPage });
    assert.deepEqual(
      result.pages.map(entry => entry.url),
      ['https://x.com/']
    );
    assert.deepEqual(fetched, ['https://x.com/']);
  });

  it('stops at the deadline', async () => {
    let clock = 0;
    const { fetchPage } = fakeSite({
      'https://x.com/': page('Home', ['a', 'b']),
      'https://x.com/a': page('A', []),
      'https://x.com/b': page('B', [])
    });
    const slow = async url => {
      clock += 1000;
      return fetchPage(url);
    };
    const result = await crawlSite(
      { url: 'https://x.com/' },
      { fetchPage: slow, now: () => clock, deadlineMs: 500 }
    );
    assert.equal(result.pages.length, 1);
    assert.equal(result.truncated, true);
  });

  it('fails when the start page cannot be read', async () => {
    const { fetchPage } = fakeSite({});
    await assert.rejects(crawlSite({ url: 'https://x.com/' }, { fetchPage }), /HTTP 404/);
    await assert.rejects(crawlSite({ url: 'ftp://x.com/' }, { fetchPage }), /http\(s\)/);
  });

  it('lists a start URL that serves a PDF as one document', async () => {
    const { fetchPage } = fakeSite({ 'https://x.com/file': { contentType: 'application/pdf' } });
    const result = await crawlSite({ url: 'https://x.com/file' }, { fetchPage });
    assert.deepEqual(result.pages, [
      { url: 'https://x.com/file', title: 'file', depth: 0, type: 'document' }
    ]);
  });
});

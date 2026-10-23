// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The site crawler of the project URL picker: it stays on the start page's
 * site (and folder) as read after redirects, honors robots.txt, lists
 * documents without crawling them, drops dead links and duplicate redirects,
 * and stops at its page, depth and time bounds.
 */
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  crawlScope,
  crawlSite,
  decodeHtml,
  extractPageLinks,
  inCrawlScope,
  linkTypeOf,
  normalizeCrawlUrl,
  parseRobotsTxt,
  readBoundedBytes,
  robotsAllows
} from '../services/projects/siteCrawler.js';
import { dropRawTextElements } from '../tools/lib/pageContent.js';

const page = (title, hrefs) =>
  `<html><head><title>${title}</title></head><body>${hrefs
    .map(href => `<a href="${href}">link</a>`)
    .join('')}</body></html>`;

/**
 * A fake site: `{ url: html | {redirect} | {status} | {contentType} }`, and
 * `robots` for its robots.txt.
 */
function fakeSite(pages, { robots = null } = {}) {
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
  const fetchRobots = async () => robots;
  return { deps: { fetchPage, fetchRobots }, fetched };
}

const urlsOf = result => result.pages.map(entry => entry.url);

describe('site crawler helpers', () => {
  it('normalizes links to absolute http(s) URLs without fragments, sessions or tracking', () => {
    assert.equal(normalizeCrawlUrl('b#top', 'https://x.com/a/'), 'https://x.com/a/b');
    assert.equal(normalizeCrawlUrl('mailto:a@x.com', 'https://x.com/'), null);
    assert.equal(normalizeCrawlUrl('javascript:void(0)', 'https://x.com/'), null);
    assert.equal(normalizeCrawlUrl('https://u:p@x.com/a'), 'https://x.com/a');
    assert.equal(
      normalizeCrawlUrl('https://x.com/a?utm_source=x&id=2&fbclid=1&PHPSESSID=3'),
      'https://x.com/a?id=2'
    );
    assert.equal(normalizeCrawlUrl('https://x.com/a;jsessionid=AB12?x=1'), 'https://x.com/a?x=1');
  });

  it('keeps a crawl below the start folder', () => {
    const file = crawlScope('https://x.com/docs/intro.html');
    assert.deepEqual(file, { origin: 'https://x.com', path: '/docs/' });
    assert.ok(inCrawlScope('https://x.com/docs/a/b', file));
    assert.ok(!inCrawlScope('https://x.com/blog/', file));
    assert.ok(!inCrawlScope('https://other.com/docs/a', file));

    const folder = crawlScope('https://x.com/docs/');
    assert.deepEqual(folder, { origin: 'https://x.com', path: '/docs/' });

    const site = crawlScope('https://x.com/docs/intro.html', { samePath: false });
    assert.ok(inCrawlScope('https://x.com/blog/', site));
    assert.ok(!inCrawlScope('http://x.com/blog/', site));
  });

  it('takes an address without a slash as a folder only when the page links below it', () => {
    const docs = crawlScope('https://x.com/docs', { links: ['https://x.com/docs/intro'] });
    assert.deepEqual(docs, { origin: 'https://x.com', path: '/docs' });
    assert.ok(inCrawlScope('https://x.com/docs/a', docs));
    assert.ok(!inCrawlScope('https://x.com/docsearch', docs));

    // A page such as a blog post: its folder.
    const post = crawlScope('https://x.com/blog/my-post', { links: ['https://x.com/blog/other'] });
    assert.deepEqual(post, { origin: 'https://x.com', path: '/blog/' });

    // A dot in a folder name is not taken for a file.
    const version = crawlScope('https://x.com/v1.2', { links: ['https://x.com/v1.2/setup'] });
    assert.deepEqual(version, { origin: 'https://x.com', path: '/v1.2' });
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

  it('drops script and style elements in linear time', () => {
    assert.equal(
      dropRawTextElements('a<SCRIPT type="x">b</script >c<style>d</style>e', ['script', 'style']),
      'ace'
    );
    // An element left open runs to the end, as in the HTML parser.
    assert.equal(dropRawTextElements('a<script>b<a href="c">', ['script']), 'a');
    // `<scripts>` is not a script element.
    assert.equal(dropRawTextElements('<scripts>a</scripts>', ['script']), '<scripts>a</scripts>');

    // A page of unclosed openers took minutes with the former regex.
    const hostile = '<script>'.repeat(256 * 1024);
    const started = Date.now();
    dropRawTextElements(`<style>${hostile}`, ['script', 'style']);
    dropRawTextElements(hostile, ['script', 'style']);
    dropRawTextElements('<script '.repeat(256 * 1024), ['script', 'style']);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
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
    const bytes = await readBoundedBytes(endless, { maxBytes: 4096, timeoutMs: 1000 });
    assert.equal(bytes.length, 4096);
    assert.ok(destroyed);
  });

  it('decodes a page in the charset it declares', () => {
    const latin1 = Buffer.from('<title>Über uns – Größe</title>', 'latin1');
    // The en dash is not in Latin-1; Windows-1252 has it at 0x96.
    latin1[latin1.indexOf(0x13)] = 0x96;
    assert.equal(
      decodeHtml(latin1, 'text/html; charset=windows-1252'),
      '<title>Über uns – Größe</title>'
    );
    const meta = Buffer.from('<meta charset="iso-8859-1"><title>Größe</title>', 'latin1');
    assert.equal(decodeHtml(meta, 'text/html'), '<meta charset="iso-8859-1"><title>Größe</title>');
    // Undeclared and not UTF-8: Windows-1252.
    assert.equal(decodeHtml(Buffer.from('Größe', 'latin1'), 'text/html'), 'Größe');
    // A UTF-8 character cut by the byte limit is dropped, not the whole page.
    const cut = Buffer.from('Größe', 'utf8').subarray(0, 3);
    assert.equal(decodeHtml(cut, 'text/html'), 'Gr');
  });

  it('reads the robots.txt rules for every crawler', () => {
    const rules = parseRobotsTxt(
      [
        'User-agent: Googlebot',
        'Disallow: /',
        '',
        'User-agent: other',
        'User-agent: *',
        'Disallow: /private/ # comment',
        'Allow: /private/open',
        'Disallow: /*.cgi$',
        'Disallow: /search?*q=',
        'Disallow:'
      ].join('\r\n')
    );
    assert.equal(rules.length, 4);
    assert.ok(robotsAllows('https://x.com/docs/', rules));
    assert.ok(!robotsAllows('https://x.com/private/a', rules));
    assert.ok(robotsAllows('https://x.com/private/open/a', rules));
    assert.ok(!robotsAllows('https://x.com/run.cgi', rules));
    assert.ok(robotsAllows('https://x.com/run.cgi.html', rules));
    assert.ok(!robotsAllows('https://x.com/search?lang=de&q=x', rules));
    assert.ok(robotsAllows('https://x.com/any', parseRobotsTxt(null)));
  });

  it('matches robots.txt wildcards without blowing up', () => {
    const rules = [{ allow: false, pattern: `/${'*a'.repeat(200)}b` }];
    const started = Date.now();
    assert.ok(robotsAllows(`https://x.com/${'a'.repeat(2000)}`, rules));
    assert.ok(Date.now() - started < 1000);
  });
});

describe('crawlSite', () => {
  it('lists the pages of a site breadth first, with documents and without dead links', async () => {
    const { deps, fetched } = fakeSite({
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
    const result = await crawlSite({ url: 'https://x.com/docs/', maxDepth: 2 }, deps);
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
    // Off-site, out-of-folder, asset and document links are never fetched.
    const fetchedSet = new Set(fetched);
    for (const url of [
      'https://other.com/docs/',
      'https://x.com/blog/',
      'https://x.com/docs/logo.png',
      'https://x.com/docs/manual.pdf',
      // Depth 2 is listed, but its links are not followed.
      'https://x.com/docs/guide/deeper'
    ]) {
      assert.ok(!fetchedSet.has(url), url);
    }
  });

  it('crawls the site the start page redirects to', async () => {
    const { deps } = fakeSite({
      'https://example.com/': { redirect: 'https://www.example.com/' },
      'https://www.example.com/': page('Home', ['/a', 'https://example.com/b']),
      'https://www.example.com/a': page('A', [])
    });
    const result = await crawlSite({ url: 'https://example.com' }, deps);
    assert.deepEqual(urlsOf(result), ['https://www.example.com/', 'https://www.example.com/a']);
    assert.equal(result.scope.origin, 'https://www.example.com');

    const insecure = fakeSite({
      'http://x.com/docs/': { redirect: 'https://x.com/de/docs/' },
      'https://x.com/de/docs/': page('Docs', ['intro']),
      'https://x.com/de/docs/intro': page('Intro', [])
    });
    const second = await crawlSite({ url: 'http://x.com/docs/' }, insecure.deps);
    assert.deepEqual(urlsOf(second), ['https://x.com/de/docs/', 'https://x.com/de/docs/intro']);
  });

  it('stays in the folder of a start page that is not a folder', async () => {
    const { deps } = fakeSite({
      'https://x.com/blog/post': page('Post', ['other', '/about']),
      'https://x.com/blog/other': page('Other', [])
    });
    const result = await crawlSite({ url: 'https://x.com/blog/post' }, deps);
    assert.deepEqual(urlsOf(result), ['https://x.com/blog/post', 'https://x.com/blog/other']);
  });

  it('stops at the page limit and says so', async () => {
    const links = Array.from({ length: 20 }, (_, index) => `p${index}`);
    const pages = { 'https://x.com/': page('Home', links) };
    for (const link of links) pages[`https://x.com/${link}`] = page(link, []);
    const { deps, fetched } = fakeSite(pages);
    const result = await crawlSite({ url: 'https://x.com/', maxPages: 5 }, deps);
    assert.equal(result.pages.length, 5);
    assert.equal(result.truncated, true);
    assert.equal(fetched.length, 5);
  });

  it('gives the slot of a dead link to the next one', async () => {
    const { deps } = fakeSite({
      'https://x.com/': page('Home', ['dead', 'a']),
      'https://x.com/a': page('A', ['b']),
      'https://x.com/b': page('B', [])
    });
    const result = await crawlSite({ url: 'https://x.com/', maxPages: 3 }, deps);
    assert.deepEqual(urlsOf(result), ['https://x.com/', 'https://x.com/a', 'https://x.com/b']);
  });

  it('gives the slots of dead links to later links on the same level', async () => {
    const { deps } = fakeSite({
      'https://x.com/': page('Home', ['d1', 'd2', 'a', 'b', 'c', 'e']),
      'https://x.com/a': page('A', []),
      'https://x.com/b': page('B', []),
      'https://x.com/c': page('C', []),
      'https://x.com/e': page('E', [])
    });
    const result = await crawlSite({ url: 'https://x.com/', maxPages: 4 }, deps);
    assert.deepEqual(urlsOf(result), [
      'https://x.com/',
      'https://x.com/a',
      'https://x.com/b',
      'https://x.com/c'
    ]);
    assert.equal(result.truncated, true);
  });

  it('lists a page once when another link redirects onto it', async () => {
    const { deps } = fakeSite({
      'https://x.com/': page('Home', ['a', 'old-a', 'gone']),
      'https://x.com/a': page('A', []),
      'https://x.com/old-a': { redirect: 'https://x.com/a' },
      'https://x.com/gone': { redirect: 'https://other.com/' },
      'https://other.com/': page('Other', [])
    });
    const result = await crawlSite({ url: 'https://x.com/' }, deps);
    assert.deepEqual(urlsOf(result), ['https://x.com/', 'https://x.com/a']);
  });

  it('lists a redirect target once when the redirect comes first', async () => {
    const { deps, fetched } = fakeSite({
      'https://x.com/': page('Home', ['old', 'new', 'a', 'a/', 'b']),
      'https://x.com/old': { redirect: 'https://x.com/new' },
      'https://x.com/new': page('New', []),
      'https://x.com/a': { redirect: 'https://x.com/a/' },
      'https://x.com/a/': page('A', []),
      'https://x.com/b': page('B', ['../new2']),
      'https://x.com/old2': { redirect: 'https://x.com/new2' },
      'https://x.com/new2': page('New 2', ['old2'])
    });
    const result = await crawlSite({ url: 'https://x.com/', maxDepth: 3 }, deps);
    assert.deepEqual(urlsOf(result), [
      'https://x.com/',
      'https://x.com/new',
      'https://x.com/a/',
      'https://x.com/b',
      'https://x.com/new2'
    ]);
    // A page listed after a redirect is not fetched again from a later level.
    assert.equal(fetched.filter(url => url === 'https://x.com/new2').length, 1);
  });

  it('lists a few query variants of a path, not a calendar of them', async () => {
    const links = Array.from({ length: 30 }, (_, index) => `events?page=${index}`);
    const pages = { 'https://x.com/': page('Home', [...links, 'docs']) };
    for (const link of links) pages[`https://x.com/${link}`] = page('Events', []);
    pages['https://x.com/docs'] = page('Docs', []);
    const { deps } = fakeSite(pages);
    const result = await crawlSite({ url: 'https://x.com/', maxPages: 10 }, deps);
    assert.deepEqual(urlsOf(result), [
      'https://x.com/',
      'https://x.com/events?page=0',
      'https://x.com/events?page=1',
      'https://x.com/events?page=2',
      'https://x.com/docs'
    ]);
  });

  it('does not follow links robots.txt disallows', async () => {
    const { deps, fetched } = fakeSite(
      {
        'https://x.com/': page('Home', ['a', 'private/b', 'private/c.pdf']),
        'https://x.com/a': page('A', []),
        'https://x.com/private/b': page('B', [])
      },
      { robots: 'User-agent: *\nDisallow: /private/' }
    );
    const result = await crawlSite({ url: 'https://x.com/' }, deps);
    assert.deepEqual(urlsOf(result), ['https://x.com/', 'https://x.com/a']);
    assert.equal(result.robotsExcluded, 2);
    assert.ok(!new Set(fetched).has('https://x.com/private/b'));
  });

  it('lists only the start page at depth 0', async () => {
    const { deps, fetched } = fakeSite({ 'https://x.com/': page('Home', ['a']) });
    const result = await crawlSite({ url: 'https://x.com/', maxDepth: 0 }, deps);
    assert.deepEqual(urlsOf(result), ['https://x.com/']);
    assert.deepEqual(fetched, ['https://x.com/']);
  });

  it('stops at the deadline', async () => {
    let clock = 0;
    const { deps } = fakeSite({
      'https://x.com/': page('Home', ['a', 'b']),
      'https://x.com/a': page('A', []),
      'https://x.com/b': page('B', [])
    });
    const slow = async (url, options) => {
      clock += 1000;
      return deps.fetchPage(url, options);
    };
    const result = await crawlSite(
      { url: 'https://x.com/' },
      { ...deps, fetchPage: slow, now: () => clock, deadlineMs: 500 }
    );
    assert.equal(result.pages.length, 1);
    assert.equal(result.truncated, true);
  });

  it('cancels the fetches still running at the deadline', async () => {
    const { deps } = fakeSite({ 'https://x.com/': page('Home', ['hang']) });
    const hanging = async (url, options) => {
      if (url !== 'https://x.com/hang') return deps.fetchPage(url, options);
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const started = Date.now();
    const result = await crawlSite(
      { url: 'https://x.com/' },
      { ...deps, fetchPage: hanging, deadlineMs: 100 }
    );
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(urlsOf(result), ['https://x.com/']);
  });

  it('stops when the caller gives up', async () => {
    const controller = new AbortController();
    const { deps } = fakeSite({ 'https://x.com/': page('Home', ['a']) });
    const fetchPage = async (url, options) => {
      controller.abort();
      return deps.fetchPage(url, options);
    };
    const result = await crawlSite(
      { url: 'https://x.com/', signal: controller.signal },
      { ...deps, fetchPage }
    );
    assert.deepEqual(urlsOf(result), ['https://x.com/']);
    assert.equal(result.truncated, true);
  });

  it('fails when the start page cannot be read', async () => {
    const { deps } = fakeSite({});
    await assert.rejects(crawlSite({ url: 'https://x.com/' }, deps), /HTTP 404/);
    await assert.rejects(crawlSite({ url: 'ftp://x.com/' }, deps), /http\(s\)/);
  });

  it('lists a start URL that serves a PDF as one document', async () => {
    const { deps } = fakeSite({ 'https://x.com/file': { contentType: 'application/pdf' } });
    const result = await crawlSite({ url: 'https://x.com/file' }, deps);
    assert.deepEqual(result.pages, [
      { url: 'https://x.com/file', title: 'file', depth: 0, type: 'document' }
    ]);
  });
});

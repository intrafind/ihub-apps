// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The website corpus sizer: the extraction of a page's main text, the sitemap
 * reader, the numbers and the report, and the service that ties them to a
 * store (here an in-memory one) and a fetcher (here a fake site).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens, tokenizerInfo } from '../../shared/tokenEstimator.js';

import { extractPage, outlinePage, validateSelector } from '../services/websiteCorpus/extract.js';
import {
  parseSitemap,
  sitemapsFromRobots,
  collectSiteUrls
} from '../services/websiteCorpus/sitemap.js';
import {
  normalizePrefix,
  sectionCounts,
  sectionOf,
  onSite
} from '../services/websiteCorpus/urls.js';
import { analyseCorpus, findNearDuplicates, windowFit } from '../services/websiteCorpus/stats.js';
import { renderReport } from '../services/websiteCorpus/report.js';
import {
  CorpusStore,
  MAX_CORPORA_PER_USER,
  RETENTION_DAYS
} from '../services/websiteCorpus/CorpusStore.js';
import {
  WebsiteCorpusService,
  tokenizerNote
} from '../services/websiteCorpus/WebsiteCorpusService.js';

const words = n => Array.from({ length: n }, (_v, i) => `wort${i % 17}`).join(' ');
const page = (title, body, extra = '') =>
  `<html><head><title>${title}</title></head><body><nav><a>Menü</a></nav><main>` +
  `<div class="breadcrumb">Home / ${title}</div><h1>${title}</h1>${body}` +
  `<div class="cookie-banner">Wir verwenden Cookies.</div>${extra}</main><footer>Impressum</footer></body></html>`;

describe('extractPage', () => {
  it('keeps the text of <main> with headings and list items, and drops nav, footer and the selector', () => {
    const html = page('Produkt', '<p>Erster Absatz.</p><ul><li>Eins</li><li>Zwei</li></ul>');
    const result = extractPage(html, { dropSelector: '.breadcrumb, .cookie-banner' });
    assert.equal(result.title, 'Produkt');
    assert.equal(result.text, '# Produkt\nErster Absatz.\n- Eins\n- Zwei');
  });

  it('keeps a boilerplate block the caller does not name', () => {
    const result = extractPage(page('A', '<p>Text</p>'));
    assert.match(result.text, /Home \/ A/);
    assert.match(result.text, /Wir verwenden Cookies/);
  });

  it('falls back to <body> and drops scripts, forms and buttons', () => {
    const result = extractPage(
      '<html><body><p>Nur Body</p><script>alert(1)</script><form><input></form><button>Klick</button></body></html>'
    );
    assert.equal(result.text, 'Nur Body');
  });

  it('drops consecutive duplicate lines, as a slider repeats its slides', () => {
    const result = extractPage('<main><p>Gleich</p><p>Gleich</p><p>Anders</p><p>Gleich</p></main>');
    assert.equal(result.text, 'Gleich\nAnders\nGleich');
  });

  it('reads the date of the first <time> element', () => {
    assert.equal(
      extractPage('<main><time datetime="2026-01-02">2. Januar</time><p>x</p></main>').date,
      '2026-01-02'
    );
    assert.equal(extractPage('<main><p>x</p></main>').date, null);
  });
});

describe('validateSelector', () => {
  it('returns a valid list trimmed, and an empty one as empty', () => {
    assert.equal(validateSelector('  .a, #b  '), '.a, #b');
    assert.equal(validateSelector(''), '');
  });

  it('refuses an invalid or an overlong selector with INVALID_SELECTOR', () => {
    assert.throws(() => validateSelector('div['), { code: 'INVALID_SELECTOR' });
    assert.throws(() => validateSelector('a'.repeat(1001)), { code: 'INVALID_SELECTOR' });
  });
});

describe('outlinePage', () => {
  it('lists elements with a class or id and marks page furniture', () => {
    const result = outlinePage(
      page('Seite', '<p>Text</p><section class="content"><p>Mehr</p></section>')
    );
    assert.ok(
      result.lines.some(line => line.includes('div.breadcrumb') && line.includes('<- drop?'))
    );
    assert.ok(
      result.lines.some(line => line.includes('div.cookie-banner') && line.includes('<- drop?'))
    );
    assert.ok(
      result.lines.some(line => line.includes('section.content') && !line.includes('<- drop?'))
    );
    assert.deepEqual(result.candidates.sort(), ['div.breadcrumb', 'div.cookie-banner']);
  });
});

describe('sitemaps', () => {
  it('parses an index, a urlset, CDATA and entities', () => {
    assert.deepEqual(
      parseSitemap(
        '<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>'
      ),
      {
        kind: 'index',
        locs: ['https://a.test/s1.xml']
      }
    );
    const set = parseSitemap(
      '<urlset><url><loc> https://a.test/x?a=1&amp;b=2 </loc></url><url><loc><![CDATA[https://a.test/y]]></loc></url></urlset>'
    );
    assert.equal(set.kind, 'urlset');
    assert.deepEqual(set.locs, ['https://a.test/x?a=1&b=2', 'https://a.test/y']);
  });

  it('reads the Sitemap lines of a robots.txt', () => {
    assert.deepEqual(
      sitemapsFromRobots(
        'User-agent: *\nDisallow: /x\nSitemap: https://a.test/s.xml\nsitemap:https://a.test/t.xml'
      ),
      ['https://a.test/s.xml', 'https://a.test/t.xml']
    );
  });

  const files = {
    'https://a.test/sitemap.xml':
      '<sitemapindex><sitemap><loc>https://a.test/de.xml</loc></sitemap><sitemap><loc>https://other.test/x.xml</loc></sitemap></sitemapindex>',
    'https://a.test/de.xml':
      '<urlset>' +
      ['/de/', '/de/a', '/de/a#top', '/de/b.pdf', '/en/a', 'https://evil.test/de/z']
        .map(u => `<url><loc>${u.startsWith('http') ? u : `https://a.test${u}`}</loc></url>`)
        .join('') +
      '</urlset>'
  };
  const fetchText = async url => files[url] ?? null;

  it('keeps pages of the site under the prefix and counts what it left out', async () => {
    const result = await collectSiteUrls({
      siteUrl: 'https://a.test',
      prefix: '/de/',
      robotsText: 'Sitemap: https://a.test/sitemap.xml',
      fetchText
    });
    assert.deepEqual(result.urls, ['https://a.test/de/', 'https://a.test/de/a']);
    assert.deepEqual(result.skipped, { offSite: 1, outsideScope: 1, notPages: 1, overLimit: 0 });
    // The sitemap on another host is never fetched.
    assert.deepEqual(result.failed, ['https://other.test/x.xml']);
  });

  it('tries the usual places when robots.txt names no sitemap', async () => {
    const result = await collectSiteUrls({
      siteUrl: 'https://a.test',
      prefix: '/de/',
      robotsText: null,
      fetchText
    });
    assert.equal(result.usedFallback, true);
    assert.equal(result.urls.length, 2);
  });

  it('refuses a sitemap address on another host even when the caller names it', async () => {
    const result = await collectSiteUrls({
      siteUrl: 'https://a.test',
      sitemapUrls: ['https://other.test/sitemap.xml'],
      fetchText: async () => '<urlset><url><loc>https://a.test/x</loc></url></urlset>'
    });
    assert.deepEqual(result.urls, []);
  });
});

describe('hostile input stays linear', () => {
  /** The time `fn` takes; the old patterns needed minutes for what takes milliseconds now. */
  const took = fn => {
    const start = Date.now();
    const result = fn();
    return { ms: Date.now() - start, result };
  };

  it('reads a sitemap of 8 MB of spaces after an unclosed <loc> without backtracking', () => {
    const { ms, result } = took(() => parseSitemap(`<loc>${' '.repeat(8_000_000)}`));
    assert.deepEqual(result.locs, []);
    assert.ok(ms < 2000, `took ${ms} ms`);
  });

  it('reads 8 MB of <loc> openers without a closer in linear time', () => {
    const { ms, result } = took(() => parseSitemap('<loc>'.repeat(1_600_000)));
    assert.deepEqual(result.locs, []);
    assert.ok(ms < 2000, `took ${ms} ms`);
  });

  it('trims a path of a million slashes in linear time', () => {
    const path = `https://a.test/${'/'.repeat(1_000_000)}x`;
    const section = took(() => sectionOf(path));
    assert.equal(section.result, 'x');
    assert.ok(section.ms < 2000, `took ${section.ms} ms`);
    const prefix = took(() => normalizePrefix(`a${'/'.repeat(1_000_000)}x`));
    assert.equal(prefix.result, `/a${'/'.repeat(1_000_000)}x/`);
    assert.ok(prefix.ms < 2000, `took ${prefix.ms} ms`);
  });

  it('still reads loc elements with surrounding whitespace, entities and CDATA', () => {
    const { locs } = parseSitemap(
      '<urlset><url><loc>\n  https://a.test/x?a=1&amp;b=2\n</loc></url>' +
        '<url><loc>  <![CDATA[https://a.test/y]]>  </loc></url><url><loc></loc></url></urlset>'
    );
    assert.deepEqual(locs, ['https://a.test/x?a=1&b=2', 'https://a.test/y']);
  });
});

describe('urls', () => {
  it('normalises the prefix and names sections', () => {
    assert.equal(normalizePrefix('de'), '/de/');
    assert.equal(normalizePrefix('/de'), '/de/');
    assert.equal(normalizePrefix('/'), '');
    assert.equal(normalizePrefix(' /de/en/ '), '/de/en/');
    assert.equal(sectionOf('https://a.test/de/Blog/post', '/de/'), 'blog');
    assert.equal(sectionOf('https://a.test/de/', '/de/'), 'home');
    assert.deepEqual(
      sectionCounts(
        ['https://a.test/de/a/1', 'https://a.test/de/a/2', 'https://a.test/de/'],
        '/de/'
      ),
      [
        { section: 'a', pages: 2 },
        { section: 'home', pages: 1 }
      ]
    );
  });

  it('compares hosts without www and only for http(s)', () => {
    assert.equal(onSite('https://www.a.test/x', 'a.test'), true);
    assert.equal(onSite('https://b.test/x', 'a.test'), false);
    assert.equal(onSite('ftp://a.test/x', 'a.test'), false);
  });
});

describe('analyseCorpus', () => {
  const shared = 'Kontaktieren Sie uns jetzt für ein unverbindliches Beratungsgespräch.';
  const pages = [
    { url: 'https://a.test/de/', text: `Start\n${shared}` },
    { url: 'https://a.test/de/p/1', text: `Eins\n${shared}\n${words(40)}` },
    { url: 'https://a.test/de/p/2', text: `Zwei\n${shared}\n${words(50)}` },
    { url: 'https://a.test/de/blog/x', text: `Ein Beitrag ${words(30)}` },
    { url: 'https://a.test/de/kontakt', text: 'Kurz' }
  ];
  const countTokens = text => Math.ceil(text.length / 4);

  it('counts tokens, applies the dedup rule in page order and groups single-page sections', async () => {
    const result = await analyseCorpus(pages, { countTokens, prefix: '/de/' });
    assert.equal(result.totals.pages, 5);
    // The shared line (>= 40 characters) is counted on the first page only.
    const first = result.rows[0];
    const second = result.rows[1];
    assert.equal(first.tokensDedup, first.tokens);
    assert.ok(second.tokensDedup < second.tokens);
    assert.equal(result.rows[2].tokensDedup, countTokens(`Zwei\n${words(50)}`));
    assert.deepEqual(result.sections.map(s => s.section).sort(), ['home', 'p', 'top-level pages']);
    assert.equal(result.rows[4].thin, true);
    assert.equal(result.totals.thin, 3);
  });

  it('keeps news-like sections out of the core pages', async () => {
    const result = await analyseCorpus(pages, { countTokens, prefix: '/de/' });
    // `blog` has one page, so it is grouped as top-level pages and no longer news-like.
    assert.deepEqual(result.newsFound, []);
    const more = [...pages, { url: 'https://a.test/de/blog/y', text: `Noch einer ${words(30)}` }];
    const withBlog = await analyseCorpus(more, { countTokens, prefix: '/de/' });
    assert.deepEqual(withBlog.newsFound, ['blog']);
    assert.equal(withBlog.core.pages, 4);
  });

  it('finds exact duplicates by text', async () => {
    const twice = [...pages, { url: 'https://a.test/de/p/3', text: pages[1].text }];
    const result = await analyseCorpus(twice, { countTokens, prefix: '/de/' });
    assert.equal(result.exactDuplicates.length, 1);
    assert.equal(result.exactDuplicates[0].urls.length, 2);
    assert.equal(result.exactDuplicates[0].extraTokens, result.rows[1].tokens);
  });
});

describe('windowFit', () => {
  it('compares tokens with the 128k, 256k and 1M windows', () => {
    const fit = windowFit(200_000);
    assert.deepEqual(
      fit.map(({ label, fits, windows }) => [label, fits, windows]),
      [
        ['128k', false, 2],
        ['256k', true, 1],
        ['1M', true, 1]
      ]
    );
    assert.equal(fit[1].ratio, 200_000 / 262_144);
  });
});

describe('findNearDuplicates', () => {
  it('reports pages that differ by a sentence, not pages that are different or identical', async () => {
    const base = Array.from({ length: 300 }, (_v, i) => `satz${i}`).join(' ');
    const other = Array.from({ length: 300 }, (_v, i) => `anders${i}`).join(' ');
    const result = await findNearDuplicates([
      { url: 'a', text: base },
      { url: 'b', text: `${base} und noch ein Satz` },
      { url: 'c', text: other },
      { url: 'd', text: base }
    ]);
    const pairs = result.pairs.map(p => p.urls.join('+')).sort();
    assert.deepEqual(pairs, ['a+b', 'b+d']);
    assert.equal(result.total, 2);
    assert.ok(result.pairs[0].similarity >= 0.8);
  });
});

describe('renderReport', () => {
  it('escapes a backslash before a pipe, so a cell cannot end early', async () => {
    const pages = [
      { url: 'https://a.test/de/x/1', title: 'a\\|b', text: words(200) },
      { url: 'https://a.test/de/x/2', text: words(300) }
    ];
    const analysis = await analyseCorpus(pages, { countTokens: t => t.length, prefix: '/de/' });
    // Sections come from URL paths, which cannot hold a backslash; force one to test the escaping itself.
    analysis.sections[0].section = 'a\\|b';
    const markdown = renderReport({
      name: 'N',
      analysis,
      nearDuplicates: { total: 0, pairs: [] },
      tokenizer: { method: 'heuristic', note: 'n' },
      meta: {
        crawlDate: '2026-11-10',
        siteUrl: 'https://a.test',
        prefix: '',
        dropSelector: '',
        coverage: {
          inSitemap: 2,
          crawled: 2,
          failed: 0,
          blockedByRobots: 0,
          notHtml: 0,
          notCrawled: 0
        }
      }
    });
    // The backslash is doubled and the pipe is escaped: `a\\\\\\|b` in the Markdown source.
    assert.ok(markdown.includes('| a\\\\\\|b |'));
  });

  it('lays the numbers out and escapes what would break the Markdown', async () => {
    const pages = [
      { url: 'https://a.test/de/a|b/x(1)', text: words(200) },
      { url: 'https://a.test/de/a|b/y', text: words(300) }
    ];
    const analysis = await analyseCorpus(pages, { countTokens: t => t.length, prefix: '/de/' });
    const markdown = renderReport({
      name: 'Test Corp',
      analysis,
      nearDuplicates: { total: 0, pairs: [] },
      tokenizer: { method: 'heuristic', note: 'a note' },
      meta: {
        crawlDate: '2026-11-10',
        siteUrl: 'https://a.test',
        prefix: '/de/',
        dropSelector: '.x',
        coverage: {
          inSitemap: 3,
          crawled: 2,
          failed: 0,
          blockedByRobots: 0,
          notHtml: 0,
          notCrawled: 1
        }
      }
    });
    assert.match(markdown, /^# Test Corp Website Corpus/);
    assert.match(markdown, /## Does it fit in one context window\?/);
    assert.match(markdown, /\| Full corpus \|/);
    assert.match(markdown, /```mermaid\nxychart-beta/);
    // Every chart label is quoted, so the axis line stays well-formed.
    assert.match(markdown, /x-axis \["[^"]*"(, "[^"]*")*\]/);
    // A pipe in a section name or a bracket in a URL does not break the tables.
    assert.match(markdown, /\| a\\\|b \|/);
    assert.match(markdown, /x%281%29/);
    assert.match(markdown, /The corpus is incomplete: 1 pages have not been crawled yet/);
    assert.match(markdown, /No exact duplicate pages and no near-duplicate pages were found/);
    assert.match(markdown, /Tokens are estimates \(a note\)/);
  });
});

// ---- the service ------------------------------------------------------------

/** In-memory storage facets, as much of the contract as the store uses. */
function memoryFacets() {
  const docs = new Map();
  const blobMap = new Map();
  return {
    docs,
    blobMap,
    documents: {
      async get(ns, key) {
        return docs.has(`${ns}/${key}`) ? docs.get(`${ns}/${key}`) : null;
      },
      async put(ns, key, data, opts = {}) {
        const existing = docs.get(`${ns}/${key}`);
        const doc = {
          ns,
          key,
          data: structuredClone(data),
          ownerId: opts.ownerId ?? existing?.ownerId ?? null
        };
        docs.set(`${ns}/${key}`, doc);
        return doc;
      },
      async delete(ns, key) {
        return docs.delete(`${ns}/${key}`);
      },
      async list(ns, { ownerId } = {}) {
        const items = [...docs.values()].filter(
          d => d.ns === ns && (!ownerId || d.ownerId === ownerId)
        );
        return { items, nextCursor: null };
      }
    },
    blobs: {
      async put(ns, key, data) {
        blobMap.set(`${ns}/${key}`, Buffer.from(data));
        return { key };
      },
      async get(ns, key) {
        return blobMap.has(`${ns}/${key}`) ? { key, data: blobMap.get(`${ns}/${key}`) } : null;
      },
      async delete(ns, key) {
        return blobMap.delete(`${ns}/${key}`);
      },
      async list(ns, { prefix = '' } = {}) {
        const items = [...blobMap.keys()]
          .filter(k => k.startsWith(`${ns}/${prefix}`))
          .map(k => ({ key: k.slice(ns.length + 1) }));
        return { items, nextCursor: null };
      }
    },
    locks: { withLock: async (_name, fn) => fn() }
  };
}

const USER = { id: 'u1' };
const OTHER = { id: 'u2' };

/** A fake site: a robots.txt, a sitemap and pages; `calls` records every page fetch. */
function fakeSite({
  pageCount = 5,
  robots = 'User-agent: *\nDisallow: /de/privat/\nSitemap: https://a.test/s.xml'
} = {}) {
  const urls = Array.from({ length: pageCount }, (_v, i) => `https://a.test/de/produkte/p${i}`);
  urls.push('https://a.test/de/privat/geheim');
  const calls = [];
  const html = {
    ...Object.fromEntries(urls.map((u, i) => [u, page(`Produkt ${i}`, `<p>${words(60 + i)}</p>`)])),
    'https://a.test/de/produkte/p1': '%PDF',
    'https://a.test/de/produkte/p2': null
  };
  return {
    calls,
    fetchRobots: async () => robots,
    fetchSitemap: async url =>
      url === 'https://a.test/s.xml'
        ? `<urlset>${urls.map(u => `<url><loc>${u}</loc></url>`).join('')}</urlset>`
        : null,
    fetchPage: async url => {
      calls.push(url);
      if (url === 'https://a.test/de/produkte/p1') {
        return {
          status: 200,
          finalUrl: url,
          contentType: 'application/pdf',
          html: null,
          truncated: false,
          offSite: false
        };
      }
      if (url === 'https://a.test/de/produkte/p2') {
        return {
          status: 404,
          finalUrl: url,
          contentType: 'text/html',
          html: null,
          truncated: false,
          offSite: false
        };
      }
      if (url === 'https://a.test/de/produkte/p3') {
        return {
          status: 200,
          finalUrl: 'https://elsewhere.test/',
          contentType: 'text/html',
          html: null,
          truncated: false,
          offSite: true
        };
      }
      return {
        status: 200,
        finalUrl: url,
        contentType: 'text/html',
        html: html[url],
        truncated: false,
        offSite: false
      };
    }
  };
}

function makeService(site, { method = 'heuristic', now } = {}) {
  const facets = memoryFacets();
  const store = new CorpusStore(facets);
  const service = new WebsiteCorpusService({
    store,
    countTokens: text => Math.ceil(text.length / 4),
    tokenizerInfo: () => ({ method }),
    fetchPage: site.fetchPage,
    fetchRobots: site.fetchRobots,
    fetchSitemap: site.fetchSitemap,
    ...(now ? { now } : {})
  });
  return { service, store, facets };
}

describe('WebsiteCorpusService', () => {
  it('discovers a site: sections, robots.txt exclusions, and a corpus for the user', async () => {
    const { service } = makeService(fakeSite());
    const result = await service.discoverSite(
      { siteUrl: 'https://a.test', prefix: 'de', name: 'A' },
      { user: USER }
    );
    assert.match(result.corpusId, /^wc_/);
    assert.equal(result.pages, 6);
    assert.equal(result.blockedByRobots, 1);
    assert.deepEqual(result.sections.map(s => s.section).sort(), ['privat', 'produkte']);
    assert.equal(result.scope, '/de/');
  });

  it('asks the user instead of guessing when no pages are found', async () => {
    const site = fakeSite();
    site.fetchSitemap = async () => null;
    const { service } = makeService(site);
    const result = await service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER });
    assert.equal(result.pages, 0);
    assert.equal(result.corpusId, undefined);
    assert.match(result.message, /Ask the user/);
  });

  it('refuses a site over the installation limit and a non-http address', async () => {
    const { service } = makeService(fakeSite({ pageCount: 5 }));
    await assert.rejects(
      service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER, maxPages: 3 }),
      { code: 'TOO_MANY_PAGES' }
    );
    await assert.rejects(service.discoverSite({ siteUrl: 'ftp://a.test' }, { user: USER }), {
      code: 'INVALID_URL'
    });
    await assert.rejects(service.discoverSite({ siteUrl: 'not a url' }, { user: USER }), {
      code: 'INVALID_URL'
    });
  });

  it('needs a signed-in user', async () => {
    const { service } = makeService(fakeSite());
    await assert.rejects(
      service.discoverSite({ siteUrl: 'https://a.test' }, { user: { id: 'anonymous' } }),
      {
        code: 'SIGN_IN_REQUIRED'
      }
    );
    await assert.rejects(service.discoverSite({ siteUrl: 'https://a.test' }, {}), {
      code: 'SIGN_IN_REQUIRED'
    });
  });

  it('crawls in resumable batches, honors robots.txt and counts what it could not keep', async () => {
    const site = fakeSite({ pageCount: 5 });
    const { service } = makeService(site);
    const { corpusId } = await service.discoverSite(
      { siteUrl: 'https://a.test', name: 'A' },
      { user: USER }
    );

    const first = await service.crawlPages(
      { corpusId, dropSelector: '.breadcrumb, .cookie-banner', batchSize: 3 },
      { user: USER }
    );
    assert.equal(first.done, false);
    assert.equal(first.attempted, 3);
    assert.equal(first.remaining, 3);

    const second = await service.crawlPages({ corpusId, batchSize: 10 }, { user: USER });
    assert.equal(second.done, true);
    // Of the six URLs only p0 and p4 are kept: p1 is a PDF, p2 a 404, p3 redirects off site, the last is blocked.
    assert.equal(second.crawled, 2);
    assert.equal(second.attempted, 6);
  });

  it('counts failures, non-HTML pages, off-site redirects and robots blocks apart', async () => {
    const site = fakeSite({ pageCount: 5 });
    const { service } = makeService(site);
    const { corpusId } = await service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER });
    const result = await service.crawlPages(
      { corpusId, dropSelector: '', batchSize: 20 },
      { user: USER }
    );
    assert.equal(result.done, true);
    assert.equal(result.total, 6);
    assert.equal(result.crawled, 2); // p0 and p4
    assert.equal(result.notHtml, 1); // p1 is a PDF
    assert.equal(result.failed, 2); // p2 is a 404, p3 redirected to another site
    assert.equal(result.blockedByRobots, 1);
    assert.deepEqual(result.newFailures.map(f => f.reason).sort(), [
      'HTTP 404',
      'redirected to another site'
    ]);
    // The page robots.txt forbids is never fetched.
    assert.equal(
      site.calls.filter(called => called === 'https://a.test/de/privat/geheim').length,
      0
    );
  });

  it('stops starting pages at the deadline and resumes where it stopped', async () => {
    const site = fakeSite({ pageCount: 5 });
    let clock = 0;
    const { service } = makeService(site, { now: () => (clock += 12_000) });
    const { corpusId } = await service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER });
    const first = await service.crawlPages(
      { corpusId, dropSelector: '', batchSize: 6 },
      { user: USER }
    );
    assert.equal(first.done, false);
    assert.ok(first.attempted > 0 && first.attempted < 6, `attempted ${first.attempted}`);
    let last = first;
    for (let i = 0; i < 10 && !last.done; i++)
      last = await service.crawlPages({ corpusId, batchSize: 6 }, { user: USER });
    assert.equal(last.done, true);
    assert.equal(last.attempted, 6);
    assert.equal(last.crawled + last.failed + last.notHtml + last.blockedByRobots, 6);
  });

  it('refuses a changed selector in the middle of a crawl unless the crawl starts over', async () => {
    const { service } = makeService(fakeSite({ pageCount: 5 }));
    const { corpusId } = await service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER });
    await service.crawlPages(
      { corpusId, dropSelector: '.breadcrumb', batchSize: 2 },
      { user: USER }
    );
    await assert.rejects(
      service.crawlPages({ corpusId, dropSelector: '.cookie-banner' }, { user: USER }),
      { code: 'SELECTOR_CHANGED' }
    );
    const restarted = await service.crawlPages(
      { corpusId, dropSelector: '.cookie-banner', restart: true, batchSize: 2 },
      { user: USER }
    );
    assert.equal(restarted.attempted, 2);
    assert.equal(restarted.dropSelector, '.cookie-banner');
    await assert.rejects(service.crawlPages({ corpusId, dropSelector: 'div[' }, { user: USER }), {
      code: 'INVALID_SELECTOR'
    });
  });

  it('never gives a corpus to another user', async () => {
    const { service } = makeService(fakeSite());
    const { corpusId } = await service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER });
    for (const call of [
      () => service.crawlPages({ corpusId }, { user: OTHER }),
      () => service.outlinePages({ corpusId }, { user: OTHER }),
      () => service.readPageText({ corpusId }, { user: OTHER }),
      () => service.corpusReport({ corpusId }, { user: OTHER })
    ]) {
      await assert.rejects(call, { code: 'CORPUS_NOT_FOUND' });
    }
    await assert.rejects(service.crawlPages({ corpusId: '../../x' }, { user: USER }), {
      code: 'CORPUS_NOT_FOUND'
    });
  });

  it('shows the structure of pages and the kept text of one page', async () => {
    const { service } = makeService(fakeSite({ pageCount: 5 }));
    const { corpusId } = await service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER });
    const outline = await service.outlinePages({ corpusId, urlContains: ['/p4'] }, { user: USER });
    assert.equal(outline.pages.length, 1);
    assert.ok(outline.pages[0].candidates.includes('div.breadcrumb'));

    await service.crawlPages(
      { corpusId, dropSelector: '.breadcrumb, .cookie-banner', batchSize: 20 },
      { user: USER }
    );
    const text = await service.readPageText({ corpusId, url: 'p4', maxChars: 300 }, { user: USER });
    assert.equal(text.title, 'Produkt 4');
    assert.ok(text.text.startsWith('# Produkt 4'));
    assert.ok(!text.text.includes('Cookies'));
    assert.equal(text.shownChars, 300);
    await assert.rejects(service.readPageText({ corpusId, url: 'nope' }, { user: USER }), {
      code: 'PAGE_NOT_FOUND'
    });
  });

  it('reports the numbers and says how tokens were counted', async () => {
    const { service } = makeService(fakeSite({ pageCount: 5 }));
    const { corpusId } = await service.discoverSite(
      { siteUrl: 'https://a.test', name: 'Site A' },
      { user: USER }
    );
    await assert.rejects(service.corpusReport({ corpusId }, { user: USER }), {
      code: 'NOTHING_CRAWLED'
    });
    await service.crawlPages({ corpusId, dropSelector: '', batchSize: 20 }, { user: USER });
    const result = await service.corpusReport({ corpusId }, { user: USER });
    assert.equal(result.complete, true);
    assert.equal(result.tokenizer, 'heuristic');
    assert.equal(result.pages, 2);
    assert.match(result.report, /^# Site A Website Corpus/);
    assert.match(result.report, /one token per 4 characters/);
    assert.match(result.report, /\| 6 \| 2 \| 2 \| 1 \| 1 \| 0 \|/);
  });

  it('states the tokenizer in the words of the report', () => {
    assert.match(tokenizerNote({ method: 'o200k_base' }), /o200k_base/);
    assert.match(tokenizerNote({ method: 'heuristic' }), /off in either direction/);
  });

  it('marks an incomplete crawl in the report', async () => {
    const { service } = makeService(fakeSite({ pageCount: 5 }));
    const { corpusId } = await service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER });
    await service.crawlPages({ corpusId, dropSelector: '', batchSize: 2 }, { user: USER });
    const result = await service.corpusReport({ corpusId }, { user: USER });
    assert.equal(result.complete, false);
    assert.match(result.report, /The corpus is incomplete: 4 pages have not been crawled yet/);
  });
});

describe('CorpusStore.prune', () => {
  it('removes expired corpora and keeps room for the next one', async () => {
    const facets = memoryFacets();
    const store = new CorpusStore(facets);
    const day = 86_400_000;
    const now = Date.parse('2026-11-10T12:00:00Z');
    const ids = [];
    // One expired, and enough recent ones to be over the limit.
    const expired = await store.create('u1', { name: 'old' }, ['https://a.test/x']);
    facets.docs.get(`website-corpora/${expired.id}`).data.createdAt = new Date(
      now - (RETENTION_DAYS + 1) * day
    ).toISOString();
    for (let i = 0; i < MAX_CORPORA_PER_USER + 1; i++) {
      const corpus = await store.create('u1', { name: `c${i}` }, ['https://a.test/x']);
      facets.docs.get(`website-corpora/${corpus.id}`).data.createdAt = new Date(
        now - (10 - i) * 3_600_000
      ).toISOString();
      ids.push(corpus.id);
    }
    const other = await store.create('u2', { name: 'other' }, []);

    const removed = await store.prune('u1', now);
    assert.equal(removed, 3); // the expired one, and the two oldest beyond the limit (5 − 1 = 4 kept)
    const left = [...facets.docs.values()].filter(d => d.ownerId === 'u1').map(d => d.data.name);
    assert.equal(left.length, MAX_CORPORA_PER_USER - 1);
    assert.ok(!left.includes('old') && !left.includes('c0') && !left.includes('c1'));
    // The URL list went with the document, and another user's corpus stayed.
    assert.ok(![...facets.blobMap.keys()].some(k => k.includes(expired.id)));
    assert.ok(facets.docs.has(`website-corpora/${other.id}`));
  });
});

describe('tokenizerInfo', () => {
  it('names the method estimateTokens really counts with', () => {
    const sample =
      'Die Plattform durchsucht Dokumente im Unternehmen und beantwortet Fragen zu Prozessen.';
    const { method } = tokenizerInfo();
    assert.ok(['o200k_base', 'heuristic'].includes(method));
    // Without the tokenizer library the estimate is exactly one token per four characters.
    if (method === 'heuristic') assert.equal(estimateTokens(sample), Math.ceil(sample.length / 4));
    else assert.notEqual(estimateTokens(sample), Math.ceil(sample.length / 4));
  });
});

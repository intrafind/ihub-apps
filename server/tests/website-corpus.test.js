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
  collectSiteUrls,
  MAX_RAW_LOCS
} from '../services/websiteCorpus/sitemap.js';
import { sweepWebsiteCorpora } from '../services/websiteCorpus/corpusRetention.js';
import {
  normalizePrefix,
  underPrefix,
  sectionCounts,
  sectionOf,
  onSite,
  siteKeyOf
} from '../services/websiteCorpus/urls.js';
import {
  MAX_NEAR_DUP_VERIFICATIONS,
  analyseCorpus,
  findNearDuplicates,
  windowFit
} from '../services/websiteCorpus/stats.js';
import { renderReport } from '../services/websiteCorpus/report.js';
import {
  CORPUS_NAMESPACE,
  CorpusStore,
  MAX_CORPORA_PER_USER,
  RETENTION_DAYS
} from '../services/websiteCorpus/CorpusStore.js';
import {
  DomainStore,
  MAX_OPEN_REQUESTS_PER_USER,
  domainIdFor,
  normalizeHost
} from '../services/websiteCorpus/DomainStore.js';
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
  it('writes a prefix the way a URL path is written, so a non-ASCII scope matches', () => {
    assert.equal(normalizePrefix('/über-uns/'), '/%C3%BCber-uns/');
    assert.equal(normalizePrefix('https://a.test/de/über?x=1#y'), '/de/%C3%BCber/');
    assert.equal(normalizePrefix('/a b/'), '/a%20b/');
    assert.equal(normalizePrefix('https://a.test/'), '');
    const prefix = normalizePrefix('/über-uns/');
    assert.equal(underPrefix('https://a.test/über-uns/team', prefix), true);
    assert.equal(underPrefix('https://a.test/produkte', prefix), false);
    assert.equal(sectionOf('https://a.test/über-uns/team/x', prefix), 'team');
  });

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

  it('treats another port as another site, and http and https as one', () => {
    assert.equal(onSite('http://a.test/x', 'a.test'), true);
    assert.equal(onSite('https://a.test:443/x', 'a.test'), true);
    assert.equal(onSite('http://a.test:80/x', 'a.test'), true);
    assert.equal(onSite('http://a.test:8500/v1/kv/', 'a.test'), false);
    assert.equal(onSite('http://a.test:2375/containers/json', 'a.test'), false);
    assert.equal(onSite('http://a.test:8080/x', 'a.test:8080'), true);
    assert.equal(onSite('https://a.test:8080/x', 'a.test:8080'), true);
    assert.equal(onSite('http://a.test/x', 'a.test:8080'), false);
    assert.equal(siteKeyOf(new URL('https://www.A.test:8443/')), 'a.test:8443');
    assert.equal(siteKeyOf(new URL('http://a.test:80/')), 'a.test');
  });

  it('does not read sitemap files without end once the budget of all files is spent', async () => {
    const big = `<urlset>${'<url><loc>https://a.test/p</loc></url>'.repeat(5)}${' '.repeat(40 * 1024 * 1024)}</urlset>`;
    let fetched = 0;
    const result = await collectSiteUrls({
      siteUrl: 'https://a.test/',
      sitemapUrls: Array.from({ length: 10 }, (_v, i) => `https://a.test/s${i}.xml`),
      fetchText: async () => {
        fetched += 1;
        return big;
      }
    });
    assert.ok(fetched <= 2, `read ${fetched} files of 40 MB`);
    assert.ok(result.sitemapsRead.length <= 2);
  });
});

describe('exact duplicates', () => {
  const countTokens = text => Math.ceil(text.length / 4);

  it('does not group pages without text (a client-rendered site has hundreds)', async () => {
    const pages = [
      ...Array.from({ length: 50 }, (_v, i) => ({ url: `https://a.test/p${i}`, text: '' })),
      { url: 'https://a.test/x1', text: words(20) },
      { url: 'https://a.test/x2', text: words(20) }
    ];
    const result = await analyseCorpus(pages, { countTokens });
    assert.equal(result.exactDuplicates.length, 1);
    assert.equal(result.exactDuplicates[0].urls.length, 2);
  });

  it('prints a few URLs of a large group and counts the rest', async () => {
    const pages = Array.from({ length: 40 }, (_v, i) => ({
      url: `https://a.test/same${i}`,
      text: words(30)
    }));
    const analysis = await analyseCorpus(pages, { countTokens });
    const markdown = renderReport({
      name: 'N',
      analysis,
      nearDuplicates: { total: 0, pairs: [], truncated: false, verified: 0 },
      tokenizer: { method: 'heuristic', note: 'n' },
      meta: {
        crawlDate: '2026-11-10',
        siteUrl: 'https://a.test',
        prefix: '',
        dropSelector: '',
        coverage: {
          inSitemap: 40,
          crawled: 40,
          failed: 0,
          blockedByRobots: 0,
          notHtml: 0,
          notCrawled: 0
        }
      }
    });
    const line = markdown
      .split('\n')
      .find(entry => entry.startsWith('- ') && entry.includes('same0'));
    assert.ok(line.includes('and 35 more'), line);
    assert.ok(!line.includes('same6'), 'only the first few are listed');
  });

  it('still says the comparison stopped when it found no pair at all', async () => {
    const analysis = await analyseCorpus([{ url: 'https://a.test/a', text: words(30) }], {
      countTokens
    });
    const markdown = renderReport({
      name: 'N',
      analysis,
      nearDuplicates: { total: 0, pairs: [], truncated: true, verified: 3000 },
      tokenizer: { method: 'heuristic', note: 'n' },
      meta: {
        crawlDate: '2026-11-10',
        siteUrl: 'https://a.test',
        prefix: '',
        dropSelector: '',
        coverage: {
          inSitemap: 1,
          crawled: 1,
          failed: 0,
          blockedByRobots: 0,
          notHtml: 0,
          notCrawled: 0
        }
      }
    });
    assert.ok(!markdown.includes('no near-duplicate pages were found'));
    assert.ok(markdown.includes('at least 0'));
    assert.ok(markdown.includes('may have more near-duplicates'));
  });

  it('says "at least" when the near-duplicate comparison stopped', async () => {
    const analysis = await analyseCorpus([{ url: 'https://a.test/a', text: words(30) }], {
      countTokens
    });
    const markdown = renderReport({
      name: 'N',
      analysis,
      nearDuplicates: {
        total: 3000,
        pairs: [{ similarity: 0.95, urls: ['https://a.test/a', 'https://a.test/b'] }],
        truncated: true,
        verified: 3000
      },
      tokenizer: { method: 'heuristic', note: 'n' },
      meta: {
        crawlDate: '2026-11-10',
        siteUrl: 'https://a.test',
        prefix: '',
        dropSelector: '',
        coverage: {
          inSitemap: 1,
          crawled: 1,
          failed: 0,
          blockedByRobots: 0,
          notHtml: 0,
          notCrawled: 0
        }
      }
    });
    assert.ok(markdown.includes('overlap of 0.80 or more): at least 3000.'));
    assert.ok(markdown.includes('stopped after 3,000 candidate pairs'));
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

function makeService(site, { method = 'heuristic', now, hostCheck } = {}) {
  const facets = memoryFacets();
  const store = new CorpusStore(facets);
  const domains = new DomainStore(facets);
  const service = new WebsiteCorpusService({
    store,
    domains,
    countTokens: text => Math.ceil(text.length / 4),
    tokenizerInfo: () => ({ method }),
    fetchPage: site.fetchPage,
    fetchRobots: site.fetchRobots,
    fetchSitemap: site.fetchSitemap,
    // The network decision is tested in the SSRF guard tests; here every host is public.
    hostCheck: hostCheck || (async () => ({ ok: true })),
    ...(now ? { now } : {})
  });
  return { service, store, domains, facets };
}

/**
 * A host check as the SSRF guard decides it: `*.corp` hosts are company-internal
 * addresses (reachable only when the policy allows it), `loopback.corp` is never
 * reachable, `nx.corp` does not resolve, anything else is public.
 */
async function guardedCheck(url, policy) {
  if (url.hostname === 'nx.corp') {
    return { ok: false, reason: 'host did not resolve to any IP', code: 'UNRESOLVED_HOST' };
  }
  if (url.hostname === 'loopback.corp')
    return { ok: false, reason: 'IP 127.0.0.1 is not reachable' };
  if (url.hostname.endsWith('.corp')) {
    return policy?.allowPrivate?.(url.hostname)
      ? { ok: true }
      : { ok: false, reason: 'host resolves to private IP 10.0.0.5' };
  }
  return { ok: true };
}

/** A fake internal site, whose requests record the policy they were made with. */
function internalSite(host = 'intranet.corp') {
  const policies = [];
  const origin = `https://${host}`;
  return {
    policies,
    fetchRobots: async (_origin, { policy } = {}) => {
      policies.push(policy);
      return `Sitemap: ${origin}/s.xml`;
    },
    fetchSitemap: async (url, { policy } = {}) => {
      policies.push(policy);
      return url === `${origin}/s.xml`
        ? `<urlset>${[0, 1, 2].map(i => `<url><loc>${origin}/de/p${i}</loc></url>`).join('')}</urlset>`
        : null;
    },
    fetchPage: async (url, { policy } = {}) => {
      policies.push(policy);
      return {
        status: 200,
        finalUrl: url,
        contentType: 'text/html',
        html: page('Intern', `<p>${words(40)}</p>`),
        truncated: false,
        offSite: false
      };
    }
  };
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

  it('fetches as many pages at once as the installation allows', async () => {
    const site = fakeSite({ pageCount: 20 });
    let inFlight = 0;
    let peak = 0;
    const slowFetch = async (url, options) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      try {
        return await site.fetchPage(url, options);
      } finally {
        inFlight -= 1;
      }
    };
    for (const [crawlConcurrency, expectedPeak] of [
      [1, 1],
      [6, 6],
      // Out of range: clamped to the most the crawler ever uses.
      [500, 16],
      // Not a number: the default.
      ['many', 4]
    ]) {
      const { service } = makeService({ ...site, fetchPage: slowFetch });
      const { corpusId } = await service.discoverSite(
        { siteUrl: 'https://a.test' },
        { user: USER }
      );
      peak = 0;
      await service.crawlPages(
        { corpusId, dropSelector: '' },
        { user: USER, crawlConcurrency, requestDelayMs: 0 }
      );
      assert.equal(peak, Math.min(expectedPeak, 21), `crawlConcurrency ${crawlConcurrency}`);
    }
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

  it('adds the dashboard spec only when asked, and says what to do with it', async () => {
    const { service } = makeService(fakeSite({ pageCount: 5 }));
    const { corpusId } = await service.discoverSite(
      { siteUrl: 'https://a.test', name: 'Site A' },
      { user: USER }
    );
    await service.crawlPages({ corpusId, dropSelector: '', batchSize: 20 }, { user: USER });
    const plain = await service.corpusReport({ corpusId }, { user: USER });
    assert.equal(plain.dashboard, undefined);
    assert.doesNotMatch(plain.next, /dashboard/);

    const withDashboard = await service.corpusReport(
      { corpusId, dashboard: true, language: 'de' },
      { user: USER }
    );
    assert.equal(withDashboard.dashboard.lang, 'de');
    assert.equal(withDashboard.dashboard.title, 'Site A Website-Korpus');
    assert.equal(withDashboard.dashboard.kpis[0].value, withDashboard.pages);
    assert.equal(withDashboard.dashboard.kpis[1].value, withDashboard.tokens);
    assert.match(withDashboard.next, /activate the "dashboard" skill/);
    // The Markdown report is the same either way.
    assert.equal(withDashboard.report, plain.report);
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

describe('internal websites', () => {
  const ADMIN = { id: 'admin1', name: 'Admin' };

  it('refuses an internal host with what the user can do, before fetching anything', async () => {
    const site = internalSite();
    const { service, facets } = makeService(site, { hostCheck: guardedCheck });
    await assert.rejects(
      service.discoverSite({ siteUrl: 'https://intranet.corp' }, { user: USER }),
      error => {
        assert.equal(error.code, 'HOST_NOT_ALLOWED');
        assert.match(error.message, /company-internal address/);
        assert.match(error.message, /website_corpus_request_domain/);
        return true;
      }
    );
    assert.deepEqual(site.policies, [], 'no robots.txt, sitemap or page was fetched');
    assert.equal((await facets.documents.list('website-corpora', {})).items.length, 0);
  });

  it('does not offer a request for what no approval can allow, nor for a name that does not resolve', async () => {
    const { service } = makeService(internalSite(), { hostCheck: guardedCheck });
    await assert.rejects(
      service.discoverSite({ siteUrl: 'https://loopback.corp' }, { user: USER }),
      error => {
        assert.equal(error.code, 'HOST_NEVER_ALLOWED');
        assert.ok(!/website_corpus_request_domain/.test(error.message));
        return true;
      }
    );
    await assert.rejects(service.discoverSite({ siteUrl: 'https://nx.corp' }, { user: USER }), {
      code: 'HOST_NOT_RESOLVED'
    });
    await assert.rejects(service.requestDomain({ host: 'loopback.corp' }, { user: USER }), {
      code: 'HOST_NEVER_ALLOWED'
    });
  });

  it('takes a request, joins a second user to it, and tells an asker twice nothing new', async () => {
    const { service, domains } = makeService(internalSite(), { hostCheck: guardedCheck });
    const first = await service.requestDomain(
      { host: 'https://Intranet.corp/some/page', reason: 'Size the wiki' },
      { user: USER }
    );
    assert.equal(first.status, 'requested');
    assert.equal(first.host, 'intranet.corp');
    assert.match(first.message, /An admin has to approve it/);
    const again = await service.requestDomain({ host: 'intranet.corp' }, { user: USER });
    assert.match(again.message, /requested already/);
    await service.requestDomain({ host: 'intranet.corp', reason: 'Same site' }, { user: OTHER });
    const entry = await domains.find('intranet.corp');
    assert.deepEqual(
      entry.requesters.map(r => r.userId),
      ['u1', 'u2']
    );
    assert.equal(entry.requesters[0].reason, 'Size the wiki');
    // Once asked for, the refusal says so instead of offering to ask again.
    await assert.rejects(
      service.discoverSite({ siteUrl: 'https://intranet.corp' }, { user: USER }),
      error => /already waiting for an admin/.test(error.message)
    );
  });

  it('crawls the host once an admin approved it, and only that host', async () => {
    const site = internalSite();
    const { service, domains } = makeService(site, { hostCheck: guardedCheck });
    await service.requestDomain({ host: 'intranet.corp' }, { user: USER });
    await domains.decide(domainIdFor('intranet.corp'), {
      decision: 'approved',
      admin: ADMIN,
      note: 'ok'
    });
    const found = await service.discoverSite(
      { siteUrl: 'https://intranet.corp', name: 'Wiki' },
      { user: USER }
    );
    assert.equal(found.pages, 3);
    // The fetches carried a policy that allows exactly this host.
    const policy = site.policies.at(-1);
    assert.equal(policy.allowPrivate('intranet.corp'), true);
    assert.equal(policy.allowPrivate('other.corp'), false);
    const crawled = await service.crawlPages(
      { corpusId: found.corpusId, dropSelector: '' },
      { user: USER }
    );
    assert.equal(crawled.done, true);
    assert.equal(crawled.crawled, 3);
    // Another internal host stays refused, and asking for an approved host says it is not needed.
    await assert.rejects(service.discoverSite({ siteUrl: 'https://other.corp' }, { user: USER }), {
      code: 'HOST_NOT_ALLOWED'
    });
    const asked = await service.requestDomain({ host: 'intranet.corp' }, { user: OTHER });
    assert.equal(asked.status, 'not_needed');
  });

  it('allows every internal host when the installation says so, and says no request is needed', async () => {
    const site = internalSite('wiki.corp');
    const { service } = makeService(site, { hostCheck: guardedCheck });
    const found = await service.discoverSite(
      { siteUrl: 'https://wiki.corp' },
      { user: USER, allowPrivateAddresses: true }
    );
    assert.equal(found.pages, 3);
    assert.equal(site.policies.at(-1).allowPrivate('anything.corp'), true);
    const asked = await service.requestDomain(
      { host: 'wiki.corp' },
      { user: USER, allowPrivateAddresses: true }
    );
    assert.equal(asked.status, 'not_needed');
    // Loopback stays out of reach: the setting does not change the guard's own rule.
    await assert.rejects(
      service.discoverSite(
        { siteUrl: 'https://loopback.corp' },
        { user: USER, allowPrivateAddresses: true }
      ),
      { code: 'HOST_NEVER_ALLOWED' }
    );
  });

  it('asks nothing of a user who is not signed in, and refuses bad hosts and patterns', async () => {
    const { service } = makeService(internalSite(), { hostCheck: guardedCheck });
    await assert.rejects(
      service.requestDomain({ host: 'intranet.corp' }, { user: { id: 'anonymous' } }),
      { code: 'SIGN_IN_REQUIRED' }
    );
    for (const host of ['', '   ', '*.corp', 'bad host name', 'https://']) {
      await assert.rejects(service.requestDomain({ host }, { user: USER }), {
        code: 'INVALID_HOST'
      });
    }
  });

  it('limits the open requests of one user', async () => {
    const { service } = makeService(internalSite(), { hostCheck: guardedCheck });
    for (let i = 0; i < MAX_OPEN_REQUESTS_PER_USER; i++) {
      await service.requestDomain({ host: `h${i}.corp` }, { user: USER });
    }
    await assert.rejects(service.requestDomain({ host: 'one-more.corp' }, { user: USER }), {
      code: 'TOO_MANY_REQUESTS'
    });
    // Joining a request somebody else made costs nothing.
    const joined = await service.requestDomain({ host: 'h0.corp' }, { user: OTHER });
    assert.equal(joined.status, 'requested');
  });
});

describe('WebsiteCorpusService: corpora and approvals', () => {
  it('keeps the oldest corpus when a discovery ends without making one', async () => {
    const { service, store, facets } = makeService(fakeSite());
    for (let i = 0; i < MAX_CORPORA_PER_USER; i++) {
      await store.create(USER.id, { name: `c${i}` }, []);
    }
    const count = () => [...facets.docs.values()].filter(doc => doc.ns === CORPUS_NAMESPACE).length;
    assert.equal(count(), MAX_CORPORA_PER_USER);
    await assert.rejects(
      service.discoverSite(
        { siteUrl: 'https://a.test', prefix: 'de' },
        { user: USER, maxPages: 1 }
      ),
      { code: 'TOO_MANY_PAGES' }
    );
    assert.equal(count(), MAX_CORPORA_PER_USER, 'nothing was removed for a refused discovery');
    await service.discoverSite({ siteUrl: 'https://a.test', prefix: 'de' }, { user: USER });
    assert.equal(count(), MAX_CORPORA_PER_USER, 'a new corpus replaces the oldest');
  });

  it('an approval of a host covers its www. twin, as the crawl treats them as one site', async () => {
    const { service, domains } = makeService(fakeSite());
    await domains.addApproved({ host: 'intranet.corp', admin: { id: 'a' } });
    const policy = await service.policyFor({});
    assert.equal(policy.allowPrivate('intranet.corp', ''), true);
    assert.equal(policy.allowPrivate('www.intranet.corp', ''), true);
    assert.equal(policy.allowPrivate('www.intranet.corp', '8443'), false);
    assert.equal(policy.allowPrivate('other.corp', ''), false);
    await domains.addApproved({ host: 'www.wiki.corp', admin: { id: 'a' } });
    assert.equal((await service.policyFor({})).allowPrivate('wiki.corp', ''), true);
  });
});

describe('DomainStore', () => {
  const ADMIN = { id: 'admin1', name: 'Admin' };
  const make = () => {
    const facets = memoryFacets();
    return { store: new DomainStore(facets), facets };
  };

  it('reduces input to a host, and accepts a wildcard only from an admin', () => {
    assert.equal(normalizeHost('https://Wiki.Corp/a?b=1'), 'wiki.corp');
    assert.equal(normalizeHost('https://Wiki.Corp:8443/a?b=1'), 'wiki.corp:8443');
    assert.equal(normalizeHost('http://wiki.corp:80/'), 'wiki.corp');
    assert.equal(normalizeHost('wiki.corp:443'), 'wiki.corp');
    assert.equal(normalizeHost('wiki.corp'), 'wiki.corp');
    assert.equal(normalizeHost('10.1.2.3'), '10.1.2.3');
    assert.equal(normalizeHost('*.Corp.Example', { allowWildcard: true }), '*.corp.example');
    assert.throws(() => normalizeHost('*.corp.example'), { code: 'INVALID_HOST' });
    assert.throws(() => normalizeHost('*.com', { allowWildcard: true }), { code: 'INVALID_HOST' });
    assert.throws(() => normalizeHost(''), { code: 'INVALID_HOST' });
    assert.throws(() => normalizeHost('a'.repeat(600)), { code: 'INVALID_HOST' });
  });

  it('stores only what it checked: no patterns, escapes, odd schemes or leading dots', () => {
    for (const hostile of [
      'https://*.com',
      'https://*.corp.example',
      'https://%2a.corp.example',
      'https://.corp.example',
      'foo://0xa.1',
      'foo://a%00b',
      'https://a%00b',
      'ftp://wiki.corp',
      'wiki..corp',
      'wiki corp',
      '-wiki.corp.',
      'wiki.corp/../x?y#z=*'
    ]) {
      if (hostile === 'wiki.corp/../x?y#z=*') {
        assert.equal(normalizeHost(hostile), 'wiki.corp', 'a path is dropped');
        continue;
      }
      assert.throws(() => normalizeHost(hostile), { code: 'INVALID_HOST' }, hostile);
      assert.throws(() => normalizeHost(hostile, { allowWildcard: true }), {
        code: 'INVALID_HOST'
      });
    }
  });

  it('an approval covers the web ports of a host, and another port only when it names it', () => {
    const hosts = ['wiki.corp', 'tools.corp:8443', '*.apps.corp', '*.dev.corp:8080', 'fd00::5'];
    assert.equal(DomainStore.covers(hosts, 'wiki.corp'), true);
    assert.equal(DomainStore.covers(hosts, 'wiki.corp', '443'), true);
    assert.equal(DomainStore.covers(hosts, 'wiki.corp', '80'), true);
    assert.equal(DomainStore.covers(hosts, 'wiki.corp', '8500'), false);
    assert.equal(DomainStore.covers(hosts, 'wiki.corp', '2375'), false);
    assert.equal(DomainStore.covers(hosts, 'tools.corp', '8443'), true);
    assert.equal(DomainStore.covers(hosts, 'tools.corp'), false);
    assert.equal(DomainStore.covers(hosts, 'tools.corp', '8444'), false);
    assert.equal(DomainStore.covers(hosts, 'x.apps.corp'), true);
    assert.equal(DomainStore.covers(hosts, 'x.apps.corp', '8080'), false);
    assert.equal(DomainStore.covers(hosts, 'x.dev.corp', '8080'), true);
    assert.equal(DomainStore.covers(hosts, 'x.dev.corp'), false);
    assert.equal(DomainStore.covers(hosts, 'fd00::5'), true);
  });

  it('keeps a user within the open-request limit when requests arrive at once', async () => {
    const facets = memoryFacets();
    const chains = new Map();
    facets.locks = {
      withLock: (key, fn) => {
        const run = (chains.get(key) || Promise.resolve()).then(fn);
        chains.set(
          key,
          run.catch(() => {})
        );
        return run;
      }
    };
    const store = new DomainStore(facets);
    const results = await Promise.allSettled(
      Array.from({ length: MAX_OPEN_REQUESTS_PER_USER + 8 }, (_v, i) =>
        store.request({ host: `h${i}.corp`, user: USER })
      )
    );
    assert.equal(results.filter(r => r.status === 'fulfilled').length, MAX_OPEN_REQUESTS_PER_USER);
    assert.equal(await store.openCount(), MAX_OPEN_REQUESTS_PER_USER);
  });

  it('a withdrawn approval is gone at once, also for a read that was under way', async () => {
    const { store, facets } = make();
    const entry = await store.addApproved({ host: 'wiki.corp', admin: ADMIN });
    const list = facets.documents.list;
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    facets.documents.list = async (...args) => {
      const page = await list(...args);
      await gate; // the read has the old list in hand while the approval is withdrawn
      return page;
    };
    const reading = store.approvedHosts();
    await store.remove(entry.id);
    facets.documents.list = list;
    release();
    assert.deepEqual(await reading, ['wiki.corp'], 'that read saw the list before the removal');
    assert.deepEqual(await store.approvedHosts(), [], 'and did not keep it');
  });

  it('keeps one document per host and decides for everyone who asked', async () => {
    const { store } = make();
    const { entry, created } = await store.request({
      host: 'wiki.corp',
      user: USER,
      reason: 'why'
    });
    assert.equal(created, true);
    assert.equal(entry.id, domainIdFor('wiki.corp'));
    assert.equal((await store.request({ host: 'WIKI.corp', user: OTHER })).created, false);
    const decided = await store.decide(entry.id, {
      decision: 'declined',
      admin: ADMIN,
      note: 'not now'
    });
    assert.equal(decided.status, 'declined');
    assert.equal(decided.requesters.length, 2);
    // A declined host is not reopened by asking again, but an admin can reverse it.
    assert.equal((await store.request({ host: 'wiki.corp', user: USER })).entry.status, 'declined');
    assert.equal(
      (await store.decide(entry.id, { decision: 'approved', admin: ADMIN })).status,
      'approved'
    );
    await assert.rejects(
      store.decide('wd_00000000000000000000000000000000', { decision: 'approved', admin: ADMIN }),
      { code: 'NOT_FOUND' }
    );
    await assert.rejects(store.decide('../x', { decision: 'approved', admin: ADMIN }), {
      code: 'NOT_FOUND'
    });
  });

  it('lists open requests first, and counts them', async () => {
    const { store } = make();
    await store.addApproved({ host: 'a.corp', admin: ADMIN });
    await store.request({ host: 'b.corp', user: USER });
    const declined = (await store.request({ host: 'c.corp', user: USER })).entry;
    await store.decide(declined.id, { decision: 'declined', admin: ADMIN });
    const { items } = await store.list();
    assert.deepEqual(
      items.map(entry => [entry.host, entry.status]),
      [
        ['b.corp', 'requested'],
        ['a.corp', 'approved'],
        ['c.corp', 'declined']
      ]
    );
    assert.equal(await store.openCount(), 1);
  });

  it('covers an approved host and a wildcard, and forgets a withdrawn approval', async () => {
    const { store } = make();
    await store.addApproved({ host: 'wiki.corp', admin: ADMIN, note: 'direct' });
    const wildcard = await store.addApproved({ host: '*.dept.corp', admin: ADMIN });
    await store.request({ host: 'pending.corp', user: USER });
    let hosts = await store.approvedHosts(1000);
    assert.deepEqual([...hosts].sort(), ['*.dept.corp', 'wiki.corp']);
    assert.equal(DomainStore.covers(hosts, 'wiki.corp'), true);
    assert.equal(DomainStore.covers(hosts, 'a.dept.corp'), true);
    assert.equal(DomainStore.covers(hosts, 'dept.corp'), false);
    assert.equal(DomainStore.covers(hosts, 'pending.corp'), false);
    assert.equal(await store.remove(wildcard.id), true);
    hosts = await store.approvedHosts(1000);
    assert.deepEqual(hosts, ['wiki.corp'], 'a change is seen at once on this worker');
  });

  it('answers without storage as if nothing were approved, and refuses to keep a request', async () => {
    const store = new DomainStore({});
    assert.deepEqual(await store.approvedHosts(), []);
    await assert.rejects(store.request({ host: 'wiki.corp', user: USER }), {
      code: 'STORAGE_UNAVAILABLE'
    });
  });
});

describe('review findings', () => {
  it('reads a sitemap with hundreds of thousands of URLs without overflowing the stack, and caps what it keeps', async () => {
    const locs = count =>
      `<urlset>${Array.from({ length: count }, (_v, i) => `<url><loc>https://a.test/p${i}</loc></url>`).join('')}</urlset>`;
    const big = await collectSiteUrls({
      siteUrl: 'https://a.test',
      sitemapUrls: ['https://a.test/s.xml'],
      fetchText: async () => locs(300_000),
      maxUrls: 1_000_000
    });
    assert.equal(big.urls.length, 300_000);
    const capped = await collectSiteUrls({
      siteUrl: 'https://a.test',
      sitemapUrls: ['https://a.test/s.xml'],
      fetchText: async () => locs(MAX_RAW_LOCS + 5000),
      maxUrls: 1_000_000
    });
    assert.equal(capped.urls.length, MAX_RAW_LOCS);
  });

  it('keeps links and formatting from a crawled path out of the report', async () => {
    const hostile = 'https://a.test/de/[docs](https://other.example)/x*bold*_it_`code`<b>';
    const pages = [
      { url: hostile, text: words(200) },
      { url: `${hostile}/2`, text: words(300) }
    ];
    const analysis = await analyseCorpus(pages, { countTokens: t => t.length, prefix: '/de/' });
    const markdown = renderReport({
      name: 'N',
      analysis,
      nearDuplicates: { total: 0, pairs: [] },
      tokenizer: { method: 'heuristic', note: 'n' },
      meta: {
        crawlDate: '2026-11-10',
        siteUrl: 'https://a.test',
        prefix: '/de/',
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
    // No link of the site's own making: every bracket, parenthesis and marker is escaped.
    assert.ok(!markdown.includes('[docs](https://other.example)'));
    assert.ok(markdown.includes('\\[docs\\]\\(https://other.example\\)'));
    // (The URL parser already percent-encodes the backtick and the angle brackets of a path.)
    assert.ok(markdown.includes('\\*bold\\*\\_it\\_%60code%60%3Cb%3E'));
    // And a raw one in a stored address cannot end or open the link destination.
    assert.ok(!markdown.includes('`code`<b>'));
    // The fixed labels are as before.
    assert.ok(markdown.includes('| Full corpus |'));
  });

  it('answers another users corpus id at once, without waiting for the lock of a running crawl', async () => {
    const site = fakeSite({ pageCount: 3 });
    const { service, facets } = makeService(site);
    const { corpusId } = await service.discoverSite({ siteUrl: 'https://a.test' }, { user: USER });
    let lockCalls = 0;
    facets.locks.withLock = async () => {
      lockCalls += 1;
      return new Promise(() => {}); // a crawl that never lets go
    };
    await assert.rejects(service.crawlPages({ corpusId }, { user: OTHER }), {
      code: 'CORPUS_NOT_FOUND'
    });
    await assert.rejects(service.crawlPages({ corpusId: 'wc_unknown' }, { user: USER }), {
      code: 'CORPUS_NOT_FOUND'
    });
    assert.equal(lockCalls, 0, 'the lock was never asked for');
  });

  it('removes expired corpora of every owner, including their pages, and keeps the others', async () => {
    const facets = memoryFacets();
    const store = new CorpusStore(facets);
    const day = 86_400_000;
    const now = Date.parse('2026-11-10T12:00:00Z');
    const old = async (owner, ageDays) => {
      const corpus = await store.create(owner, { name: owner }, ['https://a.test/x']);
      await store.putPages(corpus.id, 0, [{ url: 'https://a.test/x', text: 'x' }]);
      facets.docs.get(`website-corpora/${corpus.id}`).data.createdAt = new Date(
        now - ageDays * day
      ).toISOString();
      return corpus.id;
    };
    const expiredA = await old('inactive-1', RETENTION_DAYS + 1);
    const expiredB = await old('inactive-2', RETENTION_DAYS + 30);
    const fresh = await old('active', 1);
    const result = await sweepWebsiteCorpora({ store, now: () => now });
    assert.deepEqual(result, { scanned: 3, deleted: 2, skipped: false });
    for (const id of [expiredA, expiredB]) {
      assert.ok(!facets.docs.has(`website-corpora/${id}`));
      assert.ok(
        ![...facets.blobMap.keys()].some(key => key.includes(id)),
        'pages and URL list went too'
      );
    }
    assert.ok(facets.docs.has(`website-corpora/${fresh}`));
    assert.ok([...facets.blobMap.keys()].some(key => key.includes(fresh)));
    assert.deepEqual(await sweepWebsiteCorpora({ store: new CorpusStore({}) }), {
      scanned: 0,
      deleted: 0,
      skipped: true
    });
  });

  it('confirms many near-duplicate pages by building each shingle set once', async () => {
    const base = Array.from({ length: 400 }, (_v, i) => `satz${i}`).join(' ');
    const pages = Array.from({ length: 70 }, (_v, i) => ({
      url: `https://a.test/p${i}`,
      text: `${base} eigener Satz Nummer ${i}`
    }));
    const started = Date.now();
    const result = await findNearDuplicates(pages);
    assert.equal(result.total, (70 * 69) / 2);
    assert.equal(result.truncated, false);
    assert.ok(Date.now() - started < 5000, 'took too long');
  });

  it('stops confirming after a budget on a site of near-identical pages, and says so', async () => {
    const base = Array.from({ length: 400 }, (_v, i) => `satz${i}`).join(' ');
    const pages = Array.from({ length: 300 }, (_v, i) => ({
      url: `https://a.test/p${i}`,
      text: `${base} eigener Satz Nummer ${i}`
    }));
    const started = Date.now();
    const result = await findNearDuplicates(pages);
    assert.equal(result.truncated, true);
    assert.equal(result.verified, MAX_NEAR_DUP_VERIFICATIONS);
    assert.equal(result.total, MAX_NEAR_DUP_VERIFICATIONS);
    assert.ok(result.pairs.length <= 25);
    assert.ok(Date.now() - started < 15000, 'took too long');
  });
});

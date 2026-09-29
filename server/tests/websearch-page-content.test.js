#!/usr/bin/env node

/**
 * What the page reader makes of a page (`tools/lib/pageContent.js`), how its
 * cache is bounded (`services/pageCache.js`), and the result shape and filters
 * shared by the script-backed search tools (`tools/lib/searchWithExtraction.js`).
 *
 * The reader used to flatten a page to one line of text, stop PDFs at page 10
 * and append "..." when it cut a page, without telling the model it had. These
 * tests pin down the replacement: Markdown that keeps headings, lists, tables
 * and links; explicit `truncated` / `totalLength` / `nextOffset`; every PDF page
 * within the length cap, titled from the PDF's metadata.
 *
 * Run: node --test server/tests/websearch-page-content.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  acceptLanguageFor,
  countWords,
  extractHtmlPage,
  extractPdf,
  pdfDate,
  sliceDocument
} from '../tools/lib/pageContent.js';
import {
  _clearPageCache,
  _pageCacheStats,
  getCachedPage,
  makePageCacheKey,
  MAX_PAGE_CACHE_CHARS,
  setCachedPage
} from '../services/pageCache.js';
import searchWithExtraction, {
  filterByFreshness,
  normalizeDomains,
  normalizeFreshness,
  normalizeSearchResult,
  withSiteFilter
} from '../tools/lib/searchWithExtraction.js';
import webSearchService, {
  SearchProvider,
  parseBraveWebResult
} from '../services/WebSearchService.js';

const ARTICLE = `<!doctype html>
<html lang="en"><head>
  <title>Release notes</title>
  <meta name="description" content="What changed in 5.5">
  <meta name="author" content="Docs Team">
  <style>body { color: red }</style>
</head><body>
  <header><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav></header>
  <main><article>
    <h1>Release 5.5</h1>
    <p>This release adds the page reader. Read the <a href="/docs/reader">reader docs</a> for details.
    ${'It keeps the structure of the page intact for the model. '.repeat(8)}</p>
    <h2>Changes</h2>
    <ul><li>Markdown output</li><li>Offsets for long pages</li></ul>
    <table>
      <tr><th>Setting</th><th>Default</th></tr>
      <tr><td>maxPageReads</td><td>5</td></tr>
    </table>
    <pre><code>npm run dev</code></pre>
  </article></main>
  <footer>© Example Corp — Imprint</footer>
</body></html>`;

describe('extractHtmlPage', () => {
  it('returns Markdown that keeps headings, lists, tables, links and code', () => {
    const page = extractHtmlPage(ARTICLE, { url: 'https://example.com/releases/5.5' });
    assert.equal(page.title, 'Release notes');
    assert.equal(page.description, 'What changed in 5.5');
    assert.equal(page.author, 'Docs Team');
    assert.equal(page.language, 'en');
    assert.match(page.markdown, /^#+ Release 5\.5$/m);
    assert.match(page.markdown, /^## Changes$/m);
    assert.match(page.markdown, /^- Markdown output$/m);
    assert.match(page.markdown, /^\| Setting \| Default \|$/m);
    assert.match(page.markdown, /^\| --- \| --- \|$/m);
    assert.match(page.markdown, /^\| maxPageReads \| 5 \|$/m);
    // Relative links are resolved against the page, so the model can open them.
    assert.match(page.markdown, /\[reader docs\]\(https:\/\/example\.com\/docs\/reader\)/);
    assert.match(page.markdown, /```\nnpm run dev\n```/);
    assert.equal(page.thin, false);
  });

  it('keeps newlines — the page is no longer flattened to one line', () => {
    const page = extractHtmlPage(ARTICLE, { url: 'https://example.com/' });
    assert.ok(page.markdown.split('\n').length > 8);
  });

  it('keeps in-page links as text and drops footnote markers and link tooltips', () => {
    const page = extractHtmlPage(
      `<html><body><article><h2><a href="#usage">Usage</a></h2>
        <p>${'Markdown is a lightweight markup language. '.repeat(10)}<sup class="reference"><a href="#cite_note-1">[1]</a></sup>
        See <a href="/wiki/Text_editor" title="Text editor">plain-text editors</a> and <a href="/icon"><img src="i.png"></a>.</p>
      </article></body></html>`,
      { url: 'https://en.wikipedia.org/wiki/Markdown' }
    );
    assert.match(page.markdown, /^## Usage$/m);
    assert.doesNotMatch(page.markdown, /cite_note|\[1\]/);
    assert.match(
      page.markdown,
      /\[plain-text editors\]\(https:\/\/en\.wikipedia\.org\/wiki\/Text_editor\)/
    );
    assert.doesNotMatch(page.markdown, /"Text editor"/);
    assert.doesNotMatch(page.markdown, /\[\]\(/);
  });

  it('drops navigation, footer and styles', () => {
    const page = extractHtmlPage(ARTICLE, { url: 'https://example.com/' });
    assert.doesNotMatch(page.markdown, /Imprint/);
    assert.doesNotMatch(page.markdown, /color: red/);
    assert.doesNotMatch(page.markdown, /\[Home\]/);
  });

  it('falls back to the content selectors when there is no article', () => {
    const listing = `<html><body><nav>Main menu</nav>
      <div class="content"><h2>Products</h2><ul>
        <li><a href="/p1">Product one</a></li><li><a href="/p2">Product two</a></li>
      </ul></div><footer>Footer</footer></body></html>`;
    const page = extractHtmlPage(listing, { url: 'https://shop.example/' });
    assert.equal(page.extractor, 'selectors');
    assert.match(page.markdown, /- \[Product one\]\(https:\/\/shop\.example\/p1\)/);
    assert.doesNotMatch(page.markdown, /Main menu/);
  });

  it('flags a page that renders nothing without JavaScript', () => {
    const page = extractHtmlPage(
      '<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>',
      { url: 'https://spa.example/' }
    );
    assert.equal(page.thin, true);
    assert.equal(page.title, 'App');
  });
});

describe('sliceDocument', () => {
  const text = Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i} ${'word '.repeat(20).trim()}`
  ).join('\n\n');

  it('reports a window that does not cover the document as truncated', () => {
    const slice = sliceDocument(text, { maxLength: 1000 });
    assert.equal(slice.truncated, true);
    assert.equal(slice.totalLength, text.length);
    assert.equal(slice.offset, 0);
    assert.ok(slice.content.length <= 1000);
    // It ends on a paragraph boundary, not mid-word.
    assert.match(slice.content, /word$/);
    assert.ok(slice.nextOffset > 0 && slice.nextOffset <= 1000);
  });

  it('continues from nextOffset until the whole document was read', () => {
    let offset = 0;
    let read = '';
    let calls = 0;
    for (;;) {
      const slice = sliceDocument(text, { offset, maxLength: 1500 });
      read += `${slice.content}\n\n`;
      calls += 1;
      if (!slice.truncated) {
        assert.equal(slice.nextOffset, null);
        break;
      }
      assert.ok(slice.nextOffset > offset);
      offset = slice.nextOffset;
    }
    assert.ok(calls > 1);
    assert.equal(read.trim(), text);
  });

  it('is not truncated when the document fits', () => {
    const slice = sliceDocument('short text', { maxLength: 5000 });
    assert.deepEqual(slice, {
      content: 'short text',
      offset: 0,
      nextOffset: null,
      truncated: false,
      totalLength: 10
    });
  });

  it('returns nothing past the end of the document', () => {
    const slice = sliceDocument('short text', { offset: 500, maxLength: 5000 });
    assert.equal(slice.content, '');
    assert.equal(slice.offset, 10);
    assert.equal(slice.truncated, false);
  });
});

describe('acceptLanguageFor', () => {
  it("asks for the user's language first, English as a fallback", () => {
    assert.equal(acceptLanguageFor('de'), 'de,en;q=0.8');
    assert.equal(acceptLanguageFor('de-CH'), 'de-CH,de;q=0.9,en;q=0.8');
    assert.equal(acceptLanguageFor('en_GB'), 'en-GB,en;q=0.9');
    assert.equal(acceptLanguageFor('en'), 'en');
  });

  it('falls back to English for anything that is not a language tag', () => {
    assert.equal(acceptLanguageFor(undefined), 'en-US,en;q=0.9');
    assert.equal(acceptLanguageFor('de\r\nX-Injected: 1'), 'en-US,en;q=0.9');
  });
});

describe('countWords', () => {
  it('counts words across languages and ignores Markdown punctuation', () => {
    assert.equal(countWords('## Überschrift\n\n- eins, zwei — drei'), 4);
    assert.equal(countWords(''), 0);
  });
});

/** A minimal, valid PDF with one line of text per page and an Info dictionary. */
function buildPdf(pageCount, { title } = {}) {
  const objects = [];
  const add = body => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pages = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= pageCount; i++) {
    const text = `BT /F1 12 Tf 72 720 Td (Page ${i} text) Tj ET`;
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
      )
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] =
    `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  const info = title ? add(`<< /Title (${title}) /CreationDate (D:20240131120000Z) >>`) : null;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${
    info ? ` /Info ${info} 0 R` : ''
  } >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('extractPdf', () => {
  it('reads past page 10 and takes the title from the PDF metadata', async () => {
    const doc = await extractPdf(pdfjs, buildPdf(12, { title: 'Annual Report' }), {
      url: 'https://example.com/files/report.pdf'
    });
    assert.equal(doc.title, 'Annual Report');
    assert.equal(doc.pageCount, 12);
    assert.equal(doc.pagesRead, 12);
    assert.match(doc.text, /Page 1 text/);
    assert.match(doc.text, /Page 12 text/);
    assert.equal(doc.publishedDate, '2024-01-31T12:00:00.000Z');
  });

  it('falls back to the file name when the PDF has no title', async () => {
    const doc = await extractPdf(pdfjs, buildPdf(1), {
      url: 'https://example.com/files/Quarterly%20Report.pdf'
    });
    assert.equal(doc.title, 'Quarterly Report.pdf');
  });

  it('parses PDF dates', () => {
    assert.equal(pdfDate("D:20240131120000+01'00'"), '2024-01-31T12:00:00.000Z');
    assert.equal(pdfDate('D:2024'), '2024-01-01T00:00:00.000Z');
    assert.equal(pdfDate('yesterday'), '');
  });
});

describe('page cache', () => {
  beforeEach(() => _clearPageCache());

  it('keys pages by URL and language', () => {
    const key = makePageCacheKey('https://example.com/', 'de,en;q=0.8');
    setCachedPage(key, { text: 'hallo' }, 5, 1000, 0);
    assert.deepEqual(getCachedPage(key, 10), { text: 'hallo' });
    assert.equal(getCachedPage(makePageCacheKey('https://example.com/', 'en'), 10), undefined);
  });

  it('expires pages after their TTL', () => {
    const key = makePageCacheKey('https://example.com/', 'en');
    setCachedPage(key, { text: 'x' }, 1, 1000, 0);
    assert.equal(getCachedPage(key, 1001), undefined);
    assert.equal(_pageCacheStats().entries, 0);
  });

  it('evicts the oldest pages to stay under its character budget', () => {
    const half = Math.floor(MAX_PAGE_CACHE_CHARS / 2);
    setCachedPage('a', { text: 'a' }, half, 60_000, 0);
    setCachedPage('b', { text: 'b' }, half, 60_000, 0);
    setCachedPage('c', { text: 'c' }, half, 60_000, 0);
    assert.equal(getCachedPage('a', 1), undefined);
    assert.ok(getCachedPage('b', 1));
    assert.ok(getCachedPage('c', 1));
    assert.ok(_pageCacheStats().chars <= MAX_PAGE_CACHE_CHARS);
  });

  it('never stores a page larger than the whole cache', () => {
    setCachedPage('huge', { text: 'x' }, MAX_PAGE_CACHE_CHARS + 1, 60_000, 0);
    assert.equal(getCachedPage('huge', 1), undefined);
  });
});

describe('search result shape and filters', () => {
  it('normalizes the filter arguments a model sends', () => {
    assert.equal(normalizeFreshness('Week'), 'week');
    assert.equal(normalizeFreshness('fortnight'), null);
    assert.deepEqual(
      normalizeDomains(['https://www.Example.com/path', 'site:docs.example.org', 'not a domain']),
      ['example.com', 'docs.example.org']
    );
    assert.deepEqual(normalizeDomains('a.com, b.org'), ['a.com', 'b.org']);
  });

  it('adds site: operators for providers that cannot scope domains', () => {
    assert.equal(withSiteFilter('pricing', ['a.com']), 'pricing site:a.com');
    assert.equal(
      withSiteFilter('pricing', ['a.com', 'b.org']),
      'pricing (site:a.com OR site:b.org)'
    );
    assert.equal(withSiteFilter('pricing', []), 'pricing');
  });

  it('keeps the fields a source card shows and drops the rest', () => {
    assert.deepEqual(
      normalizeSearchResult({
        title: 'T',
        url: 'https://www.example.com/a',
        description: 'd',
        publishedDate: '2026-09-01T00:00:00.000Z',
        favicon: 'https://icons.example/f.png',
        secret: 'provider internals'
      }),
      {
        title: 'T',
        url: 'https://www.example.com/a',
        description: 'd',
        hostname: 'example.com',
        publishedDate: '2026-09-01T00:00:00.000Z',
        favicon: 'https://icons.example/f.png'
      }
    );
  });

  it('drops dated results outside the freshness window and keeps undated ones', () => {
    const now = Date.parse('2026-09-29T00:00:00Z');
    const { results, dropped } = filterByFreshness(
      [
        { url: 'https://a', publishedDate: '2026-09-28T00:00:00Z' },
        { url: 'https://b', publishedDate: '2026-01-01T00:00:00Z' },
        { url: 'https://c' }
      ],
      'week',
      now
    );
    assert.deepEqual(
      results.map(r => r.url),
      ['https://a', 'https://c']
    );
    assert.equal(dropped, 1);
  });

  it('maps Brave dates, extra snippets and favicons', () => {
    assert.deepEqual(
      parseBraveWebResult({
        title: 'T',
        url: 'https://example.com/',
        description: 'd',
        age: '2 days ago',
        page_age: '2026-09-27T08:00:00',
        extra_snippets: ['one', 'two'],
        meta_url: { hostname: 'example.com', favicon: 'https://imgs.search.brave.com/f' }
      }),
      {
        title: 'T',
        url: 'https://example.com/',
        description: 'd',
        language: undefined,
        publishedDate: '2026-09-27T08:00:00.000Z',
        age: '2 days ago',
        snippets: ['one', 'two'],
        favicon: 'https://imgs.search.brave.com/f',
        hostname: 'example.com'
      }
    );
  });

  describe('searchWithExtraction', () => {
    const calls = [];
    class FakeProvider extends SearchProvider {
      constructor(name, { freshness = false, domains = false } = {}) {
        super();
        this.name = name;
        this.freshness = freshness;
        this.domains = domains;
      }
      getName() {
        return this.name;
      }
      supportsFreshness() {
        return this.freshness;
      }
      supportsDomainFilter() {
        return this.domains;
      }
      async search(query, options) {
        calls.push({ provider: this.name, query, options });
        return {
          results: [
            { title: 'New', url: 'https://a.example/new', publishedDate: new Date().toISOString() },
            { title: 'Old', url: 'https://a.example/old', publishedDate: '2001-01-01T00:00:00Z' },
            { title: 'Undated', url: 'https://a.example/undated' }
          ]
        };
      }
    }
    webSearchService.registerProvider(new FakeProvider('plain'));
    webSearchService.registerProvider(
      new FakeProvider('native', { freshness: true, domains: true })
    );

    beforeEach(() => {
      calls.length = 0;
    });

    it('falls back to site: and post-filtering for a provider without the filters', async () => {
      const result = await searchWithExtraction({
        query: 'release notes',
        provider: 'plain',
        component: 'Test',
        freshness: 'month',
        includeDomains: ['example.com']
      });
      assert.equal(calls[0].query, 'release notes site:example.com');
      assert.equal(calls[0].options.freshness, undefined);
      assert.equal(calls[0].options.includeDomains, undefined);
      assert.deepEqual(
        result.results.map(r => r.title),
        ['New', 'Undated']
      );
      assert.deepEqual(result.filters, { freshness: 'month', includeDomains: ['example.com'] });
      assert.match(result.note, /cannot filter by date/);
      // The model sees its own query, not the rewritten one.
      assert.equal(result.query, 'release notes');
    });

    it('hands the filters to a provider that supports them', async () => {
      const result = await searchWithExtraction({
        query: 'release notes',
        provider: 'native',
        component: 'Test',
        freshness: 'week',
        includeDomains: 'example.com'
      });
      assert.equal(calls[0].query, 'release notes');
      assert.equal(calls[0].options.freshness, 'week');
      assert.deepEqual(calls[0].options.includeDomains, ['example.com']);
      assert.equal(result.results.length, 3);
      assert.equal(result.note, undefined);
    });

    it('normalizes every result to the shared shape', async () => {
      const result = await searchWithExtraction({ query: 'q', provider: 'plain', component: 'T' });
      assert.deepEqual(Object.keys(result.results[2]).sort(), [
        'description',
        'hostname',
        'title',
        'url'
      ]);
      assert.equal(result.results[2].hostname, 'a.example');
    });
  });
});

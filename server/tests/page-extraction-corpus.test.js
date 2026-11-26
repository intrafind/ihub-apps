// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What reaches the model from a web page, pinned page by page.
 *
 * The page corpus of the red team (`tests/security/redteam/corpus/`) hides every injection
 * template in six places: visible text, white 1px text, the meta description, an HTML comment, a
 * `display:none` block and an image's alt text. This test runs all 114 pages through the two
 * extractions that turn HTML into text for a model and says, for each, whether the payload is in
 * what comes out and where:
 *
 * - the page reader (`extractHtmlPage`): what `read_url` hands the model, and what an HTML file in
 *   a project is imported as;
 * - the website corpus extraction (`extractPage`): what the corpus sizer counts as the text of a
 *   crawled page.
 *
 * The table is the contract. A change that lets a payload through a place that was closed, or
 * closes one that was open, fails here with the page named, and whoever makes it updates the table
 * and the note next to it. The nightly red team (`promptfooconfig.corpus.yaml`) asks a real model
 * about the places in `READER` that are open; this test is what keeps the closed ones closed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractHtmlPage } from '../services/pageReader/pageContent.js';
import { extractPage } from '../services/websiteCorpus/extract.js';

const { loadCorpus, loadHiddenCorpus } = await import('../../tests/security/redteam/corpus.mjs');

const cases = [...loadCorpus().cases, ...loadHiddenCorpus().cases];

/**
 * Where a payload ends up in the page reader's result, by the place it was hidden in. `markdown` is
 * the text `read_url` returns, `description` its description field; `null` is: nowhere.
 *
 * - `meta-description` is returned on purpose (it says what a page is about), and marked as the
 *   page's own words by the `sourceNotice` of the result.
 * - `white-text` is open and cannot be closed by reading the DOM: the extraction applies no CSS
 *   layout, so text that is only invisible by its colour or size looks like any other text.
 */
const READER = {
  visible: 'markdown',
  'white-text': 'markdown',
  'meta-description': 'description',
  'html-comment': null,
  'display-none': null,
  'image-alt': null
};

/**
 * KNOWN GAP. A page of which Readability finds no article (a short page, a listing, a landing page)
 * is read by the selector fallback, and that keeps text hidden by an inline `display:none`, the
 * `hidden` attribute or `visibility:hidden`; on an article page they are dropped. In the corpus the
 * page "Malicious tool result", whose body is one short `<pre>`, is such a page. When the fallback
 * drops hidden text, remove the template from this set, and flip the expectations in "hidden text
 * on a page with and without an article" below.
 */
const READER_KEEPS_DISPLAY_NONE = new Set(['Malicious tool result']);

/**
 * Whether the payload is in the text of the website corpus extraction. It keeps what a retrieval
 * index would get and removes only what is never content (scripts, styles, forms, nav, ...), and
 * it applies no CSS, so `display:none` text stays. Today the text only feeds the corpus sizer,
 * which counts it; if it ever feeds an index or a prompt, `display-none` below becomes a leak.
 * Image alt text, comments and the meta description are not in it.
 */
const SIZER = {
  visible: true,
  'white-text': true,
  'meta-description': false,
  'html-comment': false,
  'display-none': true,
  'image-alt': false
};

/**
 * Whether `text` carries the payload of a page: its canary, or, for the Base64 template whose
 * canary exists only inside the encoded instruction, a Base64 string that decodes to a text with it.
 */
function carries(text, canary) {
  if (text.includes(canary)) return true;
  return (text.match(/[A-Za-z0-9+/=]{40,}/g) || []).some(token =>
    Buffer.from(token, 'base64').toString('utf8').includes(canary)
  );
}

const expectedInReader = c =>
  c.delivery === 'display-none' && READER_KEEPS_DISPLAY_NONE.has(c.template)
    ? 'markdown'
    : READER[c.delivery];

const urlOf = c => `https://intranet.example/notes/${c.page}`;

describe('the corpus', () => {
  it('has every template in every place, so a gap in a table below is a gap in the test', () => {
    assert.equal(cases.length, 19 * 6);
    assert.deepEqual([...new Set(cases.map(c => c.delivery))].sort(), Object.keys(READER).sort());
    assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  });
});

describe('the page reader (read_url, HTML files in projects)', () => {
  for (const c of cases) {
    it(`${c.template} hidden in ${c.delivery}: ${expectedInReader(c) ? `reaches the model as ${expectedInReader(c)}` : 'does not reach the model'}`, () => {
      const page = extractHtmlPage(c.html, { url: urlOf(c) });
      const fields = {
        markdown: page.markdown,
        description: page.description,
        title: page.title,
        author: page.author,
        siteName: page.siteName
      };
      const where = Object.keys(fields).filter(field => carries(fields[field], c.canary));
      const expected = expectedInReader(c);
      assert.deepEqual(where, expected ? [expected] : [], `${c.id}: payload found in ${where}`);
    });
  }

  it('leaves out every image, with its alt text and its address', () => {
    for (const c of cases.filter(x => x.delivery === 'image-alt')) {
      const { markdown } = extractHtmlPage(c.html, { url: urlOf(c) });
      assert.doesNotMatch(markdown, /\[Image:|data:image\/|<img/, c.id);
    }
  });
});

describe('the website corpus extraction (corpus sizer)', () => {
  for (const c of cases) {
    it(`${c.template} hidden in ${c.delivery}: ${SIZER[c.delivery] ? 'is in the counted text' : 'is not in the counted text'}`, () => {
      const page = extractPage(c.html);
      assert.equal(carries(`${page.title}\n${page.text}`, c.canary), SIZER[c.delivery], c.id);
    });
  }
});

describe('hidden text on a page with and without an article', () => {
  const hidden =
    '<div style="display:none">HIDDEN-STYLE</div><div hidden>HIDDEN-ATTRIBUTE</div>' +
    '<span style="visibility:hidden">HIDDEN-VISIBILITY</span><p aria-hidden="true">HIDDEN-ARIA</p>';
  const read = html => extractHtmlPage(html, { url: 'https://intranet.example/page' });

  it('drops all four kinds on an article page, which Readability reads', () => {
    const sentences = 'The regional team reviewed the quarter and agreed on the next steps. ';
    const page = read(
      `<html><body><article><h1>Quarterly review</h1><p>${sentences.repeat(12)}</p>${hidden}<p>${sentences.repeat(4)}</p></article></body></html>`
    );
    assert.equal(page.extractor, 'readability');
    assert.doesNotMatch(page.markdown, /HIDDEN-/);
  });

  it('on a page without an article, the selector fallback drops aria-hidden text but KEEPS the other three (known gap)', () => {
    const page = read(
      `<html><body><nav>Menu</nav><div class="content"><h2>Products</h2><ul><li>One</li><li>Two</li></ul>${hidden}</div></body></html>`
    );
    assert.equal(page.extractor, 'selectors');
    assert.doesNotMatch(page.markdown, /HIDDEN-ARIA/);
    // KNOWN GAP: when the fallback learns to drop these, change the three matches to
    // doesNotMatch and remove 'Malicious tool result' from READER_KEEPS_DISPLAY_NONE.
    assert.match(page.markdown, /HIDDEN-STYLE/);
    assert.match(page.markdown, /HIDDEN-ATTRIBUTE/);
    assert.match(page.markdown, /HIDDEN-VISIBILITY/);
  });
});

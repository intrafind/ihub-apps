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
 * - `display-none` is closed on every kind of page, those Readability reads as an article and
 *   those the selector fallback reads (the corpus page "Malicious tool result" is one): see "hidden
 *   text on a page with and without an article" below.
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

const expectedInReader = c => READER[c.delivery];

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
  // Every way the markup hides an element that a browser honours without a stylesheet: the hidden
  // attribute and an inline display or visibility, in any case, spacing and with !important or a
  // comment. The upper-case spellings once passed on an article page: the DOM's style parser
  // does not know an upper-case property name, so Readability took the element for visible.
  const hiddenKinds = [
    ['display:none', '<div style="display:none">HIDDEN-1</div>'],
    ['an upper-case property name', '<div style="DISPLAY:none">HIDDEN-2</div>'],
    ['upper-case, spaced and !important', '<div style="Display : None !IMPORTANT">HIDDEN-3</div>'],
    ['a comment in the value', '<div style="display:/* x */none">HIDDEN-4</div>'],
    ['the hidden attribute', '<div hidden>HIDDEN-5</div>'],
    ['visibility:hidden in capitals', '<span style="VISIBILITY : HIDDEN">HIDDEN-6</span>'],
    ['visibility:collapse', '<span style="visibility:collapse">HIDDEN-7</span>'],
    ['among other declarations', '<p style="color:red;DISPLAY:none;margin:0">HIDDEN-8</p>'],
    ['a hidden parent', '<div style="display:none"><p>HIDDEN-9 <a href="/x">link</a></p></div>'],
    ['aria-hidden', '<p aria-hidden="true">HIDDEN-10</p>'],
    [
      'a later display:none over an earlier block',
      '<p style="display:block;display:none">HIDDEN-11</p>'
    ],
    [
      'an !important display:none over a later block',
      '<p style="display:none !important;display:block">HIDDEN-12</p>'
    ]
  ];
  const visibleKinds = [
    '<p style="display:block">VISIBLE-1</p>',
    '<p style="visibility:visible">VISIBLE-2</p>',
    '<p hidden-note="x">VISIBLE-3</p>',
    '<p style="content:\'display:none\'">VISIBLE-4</p>',
    '<p style="display">VISIBLE-5</p>',
    // The cascade: a later declaration wins, an earlier !important one beats a later normal one.
    '<p style="display:none;display:block">VISIBLE-6</p>',
    '<p style="display:block !important;display:none">VISIBLE-7</p>',
    // A semicolon inside a string or a parenthesis does not end a declaration.
    '<p style="--note:\'x;display:none;y\'">VISIBLE-8</p>',
    '<p style="background:url(a;display:none)">VISIBLE-9</p>',
    // visibility is inherited, and a descendant may show itself again.
    '<div style="visibility:hidden">HIDDEN-13<p style="visibility:visible">VISIBLE-10</p></div>',
    '<div style="visibility:hidden"><div style="VISIBILITY:visible">VISIBLE-11 <span style="visibility:hidden">HIDDEN-14</span></div></div>'
  ];

  const sentences = 'The regional team reviewed the quarter and agreed on the next steps. ';
  const pages = {
    'an article page (Readability)': {
      extractor: 'readability',
      wrap: body =>
        `<html><body><article><h1>Quarterly review</h1><p>${sentences.repeat(12)}</p>${body}<p>${sentences.repeat(4)}</p></article></body></html>`
    },
    'a page without an article (selector fallback)': {
      extractor: 'selectors',
      wrap: body =>
        `<html><body><nav>Menu</nav><div class="content"><h2>Products</h2><ul><li>One</li><li>Two</li></ul>${body}</div></body></html>`
    }
  };
  const read = html => extractHtmlPage(html, { url: 'https://intranet.example/page' });

  for (const [kind, { extractor, wrap }] of Object.entries(pages)) {
    describe(kind, () => {
      for (const [name, html] of hiddenKinds) {
        it(`drops ${name}`, () => {
          const page = read(wrap(html));
          assert.equal(page.extractor, extractor);
          assert.doesNotMatch(page.markdown, /HIDDEN-\d/);
        });
      }

      it('keeps text whose style does not hide it', () => {
        const page = read(wrap(visibleKinds.join('')));
        assert.equal(page.extractor, extractor);
        for (let n = 1; n <= 11; n++) {
          assert.match(page.markdown, new RegExp(`VISIBLE-${n}\\b`));
        }
        assert.doesNotMatch(page.markdown, /HIDDEN-\d/);
      });
    });
  }
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An HTML file in a project is read by the page reader's extraction, the one
 * way iHub turns HTML into text: its Markdown headings, and menus and footers
 * left out. A page longer than the reader's own character cap is kept in full
 * (the item's limit applies), not re-read by a second converter.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractText } from '../services/projects/extractText.js';
import { MAX_DOCUMENT_CHARS } from '../tools/lib/pageContent.js';

const page = body =>
  Buffer.from(
    `<html><head><title>Handbook</title></head><body>
      <nav><ul><li>Menu entry</li></ul></nav>
      <main><article>${body}</article></main>
      <footer><p>Footer notice</p></footer>
    </body></html>`
  );

describe('HTML files in a project', () => {
  it('keeps the headings and leaves menus and footers out', async () => {
    const { text, title } = await extractText({
      bytes: page(
        `<h1>Handbook</h1><h2>Rent</h2><p>${'Rent is due monthly. '.repeat(20)}</p><h2>Deposit</h2><p>${'Two months of rent. '.repeat(20)}</p>`
      ),
      contentType: 'text/html'
    });
    assert.match(text, /^## Rent/m);
    assert.match(text, /^## Deposit/m);
    assert.doesNotMatch(text, /Menu entry|Footer notice/);
    assert.equal(title, 'Handbook');
  });

  it('keeps a page longer than the page reader caps, as Markdown, to its end', async () => {
    const chapters = [];
    let length = 0;
    for (let i = 1; length <= MAX_DOCUMENT_CHARS + 20_000; i++) {
      const chapter = `<h2>Chapter ${i}</h2><p>${`Section ${i} says the lease continues. `.repeat(40)}</p>`;
      chapters.push(chapter);
      length += chapter.length;
    }
    chapters.push('<h2>Final chapter</h2><p>The very last sentence of the handbook.</p>');

    const { text, truncated } = await extractText({
      bytes: page(`<h1>Handbook</h1>${chapters.join('')}`),
      contentType: 'text/html'
    });
    assert.equal(truncated, false);
    assert.ok(text.length > MAX_DOCUMENT_CHARS);
    assert.match(text, /^## Final chapter/m);
    assert.match(text, /The very last sentence of the handbook\./);
    assert.doesNotMatch(text, /Menu entry|Footer notice/);
  });
});

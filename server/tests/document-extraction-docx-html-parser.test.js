// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Word extraction parses mammoth's HTML with domino (what Turndown ships), not jsdom. The output
 * must not change: `fixtures/docx-expected/*.txt` holds what the jsdom-based path produced for the
 * same generated documents (captured before the switch).
 *
 * Run: node --test server/tests/document-extraction-docx-html-parser.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocxDocument } from '../services/documentExtraction.js';
import { buildWordFixtures } from './helpers/docxFixtures.js';

const expectedDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'docx-expected'
);

describe('Word extraction (domino HTML parser)', async () => {
  const fixtures = await buildWordFixtures();
  for (const name of Object.keys(fixtures)) {
    it(`${name}: Markdown is identical to the jsdom-era output`, async () => {
      const expected = fs.readFileSync(path.join(expectedDir, `${name}.txt`), 'utf8');
      assert.equal(await extractDocxDocument(fixtures[name]), expected);
    });
  }

  it('keeps the expected structure of the document features', async () => {
    const text = await extractDocxDocument(fixtures.large40);
    assert.match(text, /^# Chapter 1: Section title/);
    assert.match(text, /\*\*Bold part\*\* and \*italic part\*/);
    assert.match(text, /\| Name \| Value \| Note \|/);
    assert.match(text, /^- Point two with <special> & "chars"$/m);
  });

  it('does not fetch or run anything from hostile HTML-like text', async () => {
    const { buildDocx } = await import('./helpers/docxFile.js');
    const bytes = await buildDocx({
      body: '<w:p><w:r><w:t>&lt;img src="http://127.0.0.1:9/x"&gt;&lt;script&gt;globalThis.__pwned=1&lt;/script&gt;</w:t></w:r></w:p>'
    });
    const text = await extractDocxDocument(bytes);
    assert.equal(globalThis.__pwned, undefined);
    assert.match(text, /script/);
  });

  it('still refuses an unsafe package', async () => {
    await assert.rejects(() => extractDocxDocument(Buffer.from('not a zip')), /Word|zip|package/i);
  });
});

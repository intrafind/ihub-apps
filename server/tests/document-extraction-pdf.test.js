/**
 * Structure-preserving PDF extraction on real pdf.js output (concepts/document-extraction/,
 * PR 3). The browser code runs the same shared functions on pdf.js in the page; jest cannot load
 * pdf.js (ESM only), so the assertions that depend on what pdf.js really reports — line ends,
 * spacer items, page labels, empty pages — live here.
 *
 * Run: node --test server/tests/document-extraction-pdf.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { extractPdfText } from '../../shared/documentExtraction/pdfText.js';
import { MIN_REAL_TEXT_CHARS, realTextLength } from '../../shared/documentExtraction/markers.js';
import { renderUserMessage } from '../../shared/promptContext.js';
import { attachDocumentPageImages } from '../services/chat/RequestBuilder.js';

/**
 * @param {Array<Array<{text: string, x?: number, y?: number}>|null>} pages - null = no text layer
 * @param {{labels?: boolean}} [options] - roman label for page 1, then decimal from 1
 */
async function buildPdf(pages, { labels = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const runs of pages) {
    const page = doc.addPage([595, 842]);
    for (const { text, x = 50, y = 750 } of runs || []) {
      page.drawText(text, { x, y, size: 11, font });
    }
  }
  if (labels) {
    doc.catalog.set(
      PDFName.of('PageLabels'),
      doc.context.obj({
        Nums: [
          0,
          doc.context.obj({ S: PDFName.of('r') }),
          1,
          doc.context.obj({ S: PDFName.of('D'), St: 1 })
        ]
      })
    );
  }
  return pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
}

describe('structured PDF text from real pdf.js', () => {
  it('T-PDF-01/02/03/07: labels, real lines, flagged empty page, hyphen at line end', async () => {
    const pdf = await buildPdf(
      [
        [
          { text: 'Dieser Vertrag gilt fuer alle Parteien und re-', y: 750 },
          { text: 'gelt die Zusammenarbeit.', y: 736 },
          { text: 'Zelle 1.1', y: 700 },
          { text: 'Zelle 1.2', x: 250, y: 700 }
        ],
        null,
        [{ text: 'Dritte Seite' }]
      ],
      { labels: true }
    );
    assert.deepEqual(await pdf.getPageLabels(), ['i', '1', '2']);
    assert.equal(
      await extractPdfText(pdf),
      [
        '[Page 1 (printed: i)]',
        'Dieser Vertrag gilt fuer alle Parteien und re-',
        'gelt die Zusammenarbeit.',
        'Zelle 1.1 Zelle 1.2',
        '',
        '[Page 2: no extractable text]',
        '',
        '[Page 3 (printed: 2)]',
        'Dritte Seite'
      ].join('\n')
    );
  });

  it('plain markers when the PDF defines no page labels', async () => {
    const pdf = await buildPdf([[{ text: 'Eins' }], [{ text: 'Zwei' }]]);
    assert.equal(await pdf.getPageLabels(), null);
    assert.equal(await extractPdfText(pdf), '[Page 1]\nEins\n\n[Page 2]\nZwei');
  });

  it('T-PDF-04: a PDF without any text layer assembles to nothing (scan)', async () => {
    const pdf = await buildPdf([null, null, null], { labels: true });
    assert.equal(await extractPdfText(pdf), '');
  });

  it('T-PDF-06: markers are not text — a short PDF stays below the threshold', async () => {
    const pdf = await buildPdf([[{ text: 'Nur ein Satz.' }], null]);
    const text = await extractPdfText(pdf);
    assert.match(text, /^\[Page 1\]\nNur ein Satz\.\n\n\[Page 2: no extractable text\]$/);
    assert.ok(text.length > MIN_REAL_TEXT_CHARS);
    assert.equal(realTextLength(text), 'Nur ein Satz.'.length);
    assert.ok(realTextLength(text) < MIN_REAL_TEXT_CHARS);
  });
});

describe('downstream of a scanned PDF (T-DOWN-02)', () => {
  const scan = {
    fileName: 'scan.pdf',
    fileType: 'application/pdf',
    content: '',
    pageImages: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB']
  };

  it('attaches the page images to the message', () => {
    const [message] = attachDocumentPageImages([{ role: 'user', content: 'x', fileData: scan }]);
    assert.equal(message.imageData.length, 2);
    assert.equal(message.imageData[0].fileType, 'image/jpeg');
  });

  it('lists the document with pages_as_images instead of text', () => {
    const rendered = renderUserMessage({ content: 'Fasse zusammen', files: scan });
    assert.match(rendered, /pages_as_images="2"/);
  });

  it('does not attach images to a PDF whose text was extracted', () => {
    const withText = { ...scan, content: '[Page 1]\nText' };
    const [message] = attachDocumentPageImages([
      { role: 'user', content: 'x', fileData: withText }
    ]);
    assert.equal(message.imageData, undefined);
  });
});

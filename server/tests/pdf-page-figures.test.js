// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How much of a PDF page pictures and drawings cover (the "smart" page
 * selection of text recognition): a chart-sized picture or a vector chart
 * counts, a logo or a rule line hardly, a full-page scan under a text layer
 * not at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PNG } from 'pngjs';

import { analyzePageFigures, coveredShare } from '../services/documents/pdf/pageFigures.js';

const TEXT = 'Some real text on this page, long enough to count as text for sure.';

async function samplePdf() {
  const image = new PNG({ width: 40, height: 20 });
  image.data.fill(120);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const picture = await doc.embedPng(PNG.sync.write(image));
  const page = () => {
    const p = doc.addPage([400, 300]);
    p.drawText(TEXT, { x: 20, y: 270, size: 10, font });
    return p;
  };
  page().drawImage(picture, { x: 20, y: 20, width: 360, height: 200 });
  page().drawImage(picture, { x: 350, y: 270, width: 30, height: 20 });
  const chart = page();
  for (let i = 0; i < 8; i += 1) {
    chart.drawRectangle({
      x: 40 + i * 40,
      y: 20,
      width: 25,
      height: 30 + i * 25,
      color: rgb(0.2, 0.4, 0.8)
    });
  }
  page().drawLine({ start: { x: 20, y: 260 }, end: { x: 380, y: 260 }, thickness: 1 });
  const scan = doc.addPage([400, 300]);
  scan.drawImage(picture, { x: 0, y: 0, width: 400, height: 300 });
  scan.drawText(TEXT, { x: 20, y: 270, size: 10, font });
  return Buffer.from(await doc.save());
}

describe('figure coverage of PDF pages', () => {
  it('measures pictures and drawings, not logos, rules or a scan under the text', async () => {
    const { pages } = await analyzePageFigures(await samplePdf());
    const percent = pages.map(entry => entry.figurePercent);
    assert.ok(percent[0] >= 50, `chart-sized picture: ${percent[0]}%`);
    assert.ok(percent[1] <= 5, `logo: ${percent[1]}%`);
    assert.ok(percent[2] >= 20, `vector bar chart: ${percent[2]}%`);
    assert.ok(percent[3] <= 5, `rule line: ${percent[3]}%`);
    assert.equal(percent[4], 0, 'a full-page scan under a text layer is no figure');
  });

  it('counts overlapping shapes once', () => {
    const view = [0, 0, 100, 100];
    const half = [0, 0, 100, 50];
    assert.equal(coveredShare([half, half, half], view), 0.5);
  });
});

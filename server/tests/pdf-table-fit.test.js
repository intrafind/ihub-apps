// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tables in generated PDFs stay on the page (services/documents/pdf/tableFit.js).
 *
 * pdfmake never breaks inside a word and gives every `*` column the width of
 * the widest word of any of them, so a Markdown table with many columns used
 * to run off the page and lose its right-hand columns.
 *
 * Run: node --test server/tests/pdf-table-fit.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { markdownToContent } from '../services/documents/pdf/markdownToPdfmake.js';
import { sanitizeBlocks } from '../services/documents/pdf/sanitizeBlocks.js';
import { renderPdfSpec } from '../services/documents/pdf/renderPdf.js';
import { resolveTheme } from '../services/documents/pdf/themes.js';
import { fitTable, breakLongWords } from '../services/documents/pdf/tableFit.js';
import { textMeasurerFor } from '../services/documents/pdf/fonts.js';

const A4_WIDTH = 595.28;
const MARGIN = 50;

function ctx(extra = {}) {
  return {
    theme: resolveTheme('default'),
    contentWidth: A4_WIDTH - 2 * MARGIN,
    contentHeight: 718,
    warnings: [],
    nodeCount: 0,
    imageBytes: 0,
    ...extra
  };
}

function markdownTable(columns, rows, cell) {
  const header = `| ${Array.from({ length: columns }, (_, c) => `Spalte${c} Kopf`).join(' | ')} |`;
  const divider = `|${'---|'.repeat(columns)}`;
  const body = Array.from(
    { length: rows },
    (_, r) => `| ${Array.from({ length: columns }, (_, c) => cell(r, c)).join(' | ')} |`
  );
  return [header, divider, ...body].join('\n');
}

/** The table nodes of converted Markdown. */
const tablesOf = content => content.filter(node => node.table?.headerRows === 1);

/** Every text item of every page, with the right edge of its box. */
async function textItems(buffer) {
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  const doc = await task.promise;
  const items = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const { items: page } = await (await doc.getPage(n)).getTextContent();
    for (const item of page) {
      if (item.str.trim()) items.push({ text: item.str, right: item.transform[4] + item.width });
    }
  }
  await task.destroy();
  return items;
}

/** How far the text of a rendered document reaches past the right margin. */
async function overflowPastMargin(markdown) {
  const { buffer, warnings } = await renderPdfSpec({ title: 't', markdown });
  const items = await textItems(buffer);
  const right = Math.max(...items.map(item => item.right));
  return { overflow: right - (A4_WIDTH - MARGIN), items, warnings };
}

// The comparison table of an "Azure embedding models" document that lost its
// last columns: eight columns, bold row labels, a few long words.
const COMPARISON = `| Kriterium | Azure OpenAI | Foundry Models | Azure ML | Azure AI Search | Azure SQL | Cosmos DB | Container/AKS |
|---|---|---|---|---|---|---|---|
| **Betriebsaufwand** | Niedrig | Niedrig | Hoch | Mittel | Mittel | Niedrig | Hoch |
| **Echtzeit-Inferenz** | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| **Compliance** | Enterprise | Enterprise | Enterprise | Enterprise | Enterprise | Enterprise | Enterprise |
| **Kosten** | Pay-per-Use | Pay-per-Use | Infrastruktur | Pay-per-Use | Pay-per-Use | Pay-per-Use | Infrastruktur |
| **Reifegrad** | GA | GA | GA | GA | GA (Preview) | Public Preview | GA |`;

describe('table fitting in Markdown tables', () => {
  it('keeps every column of a wide comparison table on the page', async () => {
    const { overflow, items, warnings } = await overflowPastMargin(COMPARISON);
    assert.ok(overflow <= 1, `text reaches ${overflow.toFixed(1)} pt past the margin`);
    assert.ok(
      items.some(item => item.text.includes('Container/AKS')),
      'the last column is there'
    );
    assert.deepEqual(warnings, []);
  });

  it('gives the columns percentages that fit the line and the longest word', () => {
    const [table] = tablesOf(markdownToContent(COMPARISON, ctx()));
    const shares = table.table.widths.map(w => Number.parseFloat(w));
    assert.equal(shares.length, 8);
    assert.ok(table.table.widths.every(w => w.endsWith('%')));
    const total = shares.reduce((a, b) => a + b, 0);
    assert.ok(total <= 100 && total > 98, `shares add up to ${total}`);
    // The 'Betriebsaufwand' and 'Infrastruktur' columns are not squeezed
    // below their longest word.
    assert.ok(shares[0] > shares[1], 'the label column is wider than a one-word column');
  });

  it('keeps a narrow table at its natural width', () => {
    const [table] = tablesOf(
      markdownToContent('| Modell | Tokens |\n|---|--:|\n| ada | 8191 |\n| large | 8191 |', ctx())
    );
    assert.deepEqual(table.table.widths, ['auto', 'auto']);
    assert.equal(table.layout, 'ihubTable');
  });

  it('fills the line when the text needs wrapping, giving the long column most of it', () => {
    const [table] = tablesOf(
      markdownToContent(
        `| Ansatz | Beschreibung |\n|---|---|\n| **Integrated Vectorization** | ${'Daten-Chunking und Vektorisierung werden extern verwaltet; '.repeat(3)} |`,
        ctx()
      )
    );
    const [first, second] = table.table.widths.map(w => Number.parseFloat(w));
    assert.ok(second > first, 'the description column is the wide one');
    assert.ok(first + second > 98);
    assert.equal(table.layout, 'ihubTable', 'normal padding is enough');
  });

  it('breaks a very long token inside its column instead of shrinking the table', async () => {
    const markdown =
      '| Name | URL | Hinweis |\n|---|---|---|\n' +
      `| a | https://example.com/${'a'.repeat(150)}/${'b'.repeat(60)} | ok |`;
    const [table] = tablesOf(markdownToContent(markdown, ctx()));
    assert.equal(table.table.body[1][0].fontSize, undefined, 'the font keeps its size');
    const url = table.table.body[1][1];
    assert.ok(JSON.stringify(url).includes('\u200b'), 'the token has places to wrap');
    const { overflow, warnings } = await overflowPastMargin(markdown);
    assert.ok(overflow <= 1, `text reaches ${overflow.toFixed(1)} pt past the margin`);
    assert.deepEqual(warnings, [], 'the break character is printable');
  });

  it('uses denser padding, then a smaller font, as columns pile up', async () => {
    const twelve = markdownTable(12, 3, (r, c) => `Wert${c} Text`);
    const [dense] = tablesOf(markdownToContent(twelve, ctx()));
    assert.equal(dense.layout, 'ihubTableDense');

    const twentyFive = markdownTable(25, 3, (r, c) => `Nummer${r}${c}`);
    const [tiny] = tablesOf(markdownToContent(twentyFive, ctx()));
    assert.equal(tiny.layout, 'ihubTableDense');
    assert.ok(tiny.table.body[0][0].fontSize <= 6.5, 'the font shrank to its floor');
    for (const markdown of [twelve, twentyFive]) {
      const { overflow } = await overflowPastMargin(markdown);
      assert.ok(overflow <= 1, `text reaches ${overflow.toFixed(1)} pt past the margin`);
    }
  });

  it('fits a table inside a list item and a quote', async () => {
    const table =
      '| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n| Betriebsaufwand | Infrastruktur | Verarbeitung | Integration | Kompatibilität | Enterprise |';
    const markdown = `- Liste\n  - Verschachtelt\n\n    ${table.replaceAll('\n', '\n    ')}\n\n> ${table.replaceAll('\n', '\n> ')}`;
    const { overflow } = await overflowPastMargin(markdown);
    assert.ok(overflow <= 1, `text reaches ${overflow.toFixed(1)} pt past the margin`);
  });

  it('prices a bold or monospace cell at its wider face', () => {
    const wide = textMeasurerFor('Sans', true)('Betriebsaufwand', 9);
    const regular = textMeasurerFor('Sans', false)('Betriebsaufwand', 9);
    assert.ok(wide > regular, 'bold is wider than regular');
  });
});

describe('fitTable', () => {
  const theme = resolveTheme('default');
  const cell = (text, extra = {}) => ({ text, ...extra });

  it('reports no word breaks when every word fits', () => {
    const fit = fitTable({
      rows: [
        [cell('Name', { bold: true }), cell('Wert', { bold: true })],
        [cell('a'), cell('b')]
      ],
      theme,
      available: 495
    });
    assert.equal(fit.breakAt, null);
    assert.equal(fit.shrunk, false);
  });

  it('shares the line when even capped words cannot all fit', () => {
    const columns = 40;
    const row = Array.from({ length: columns }, (_, i) => cell(`Wort${i}`));
    const fit = fitTable({ rows: [row, row], theme, available: 495 });
    assert.equal(fit.widths.length, columns);
    assert.ok(fit.breakAt, 'words are broken to their column');
    const total = fit.widths.reduce((a, w) => a + Number.parseFloat(w), 0);
    assert.ok(total <= 100, `shares add up to ${total}`);
  });

  it('breakLongWords leaves words that fit alone and splits the rest', () => {
    const measure = textMeasurerFor('Sans', false);
    assert.equal(breakLongWords('kurz und gut', 200, 9, measure), 'kurz und gut');
    const broken = breakLongWords('x'.repeat(100), 60, 9, measure);
    assert.ok(broken.includes('​'));
    assert.equal(broken.replaceAll('​', ''), 'x'.repeat(100), 'no character is lost');
    for (const chunk of broken.split('​')) assert.ok(measure(chunk, 9) <= 60);
  });
});

describe('table fitting in layout blocks', () => {
  const wideBlock = extra => ({
    table: {
      body: [
        [
          'Kriterium',
          'Azure OpenAI',
          'Foundry Models',
          'Azure ML',
          'Azure AI Search',
          'Azure SQL',
          'Cosmos DB',
          'Container/AKS'
        ],
        ['Betriebsaufwand', 'Niedrig', 'Niedrig', 'Hoch', 'Mittel', 'Mittel', 'Niedrig', 'Hoch']
      ],
      headerRows: 1,
      ...extra
    }
  });

  it('picks widths for a table whose author left them to the layout', () => {
    const [node] = sanitizeBlocks([wideBlock({})], ctx());
    assert.ok(
      node.table.widths.every(w => w.endsWith('%')),
      JSON.stringify(node.table.widths)
    );
    assert.ok(['ihubTable', 'ihubTableDense'].includes(node.layout));
  });

  it('treats an all-star widths array as left to the layout', () => {
    const [node] = sanitizeBlocks([wideBlock({ widths: new Array(8).fill('*') })], ctx());
    assert.ok(node.table.widths.every(w => w.endsWith('%')));
  });

  it("leaves the author's own widths alone", () => {
    const widths = [90, 50, 50, 50, 50, 50, 50, '*'];
    const [node] = sanitizeBlocks([wideBlock({ widths })], ctx());
    assert.deepEqual(node.table.widths, widths);
    assert.equal(node.layout, 'ihubTable');
  });

  it('leaves a table with a column span or an image cell alone', () => {
    const [spanned] = sanitizeBlocks(
      [
        {
          table: {
            body: [
              [{ text: 'Titel', colSpan: 2 }, {}],
              ['a', 'b']
            ]
          }
        }
      ],
      ctx()
    );
    assert.deepEqual(spanned.table.widths, ['*', '*']);
  });

  it('keeps a table with its own layout on that layout', () => {
    const [node] = sanitizeBlocks([{ ...wideBlock({}), layout: 'noBorders' }], ctx());
    assert.equal(node.layout, 'noBorders');
    assert.deepEqual(node.table.widths, new Array(8).fill('*'));
  });

  it('renders a wide block table inside the margins', async () => {
    const { buffer } = await renderPdfSpec({ title: 't', blocks: [wideBlock({})] });
    const items = await textItems(buffer);
    assert.ok(items.some(item => item.text.includes('Container/AKS')));
    assert.ok(Math.max(...items.map(item => item.right)) <= A4_WIDTH - MARGIN + 1);
  });
});

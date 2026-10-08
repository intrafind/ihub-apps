/**
 * Headings and tables in PDF text on real pdf.js output (concepts/document-extraction/,
 * release 2, WP-F). The browser code runs the same shared functions on pdf.js in the page; jest
 * cannot load pdf.js (ESM only), so the assertions that depend on what pdf.js really reports —
 * marked-content ids that tie text to the structure tree, resolved outline destinations, font
 * families — live here. The fixtures are built with pdf-lib, so no binary is committed.
 *
 * Run: node --test server/tests/document-extraction-pdf-structure.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  endMarkedContent
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { extractPdfText } from '../../shared/documentExtraction/pdfText.js';
import { realTextLength } from '../../shared/documentExtraction/markers.js';

/**
 * A page is a list of blocks:
 *  - `{ text, role?, size?, font? }` — one line; `role` (H1, P, …) tags it when the PDF is tagged
 *  - `{ table: [[cell, …], …], header? }` — rows of cells (`null` = empty cell); the first row
 *    is tagged TH when `header` is set
 *
 * @param {Array<Array<object>>} pages
 * @param {{tagged?: boolean, outline?: Array}} [options] - `outline`: `[{ title, page, items }]`
 */
async function buildPdf(pages, { tagged = true, outline = null } = {}) {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const fonts = {
    sans: await doc.embedFont(StandardFonts.Helvetica),
    mono: await doc.embedFont(StandardFonts.Courier)
  };
  const pageObjects = pages.map(() => doc.addPage([595, 842]));
  const topElements = [];
  const docElementRef = ctx.nextRef();
  const treeRootRef = ctx.nextRef();
  const parentTreeEntries = [];

  pages.forEach((blocks, pageIndex) => {
    const page = pageObjects[pageIndex];
    const owners = []; // struct element ref per MCID of this page
    let y = 790;
    const drawLeaf = (text, { x, size = 11, font = 'sans', role = 'P' }) => {
      const mcid = owners.length;
      if (tagged) {
        page.pushOperators(
          PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
            PDFName.of(role),
            ctx.obj({ MCID: mcid })
          ])
        );
      }
      page.drawText(text, { x, y, size, font: fonts[font] });
      if (tagged) page.pushOperators(endMarkedContent());
      return mcid;
    };
    const element = (role, parentRef, extra) => {
      const ref = ctx.nextRef();
      ctx.assign(
        ref,
        ctx.obj({ Type: 'StructElem', S: role, P: parentRef, Pg: page.ref, ...extra })
      );
      return ref;
    };

    for (const block of blocks) {
      if (block.table) {
        const tableRef = ctx.nextRef();
        const rowRefs = [];
        let rowY = y;
        block.table.forEach((row, rowIndex) => {
          const rowRef = ctx.nextRef();
          const cellRefs = row.map((cell, column) => {
            const role = block.header && rowIndex === 0 ? 'TH' : 'TD';
            y = rowY;
            if (cell === null) return element(role, rowRef, {});
            const mcid = drawLeaf(cell, { x: 50 + column * 140, role: 'P' });
            const cellRef = element(role, rowRef, { K: mcid });
            owners[mcid] = cellRef;
            return cellRef;
          });
          ctx.assign(
            rowRef,
            ctx.obj({ Type: 'StructElem', S: 'TR', P: tableRef, Pg: page.ref, K: cellRefs })
          );
          rowRefs.push(rowRef);
          rowY -= 20;
        });
        ctx.assign(
          tableRef,
          ctx.obj({
            Type: 'StructElem',
            S: 'Table',
            P: docElementRef,
            Pg: page.ref,
            K: rowRefs
          })
        );
        topElements.push(tableRef);
        y = rowY - 10;
      } else {
        const size = block.size || 11;
        const mcid = drawLeaf(block.text, { x: 50, ...block, size });
        const ref = element(block.role || 'P', docElementRef, { K: mcid });
        owners[mcid] = ref;
        topElements.push(ref);
        y -= size * 1.6 + 4;
      }
    }
    page.node.set(PDFName.of('StructParents'), ctx.obj(pageIndex));
    parentTreeEntries.push(pageIndex, owners);
  });

  if (tagged) {
    ctx.assign(
      docElementRef,
      ctx.obj({ Type: 'StructElem', S: 'Document', P: treeRootRef, K: topElements })
    );
    const parentTreeRef = ctx.nextRef();
    ctx.assign(parentTreeRef, ctx.obj({ Nums: parentTreeEntries }));
    ctx.assign(
      treeRootRef,
      ctx.obj({ Type: 'StructTreeRoot', K: [docElementRef], ParentTree: parentTreeRef })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), treeRootRef);
    doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  }

  if (outline) {
    const outlinesRef = ctx.nextRef();
    const build = (entries, parentRef) => {
      const refs = entries.map(() => ctx.nextRef());
      entries.forEach((entry, i) => {
        const dict = {
          Title: PDFHexString.fromText(entry.title),
          Parent: parentRef,
          Dest: [pageObjects[entry.page].ref, PDFName.of('XYZ'), null, 800, null]
        };
        if (i > 0) dict.Prev = refs[i - 1];
        if (i < entries.length - 1) dict.Next = refs[i + 1];
        if (entry.items && entry.items.length > 0) {
          const children = build(entry.items, refs[i]);
          dict.First = children[0];
          dict.Last = children[children.length - 1];
          dict.Count = entry.items.length;
        }
        ctx.assign(refs[i], ctx.obj(dict));
      });
      return refs;
    };
    const top = build(outline, outlinesRef);
    ctx.assign(
      outlinesRef,
      ctx.obj({ Type: 'Outlines', First: top[0], Last: top[top.length - 1], Count: top.length })
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  }

  return pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
}

const BODY = n =>
  Array.from({ length: n }, (_, i) => ({
    text: `Das ist Fliesstext Nummer ${i} mit genug Woertern fuer einen Absatz`
  }));

describe('headings and tables from the structure tree, on real pdf.js', () => {
  it('T-PDF-11/12: headings by level and a table with a header row', async () => {
    const pdf = await buildPdf([
      [
        { text: 'Vertrag', role: 'H1', size: 20 },
        { text: 'Dieser Vertrag gilt fuer alle Parteien.' },
        { text: '1.1 Definitionen', role: 'H2', size: 15 },
        {
          header: true,
          table: [
            ['Feld', 'Typ', 'Standard'],
            ['enabled', 'boolean', 'false'],
            ['limit', null, '5 MB']
          ]
        },
        { text: 'Danach folgt Text.' }
      ]
    ]);
    assert.equal(
      await extractPdfText(pdf),
      [
        '[Page 1]',
        '# Vertrag',
        'Dieser Vertrag gilt fuer alle Parteien.',
        '## 1.1 Definitionen',
        '',
        '| Feld | Typ | Standard |',
        '| --- | --- | --- |',
        '| enabled | boolean | false |',
        '| limit |  | 5 MB |',
        '',
        'Danach folgt Text.'
      ].join('\n')
    );
  });

  it('a heading of a later page and a table without header, page by page', async () => {
    const pdf = await buildPdf([
      [{ text: 'Seite eins', role: 'H1', size: 18 }],
      [{ table: [['a', 'b']] }, { text: 'Kapitel zwei', role: 'H2', size: 14 }]
    ]);
    assert.equal(
      await extractPdfText(pdf),
      '[Page 1]\n# Seite eins\n\n[Page 2]\n| a | b |\n\n## Kapitel zwei'
    );
  });

  it('the same content without tags is plain lines (nothing is guessed from a few lines)', async () => {
    const pdf = await buildPdf([[{ text: 'Vertrag', size: 11 }, { text: 'Text.' }]], {
      tagged: false
    });
    assert.equal(await extractPdfText(pdf), '[Page 1]\nVertrag\nText.');
  });
});

describe('headings from the outline, on real pdf.js', () => {
  it('T-PDF-13: entries are found on their pages; depth is the level', async () => {
    const pdf = await buildPdf(
      [
        [
          { text: 'Allgemeine Bestimmungen' },
          { text: 'Einleitungstext.' },
          { text: '1.1 Definitionen' }
        ],
        [{ text: 'Kuendigung' }, { text: 'Frist von drei Monaten.' }]
      ],
      {
        tagged: false,
        outline: [
          {
            title: 'Allgemeine Bestimmungen',
            page: 0,
            items: [{ title: 'Definitionen', page: 0 }]
          },
          { title: 'Kuendigung', page: 1 }
        ]
      }
    );
    assert.equal(
      await extractPdfText(pdf),
      [
        '[Page 1]',
        '# Allgemeine Bestimmungen',
        'Einleitungstext.',
        '## 1.1 Definitionen',
        '',
        '[Page 2]',
        '# Kuendigung',
        'Frist von drei Monaten.'
      ].join('\n')
    );
  });

  it('a tagged PDF whose tags carry no headings falls back to the outline', async () => {
    const pdf = await buildPdf([[{ text: 'Einleitung' }, { text: 'Fliesstext.' }]], {
      outline: [{ title: 'Einleitung', page: 0 }]
    });
    assert.equal(await extractPdfText(pdf), '[Page 1]\n# Einleitung\nFliesstext.');
  });

  it('an outline that points nowhere changes nothing', async () => {
    const pdf = await buildPdf([[{ text: 'Einleitung' }, { text: 'Fliesstext.' }]], {
      tagged: false,
      outline: [
        { title: 'Etwas anderes', page: 0 },
        { title: 'Noch etwas anderes', page: 0 }
      ]
    });
    assert.equal(await extractPdfText(pdf), '[Page 1]\nEinleitung\nFliesstext.');
  });
});

describe('headings from the font size, on real pdf.js', () => {
  it('T-PDF-14: larger short lines become headings, code in a fixed-width font is ignored', async () => {
    const code = Array.from({ length: 30 }, () => ({
      text: 'const value = computeSomething(argument);',
      font: 'mono',
      size: 11
    }));
    const pdf = await buildPdf(
      [
        [
          { text: 'Handbuch', size: 24 },
          ...BODY(4),
          { text: 'Installation', size: 16 },
          ...BODY(4),
          ...code.slice(0, 15)
        ],
        [...code.slice(15), ...BODY(4)]
      ],
      { tagged: false }
    );
    const text = await extractPdfText(pdf);
    const headings = text.split('\n').filter(line => line.startsWith('#'));
    assert.deepEqual(headings, ['# Handbuch', '## Installation']);
    // The code lines are still there, unchanged.
    assert.equal(text.split('const value = computeSomething(argument);').length - 1, 30);
  });

  it('a document of one size has no headings', async () => {
    const pdf = await buildPdf([BODY(12)], { tagged: false });
    assert.equal((await extractPdfText(pdf)).match(/^#/gm), null);
  });
});

describe('what the structure does not change', () => {
  it('only adds markers: the letters of the text stay the same, tagged or not', async () => {
    const pages = [
      [
        { text: 'Vertrag', role: 'H1', size: 20 },
        { text: 'Text eins.' },
        {
          header: true,
          table: [
            ['A', 'B'],
            ['c', 'd']
          ]
        }
      ]
    ];
    const tagged = await extractPdfText(await buildPdf(pages));
    const untagged = await extractPdfText(await buildPdf(pages, { tagged: false }));
    const letters = text => [...text.replace(/[^\p{L}\p{N}]/gu, '')].sort().join('');
    assert.equal(letters(tagged), letters(untagged));
    assert.notEqual(tagged, untagged);
  });

  it('T-PDF-06: Markdown added by the structure does not count as text', async () => {
    const pdf = await buildPdf([[{ text: 'Kurz', role: 'H1', size: 20 }]]);
    const text = await extractPdfText(pdf);
    assert.equal(text, '[Page 1]\n# Kurz');
    assert.equal(realTextLength(text), 'Kurz'.length);
  });

  it('a scan stays a scan', async () => {
    const pdf = await buildPdf([[], []]);
    assert.equal(await extractPdfText(pdf), '');
  });
});

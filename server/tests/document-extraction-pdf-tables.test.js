// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tables of untagged PDFs, read from the geometry of the text
 * (shared/documentExtraction/pdfTables.js). A PDF that does not tag its tables reaches the
 * extraction as a stream of items in drawing order, in which the lines of a wrapped cell are
 * interleaved with the other cells of the row; the positions on the page tell the table.
 *
 * Most cases use synthetic items so the geometry is explicit; the end-to-end ones extract PDFs
 * this server generates (pdfmake output, which carries no tags).
 *
 * Run: node --test server/tests/document-extraction-pdf-tables.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { detectTables } from '../../shared/documentExtraction/pdfTables.js';
import { pageBlocks } from '../../shared/documentExtraction/pdfStructure.js';
import { extractPdfText } from '../../shared/documentExtraction/pdfText.js';
import { renderPdfSpec } from '../services/documents/pdf/renderPdf.js';
import { buildPdf } from './helpers/structuredPdf.js';

/** A text item as pdf.js reports it. */
function item(str, x, y, { width, height = 10, fontName = 'f1', hasEOL = false } = {}) {
  return {
    str,
    dir: 'ltr',
    width: width ?? str.length * height * 0.5,
    height,
    transform: [height, 0, 0, height, x, y],
    fontName,
    hasEOL
  };
}

/**
 * Items of a grid, row by row. A cell may be an array of lines (a wrapped cell). The stream
 * order is the drawing order of a typical producer: for each row, line by line across the
 * cells, which interleaves the lines of a wrapped cell with the other cells of the row.
 */
function grid(rows, xs, { y = 700, pitch = 22, wrap = 11, fontOf = () => 'f1' } = {}) {
  const items = [];
  let top = y;
  rows.forEach((row, r) => {
    const depth = Math.max(...row.map(cell => (Array.isArray(cell) ? cell.length : 1)));
    for (let line = 0; line < depth; line += 1) {
      const cells = row
        .map((cell, c) => ({
          c,
          text: Array.isArray(cell) ? cell[line] : line === 0 ? cell : null
        }))
        .filter(cell => cell.text);
      cells.forEach((cell, k) => {
        items.push(
          item(cell.text, xs[cell.c], top - line * wrap, {
            fontName: fontOf(r, cell.c),
            hasEOL: k === cells.length - 1
          })
        );
      });
    }
    top -= (depth - 1) * wrap + pitch;
  });
  return items;
}

const XS = [50, 170, 300, 430];

describe('detectTables on the geometry of a page', () => {
  it('reads a grid as a table, in rows and columns', () => {
    const items = grid(
      [
        ['Modell', 'Anbieter', 'Tokens', 'Status'],
        ['ada-002', 'OpenAI', '8191', 'Legacy'],
        ['voyage-3', 'Voyage AI', '8192', 'Neu'],
        ['embed-v4', 'Cohere', '8193', 'Stabil']
      ],
      XS
    );
    const [table] = detectTables(items);
    assert.equal(detectTables(items).length, 1);
    assert.deepEqual(
      table.rows.map(row => row.cells),
      [
        ['Modell', 'Anbieter', 'Tokens', 'Status'],
        ['ada-002', 'OpenAI', '8191', 'Legacy'],
        ['voyage-3', 'Voyage AI', '8192', 'Neu'],
        ['embed-v4', 'Cohere', '8193', 'Stabil']
      ]
    );
    assert.equal(table.members.size, 16, 'every item of the table is claimed');
  });

  it('puts the lines of a wrapped cell into one row, not interleaved with the others', () => {
    const items = grid(
      [
        ['Kriterium', ['Azure', 'OpenAI'], 'Foundry Models', ['Azure', 'SQL']],
        ['Betriebsaufwand', 'Niedrig', 'Niedrig', 'Mittel'],
        [['Echtzeit-', 'Inferenz'], '✔', '✔', '✔'],
        ['Kosten', ['Pay-per-', 'Use'], 'Pay-per-Use', ['Pay-per-', 'Use']],
        ['Reifegrad', 'GA', 'GA', ['GA', '(Preview)']]
      ],
      XS
    );
    const [table] = detectTables(items);
    assert.deepEqual(
      table.rows.map(row => row.cells),
      [
        ['Kriterium', 'Azure OpenAI', 'Foundry Models', 'Azure SQL'],
        ['Betriebsaufwand', 'Niedrig', 'Niedrig', 'Mittel'],
        ['Echtzeit- Inferenz', '✔', '✔', '✔'],
        ['Kosten', 'Pay-per- Use', 'Pay-per-Use', 'Pay-per- Use'],
        ['Reifegrad', 'GA', 'GA', 'GA (Preview)']
      ]
    );
  });

  it('keeps a wide header that reaches into the gap above narrow cells', () => {
    const items = grid(
      [
        ['Kriterium', 'Azure AI Search und mehr', 'B'],
        ['Hoch', 'ja', 'x'],
        ['Mittel', 'nein', 'y'],
        ['Niedrig', 'ja', 'z']
      ],
      [50, 150, 330]
    );
    const [table] = detectTables(items);
    assert.equal(table.rows[0].cells[1], 'Azure AI Search und mehr');
    assert.equal(table.rows.length, 4);
  });

  it('marks a first row set in another font as the header, and only then', () => {
    const rows = [
      ['Modell', 'Anbieter', 'Status'],
      ['ada', 'OpenAI', 'Legacy'],
      ['voyage', 'Voyage', 'Neu'],
      ['embed', 'Cohere', 'Stabil']
    ];
    const bold = grid(rows, XS, { fontOf: r => (r === 0 ? 'bold' : 'regular') });
    assert.equal(detectTables(bold)[0].rows[0].header, true);
    assert.equal(detectTables(bold)[0].rows[1].header, false);
    const plain = grid(rows, XS);
    assert.equal(detectTables(plain)[0].rows[0].header, false, 'nothing sets it apart');
  });

  it('does not guess a table from two rows', () => {
    assert.deepEqual(
      detectTables(
        grid(
          [
            ['Modell', 'Anbieter', 'Status'],
            ['ada', 'OpenAI', 'Legacy']
          ],
          XS
        )
      ),
      []
    );
  });

  it('does not read a bulleted list as a table', () => {
    const items = [];
    [
      'Erster Punkt der Liste',
      'Zweiter Punkt der Liste',
      'Dritter Punkt der Liste',
      'Vierter'
    ].forEach((text, k) => {
      items.push(item('•', 50, 700 - k * 16, { width: 4 }));
      items.push(item(text, 64, 700 - k * 16, { hasEOL: true }));
    });
    assert.deepEqual(detectTables(items), []);
  });

  it('does not read a table of contents as a table', () => {
    const items = [];
    [
      ['Einleitung', '3'],
      ['Verfügbare Modelle', '4'],
      ['Vergleich der Ansätze', '10'],
      ['Zusammenfassung', '11']
    ].forEach(([title, page], k) => {
      items.push(item(title, 50, 700 - k * 18));
      items.push(item(page, 520, 700 - k * 18, { hasEOL: true }));
    });
    assert.deepEqual(detectTables(items), []);
  });

  it('does not read two columns of prose as a table', () => {
    const left = [
      'dies ist ein langer satz, der sich über',
      'mehrere zeilen der linken spalte erstreckt',
      'und mitten im wort weitergeht, weil der',
      'text einer zeitung so gesetzt wird, wie es',
      'der satz eben verlangt und nicht anders'
    ];
    const right = [
      'die rechte spalte setzt den text fort, der',
      'unten links aufgehört hat, und läuft dann',
      'noch ein gutes stück weiter, bis auch sie',
      'ihr ende erreicht hat und der absatz zu',
      'ende ist, ohne dass eine tabelle dabei wäre'
    ];
    const items = [];
    left.forEach((text, k) => {
      items.push(item(text, 50, 700 - k * 12, { width: 230 }));
      items.push(item(right[k], 320, 700 - k * 12, { width: 230, hasEOL: true }));
    });
    assert.deepEqual(detectTables(items), []);
  });

  it('does not read justified lines, whose word gaps are different on every line, as a table', () => {
    const items = [];
    let seed = 7;
    const next = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let line = 0; line < 8; line += 1) {
      let x = 50;
      for (let word = 0; word < 7; word += 1) {
        const width = 22 + Math.floor(next() * 20);
        items.push(item(`wort${word}`, x, 700 - line * 13, { width, hasEOL: word === 6 }));
        x += width + 7 + next() * 8;
      }
    }
    assert.deepEqual(detectTables(items), []);
  });

  it('leaves code in a fixed-width font alone', () => {
    const rows = [
      ['a = 1', 'b = 2', 'c = 3'],
      ['d = 4', 'e = 5', 'f = 6'],
      ['g = 7', 'h = 8', 'i = 9']
    ];
    const items = grid(rows, XS);
    const styles = { f1: { fontFamily: 'monospace' } };
    assert.equal(detectTables(items, styles).length, 0);
    assert.equal(detectTables(items, { f1: { fontFamily: 'sans-serif' } }).length, 1);
  });

  it('ignores rotated text and gives up on pages with an absurd number of items', () => {
    const rotated = grid(
      [
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
        ['g', 'h', 'i']
      ],
      XS
    ).map(it => ({ ...it, transform: [0, it.height, -it.height, 0, ...it.transform.slice(4)] }));
    assert.deepEqual(detectTables(rotated), []);
    const huge = Array.from({ length: 30_001 }, (_, k) => item('x', 50 + (k % 3) * 100, 700 - k));
    assert.deepEqual(detectTables(huge), []);
  });

  it('splits a region at a line that spans the columns', () => {
    const rows = (prefix, count) =>
      Array.from({ length: count }, (_, k) => [`${prefix}${k}`, 'eins', 'zwei', 'drei']);
    const upper = grid(rows('A', 3), XS, { y: 700 });
    const note = [
      item('Eine Zwischenzeile die über alle Spalten hinweg läuft und lang ist', 50, 622, {
        width: 400,
        hasEOL: true
      })
    ];
    const lower = grid(rows('B', 3), XS, { y: 600 });
    const tables = detectTables([...upper, ...note, ...lower]);
    assert.equal(tables.length, 2, 'two tables, the line between them is text');
    assert.ok(!tables.some(t => t.rows.some(r => r.cells.join(' ').includes('Zwischenzeile'))));
  });
});

describe('tables in the blocks of a page', () => {
  const rows = [
    ['Modell', 'Anbieter', 'Status'],
    ['ada', 'OpenAI', 'Legacy'],
    ['voyage', 'Voyage', 'Neu'],
    ['embed', 'Cohere', 'Stabil']
  ];

  it('puts the table where its text was, between the lines around it', () => {
    const before = [item('Vorher steht ein Satz.', 50, 760, { width: 200, hasEOL: true })];
    const after = [item('Danach geht der Text weiter.', 50, 560, { width: 200, hasEOL: true })];
    const blocks = pageBlocks([...before, ...grid(rows, XS), ...after], null, null);
    assert.deepEqual(
      blocks.map(block => block.type),
      ['line', 'table', 'line']
    );
    assert.equal(blocks[1].rows.length, 4);
  });

  it('keeps the plain lines when a line of the stream mixes the table with other text', () => {
    const items = grid(rows, XS);
    // The producer drew the page number between two cells of the same stream line: the stream
    // reads "Status Seite 1" as one line while the geometry says the table owns only "Status".
    items[2].hasEOL = false;
    items.splice(3, 0, item('Seite 1', 50, 60, { hasEOL: true }));
    const blocks = pageBlocks(items, null, null);
    assert.ok(
      blocks.every(block => block.type === 'line'),
      'stream and geometry disagree'
    );
    assert.ok(
      blocks.some(block => block.text.includes('Seite 1')),
      'no text is lost'
    );
  });

  it('does not touch a page whose tables the PDF tags', () => {
    // A tree that has a table: the structure tree decides, the geometry is not consulted.
    const tree = {
      role: 'Root',
      children: [
        {
          role: 'Table',
          children: [
            { role: 'TR', children: [{ role: 'TD', children: [{ type: 'content', id: 'p1' }] }] }
          ]
        }
      ]
    };
    const items = [
      { type: 'beginMarkedContentProps', id: 'p1' },
      ...grid(rows, XS),
      { type: 'endMarkedContent' }
    ];
    const blocks = pageBlocks(items, tree, null);
    assert.equal(blocks.filter(block => block.type === 'table').length, 1);
    assert.equal(
      blocks.find(block => block.type === 'table').rows.length,
      1,
      'only the tagged row'
    );
  });
});

/** The text of a PDF this server generates, through the same extraction as an upload. */
async function extractGenerated(spec) {
  const { buffer } = await renderPdfSpec({ title: 't', ...spec });
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
  try {
    return await extractPdfText(await task.promise);
  } finally {
    await task.destroy();
  }
}

const tableLines = text => text.split('\n').filter(line => line.startsWith('|'));

describe('tables of generated PDFs, extracted end to end', () => {
  it('turns a Markdown table with wrapped cells into a Markdown table again', async () => {
    const text = await extractGenerated({
      markdown: `| Kriterium | Azure OpenAI | Foundry Models | Azure ML | Azure AI Search | Azure SQL |
|---|---|---|---|---|---|
| **Betriebsaufwand** | Niedrig | Niedrig | Hoch | Mittel | Mittel |
| **Echtzeit-Inferenz** | ✔ | ✔ | ✔ | ✔ | ✔ |
| **Kosten** | Pay-per-Use | Pay-per-Use | Infrastruktur | Pay-per-Use | Pay-per-Use |
| **Reifegrad** | GA | GA | GA | GA | GA (Preview) |`
    });
    const lines = tableLines(text);
    assert.equal(lines.length, 6, text);
    assert.equal(
      lines[0],
      '| Kriterium | Azure OpenAI | Foundry Models | Azure ML | Azure AI Search | Azure SQL |'
    );
    assert.equal(
      lines[1],
      '| --- | --- | --- | --- | --- | --- |',
      'the bold first row is the header'
    );
    assert.ok(lines.includes('| Betriebsaufwand | Niedrig | Niedrig | Hoch | Mittel | Mittel |'));
    assert.ok(
      lines.some(line => line.startsWith('| Reifegrad |') && line.endsWith('| GA (Preview) |'))
    );
    assert.equal(text.split('Kriterium').length - 1, 1, 'no cell text is left outside the table');
  });

  it('reads the long text of a cell in order, in the cell it belongs to', async () => {
    const description =
      'Eingebaute Daten-Chunking und Vektorisierung; verwendet Indexer, Skillsets und eingebettete Custom Skills, die auf externe Embedding-Modelle verweisen';
    const text = await extractGenerated({
      markdown: `| Ansatz | Beschreibung |
|---|---|
| **Integrated Vectorization** | ${description} |
| **Manual Vectorization** | Daten-Chunking und Vektorisierung werden extern verwaltet |
| **Hybrid** | Beides zusammen |`
    });
    const lines = tableLines(text);
    assert.equal(lines.length, 5, text);
    assert.ok(lines[2].startsWith('| Integrated Vectorization | Eingebaute Daten-Chunking'));
    const cell = lines[2].split('|')[2].trim();
    // A line that ends in a hyphen keeps a space after it: `Bundes-` / `und Landesrecht` must stay
    // readable, so nothing is dehyphenated.
    assert.equal(cell.replaceAll('- ', '-'), description, 'the wrapped lines come out in order');
  });

  it('keeps a table that runs over page breaks as one table per page, header repeated', async () => {
    const rowsMd = Array.from(
      { length: 70 },
      (_, k) => `| Eintrag ${k} | Wert ${k} | Notiz ${k} |`
    );
    const text = await extractGenerated({
      markdown: ['| Name | Wert | Notiz |', '|---|---|---|', ...rowsMd].join('\n')
    });
    const lines = tableLines(text);
    const pages = text.match(/\[Page \d+\]/g).length;
    assert.ok(pages >= 2, 'the table needs more than one page');
    assert.equal(
      lines.filter(line => line === '| Name | Wert | Notiz |').length,
      pages,
      'the header is repeated on every page'
    );
    assert.equal(lines.filter(line => line.startsWith('| Eintrag')).length, 70, 'no row is lost');
  });

  it('leaves lists, a table of contents, code and plain paragraphs as lines', async () => {
    const text = await extractGenerated({
      toc: true,
      markdown: `# Eins

Ein Absatz mit genug Text, damit er mehrere Zeilen füllt und zeigt, dass Fließtext kein Tabellenkandidat ist, auch wenn er ordentlich gesetzt wird.

- Erster Punkt der Liste
- Zweiter Punkt der Liste
- Dritter Punkt der Liste
- Vierter Punkt der Liste

\`\`\`python
client = AzureOpenAI(api_key="x", api_version="y", endpoint="z")
response = client.embeddings.create(model="m", input="i", dimensions=256)
\`\`\`

# Zwei

Noch ein Absatz.`
    });
    assert.deepEqual(tableLines(text), [], text);
    assert.ok(text.includes('Erster Punkt der Liste'));
    assert.ok(text.includes('client = AzureOpenAI'));
  });
});

describe('a PDF built with pdf-lib and no tags', () => {
  it('reads a table drawn as aligned text', async () => {
    const pdf = await buildPdf(
      [
        [
          { text: 'Ein Satz vor der Tabelle.' },
          {
            table: [
              ['Name', 'Alter', 'Ort'],
              ['Anna', '31', 'Köln'],
              ['Ben', '27', 'Bonn'],
              ['Cem', '45', 'Essen']
            ]
          },
          { text: 'Ein Satz nach der Tabelle.' }
        ]
      ],
      { tagged: false }
    );
    const text = await extractPdfText(pdf);
    assert.equal(
      text,
      [
        '[Page 1]',
        'Ein Satz vor der Tabelle.',
        '',
        '| Name | Alter | Ort |',
        '| Anna | 31 | Köln |',
        '| Ben | 27 | Bonn |',
        '| Cem | 45 | Essen |',
        '',
        'Ein Satz nach der Tabelle.'
      ].join('\n')
    );
  });
});

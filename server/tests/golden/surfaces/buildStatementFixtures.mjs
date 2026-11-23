#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Builds the synthetic statements under `tests/fixtures/stellungnahmen/`.
 *
 * The files are committed; this script is how they were made and how one is
 * changed. Running it writes new bytes for the PDF and DOCX files (both
 * formats hold the time they were made), so run it only to change a fixture,
 * and record the legacy workflow goldens again afterwards.
 *
 *   node server/tests/golden/surfaces/buildStatementFixtures.mjs
 *
 * Everything in the statements is invented: the draft law, the paragraphs,
 * the organisations and the people.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { buildDocx, p } from '../../helpers/docxFile.js';
import { buildPdfBytes } from '../../helpers/structuredPdf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../../tests/fixtures/stellungnahmen');

const line = text => ({ text, role: 'P' });
const heading = text => ({ text, role: 'H1', size: 16 });

/** A statement as a PDF with a text layer. */
async function verbandPdf() {
  return buildPdfBytes([
    [
      heading('Stellungnahme des Verbands der Musterkassen'),
      line('zum Entwurf eines Gesetzes zur Neuordnung der Musterleistungen (MLNG)'),
      line('Der Verband begrüßt das Ziel des Entwurfs, lehnt aber die Befristung in § 12 ab.'),
      line('Zu § 12 Absatz 2 MLNG: Die Bezugsdauer darf nicht auf 52 Wochen begrenzt werden.'),
      line('Wir fordern, § 12 Absatz 2 zu streichen und die geltende Regelung beizubehalten.'),
      line('Zu § 14 MLNG: Die Meldefrist von drei Tagen ist für kleine Kassen nicht einzuhalten.'),
      line('Wir fordern, die Meldefrist in § 14 auf zehn Tage zu verlängern.')
    ],
    [
      heading('Begründung'),
      line('Die Begrenzung trifft vor allem langfristig erkrankte Versicherte.'),
      line('Nach unseren Zahlen wären jährlich etwa 4.200 Versicherte betroffen.'),
      line('Musterstadt, im März. Dr. Erika Beispiel, Vorsitzende')
    ]
  ]);
}

const cell = text => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
const row = cells => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
const table = rows =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows.map(row).join('')}</w:tbl>`;

/** A statement as a DOCX. */
async function kammerDocx() {
  return buildDocx({
    body:
      p('Stellungnahme der Musterkammer Nord') +
      p('zum Entwurf eines Gesetzes zur Neuordnung der Musterleistungen (MLNG)') +
      p('Die Kammer unterstützt die Befristung in § 12 Absatz 2 MLNG ausdrücklich.') +
      p('Wir fordern jedoch, in § 12 Absatz 3 eine Härtefallregelung aufzunehmen.') +
      p('Zu § 20 MLNG: Die Übergangsfrist von sechs Monaten ist zu kurz.') +
      p('Wir fordern eine Übergangsfrist von mindestens zwölf Monaten.')
  });
}

/** A statement with umlauts, sharp s, quotation marks and a table. */
async function umlauteDocx() {
  return buildDocx({
    body:
      p('Stellungnahme des Bündnisses für Ärztinnen, Ärzte und Pflegekräfte') +
      p('zum Entwurf des MLNG – Änderungsvorschläge im Überblick') +
      p(
        'Die Größe der Übergangsbeträge ist „unzureichend“; das Maß der Kürzung übersteigt das Zumutbare.'
      ) +
      table([
        ['Paragraph', 'Geltende Fassung', 'Änderungsvorschlag'],
        ['§ 12 Abs. 2', '78 Wochen', 'Beibehaltung der 78 Wochen'],
        ['§ 14', 'Meldefrist 3 Tage', 'Meldefrist 10 Tage'],
        ['§ 20', 'Übergang 6 Monate', 'Übergang 18 Monate, zusätzlich Härtefälle']
      ]) +
      p('Für Rückfragen: Jörg Öztürk-Müller, Geschäftsführung, Straße der Einheit 1, Köln')
  });
}

/** A long statement: 40 pages of numbered remarks. */
async function langPdf() {
  const pages = [];
  for (let page = 0; page < 40; page++) {
    const blocks = [];
    if (page === 0) {
      blocks.push(heading('Stellungnahme der Arbeitsgemeinschaft Musterverbände'));
      blocks.push(line('zum Entwurf des MLNG, ausführliche Fassung mit allen Einzelanmerkungen'));
    }
    for (let n = 0; n < 30; n++) {
      const number = page * 30 + n + 1;
      blocks.push(
        line(
          `Anmerkung ${number}: Zu § ${10 + (number % 15)} MLNG wird die Formulierung als unklar gerügt.`
        )
      );
    }
    if (page === 39) {
      blocks.push(line('Wir fordern insgesamt, den Entwurf in § 12 und § 14 zu überarbeiten.'));
    }
    pages.push(blocks);
  }
  return buildPdfBytes(pages);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = bytes => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A grey picture with darker stripes where the lines of a letter would be. */
function scannedPagePng(width = 120, height = 170) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8 bit, greyscale
  const rows = [];
  for (let y = 0; y < height; y++) {
    const pixels = Buffer.alloc(1 + width, 0xee);
    pixels[0] = 0;
    if (y % 10 > 6 && y > 20 && y < height - 20) pixels.fill(0x55, 13, width - 12);
    rows.push(pixels);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** A scan: one page that is a picture, without a text layer. */
async function scanPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const image = await doc.embedPng(scannedPagePng());
  page.drawImage(image, { x: 40, y: 40, width: 515, height: 762 });
  return doc.save();
}

const files = {
  '01-verband-der-musterkassen.pdf': await verbandPdf(),
  '02-musterkammer-nord.docx': await kammerDocx(),
  '03-scan-ohne-textebene.pdf': await scanPdf(),
  '04-arbeitsgemeinschaft-lang.pdf': await langPdf(),
  // Empty: a file that was sent before anything was written into it.
  '05-leer.txt': '\n',
  '06-buendnis-umlaute-tabelle.docx': await umlauteDocx()
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), bytes);
  console.log(`${name}: ${Buffer.byteLength(bytes)} bytes`);
}

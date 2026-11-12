#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Generates a realistic, deterministic document corpus for the load test:
 * about 40 Word, PowerPoint, Excel and PDF files of 50 KB – 10 MB with
 * headings, tables, embedded photos-like images, many pages/slides/rows and a
 * scanned PDF without a text layer. That is what makes ingestion and chat
 * uploads cost what customer files cost (unzip + XML, PDF parsing and table
 * detection, image skipping, pdfium rendering for scans).
 *
 * Uses the server's own dependencies (docx, pptxgenjs, xlsx, pdf-lib), so run
 * `npm run install:all` once. Output: tests/load/fixtures/corpus/ (git-ignored),
 * picked up automatically by run.mjs and setup.mjs.
 *
 *   node tests/load/tools/generate-corpus.mjs [--out <dir>] [--scale 0.5]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TOPICS, topicText } from '../lib/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const require = createRequire(path.join(ROOT, 'server/package.json'));
const docx = require('docx');
const PptxGenJS = require('pptxgenjs');
const XLSX = require('xlsx');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = path.resolve(opt('out', path.join(HERE, '..', 'fixtures', 'corpus')));
const SCALE = Number(opt('scale', 1));
const CHARS_PER_PAGE = 3000;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// --- images -------------------------------------------------------------------
/**
 * A photo-like PNG: gradient plus a little noise, sized like the JPEG photos in
 * real documents (~150–400 KB). `gray` gives a scanner-like greyscale page.
 */
function makePng(w, h, seed, noise = 8, gray = false) {
  const rand = rng(seed);
  const ch = gray ? 1 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  const [r0, g0, b0] = [rand() * 200, rand() * 200, rand() * 200];
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const n = () => (rand() - 0.5) * noise;
      if (gray) {
        // Paper with faint text-like bands.
        const band = y % 28 < 9 && x > w * 0.1 && x < w * 0.9 && rand() < 0.5 ? 110 : 0;
        raw[o++] = Math.max(0, Math.min(255, 238 - band + n()));
        continue;
      }
      raw[o++] = Math.max(0, Math.min(255, r0 + (x / w) * 55 + n()));
      raw[o++] = Math.max(0, Math.min(255, g0 + (y / h) * 55 + n()));
      raw[o++] = Math.max(0, Math.min(255, b0 + ((x + y) / (w + h)) * 55 + n()));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = gray ? 0 : 2; // greyscale | RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- content ------------------------------------------------------------------
function sections(topic, pages, seed) {
  const text = topicText(topic, Math.round(pages * CHARS_PER_PAGE * SCALE), seed);
  const out = [];
  let current = null;
  for (const block of text.split(/\n\n+/)) {
    const m = /^Section (\d+): (.*)$/.exec(block);
    if (m) {
      current = { heading: `${m[1]}. ${m[2][0].toUpperCase()}${m[2].slice(1)}`, paragraphs: [] };
      out.push(current);
    } else if (current) current.paragraphs.push(block.trim());
    else out.push({ heading: block.trim(), paragraphs: [] });
  }
  return out.filter(s => s.heading);
}

function tableRows(topic, rows, seed) {
  const rand = rng(seed);
  const header = ['ID', 'Area', 'Rule', 'Amount (EUR)', 'Owner', 'Valid from'];
  const body = Array.from({ length: rows }, (_, i) => {
    const kw = topic.keywords[Math.floor(rand() * topic.keywords.length)];
    const fact = topic.facts[Math.floor(rand() * topic.facts.length)];
    return [
      `${topic.id.slice(0, 3).toUpperCase()}-${1000 + i}`,
      kw,
      fact.length > 70 ? `${fact.slice(0, 67)}...` : fact,
      String(Math.floor(rand() * 50000) / 10),
      `Team ${1 + Math.floor(rand() * 12)}`,
      `2026-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-01`
    ];
  });
  return [header, ...body];
}

// --- DOCX ---------------------------------------------------------------------
async function makeDocx({ topic, pages, tables, images, seed, title }) {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    ImageRun,
    WidthType
  } = docx;
  const secs = sections(topic, pages, seed);
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  const every = Math.max(1, Math.floor(secs.length / Math.max(1, tables + images)));
  let t = 0;
  let im = 0;
  secs.forEach((s, i) => {
    children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1 }));
    for (const p of s.paragraphs) children.push(new Paragraph({ children: [new TextRun(p)] }));
    if (i % every === every - 1) {
      if (t < tables) {
        const rows = tableRows(topic, 12, seed + i);
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map(
              (r, ri) =>
                new TableRow({
                  children: r.map(
                    c =>
                      new TableCell({
                        children: [
                          new Paragraph({ children: [new TextRun({ text: c, bold: ri === 0 })] })
                        ]
                      })
                  )
                })
            )
          })
        );
        t += 1;
      } else if (im < images) {
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: 'png',
                data: makePng(560, 350, seed + i * 7),
                transformation: { width: 560, height: 350 }
              })
            ]
          })
        );
        im += 1;
      }
    }
  });
  const doc = new Document({
    creator: 'IntraFind load test',
    title,
    sections: [{ children }]
  });
  return Packer.toBuffer(doc);
}

// --- PPTX ---------------------------------------------------------------------
async function makePptx({ topic, slides, images, seed, title }) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = title;
  const rand = rng(seed);
  const secs = sections(topic, Math.ceil(slides / 2), seed);
  const pics = Array.from(
    { length: Math.min(images, 6) },
    (_, i) => `image/png;base64,${makePng(800, 450, seed + i * 13).toString('base64')}`
  );
  let picIndex = 0;
  const cover = pptx.addSlide();
  cover.addText(title, { x: 0.5, y: 2, w: 9, h: 1, fontSize: 36, bold: true });
  cover.addText('Internal · 2026', { x: 0.5, y: 3.1, w: 9, h: 0.5, fontSize: 16 });
  for (let i = 1; i < slides; i++) {
    const slide = pptx.addSlide();
    const sec = secs[i % secs.length];
    slide.addText(sec.heading, { x: 0.4, y: 0.25, w: 9.2, h: 0.7, fontSize: 24, bold: true });
    const kind = i % 4;
    if (kind === 2) {
      const rows = tableRows(topic, 7, seed + i).map(r => r.slice(0, 4));
      slide.addTable(rows, {
        x: 0.4,
        y: 1.1,
        w: 9.2,
        fontSize: 10,
        border: { type: 'solid', pt: 0.5, color: '999999' }
      });
    } else {
      const bullets = (sec.paragraphs[0] || topic.facts.join(' '))
        .split(/(?<=\.)\s+/)
        .slice(0, 5)
        .map(b => ({ text: b, options: { bullet: true } }));
      const withPic = picIndex < images && rand() < images / slides + 0.2;
      slide.addText(bullets, {
        x: 0.4,
        y: 1.1,
        w: withPic ? 5 : 9.2,
        h: 4,
        fontSize: 14,
        valign: 'top'
      });
      if (withPic) {
        slide.addImage({ data: pics[picIndex % pics.length], x: 5.6, y: 1.2, w: 4, h: 2.25 });
        picIndex += 1;
      }
    }
    slide.addNotes(`Speaker notes: ${topic.facts[i % topic.facts.length]}`);
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

// --- XLSX ---------------------------------------------------------------------
function makeXlsx({ topic, sheets, rows, seed }) {
  const wb = XLSX.utils.book_new();
  for (let s = 0; s < sheets; s++) {
    const data = tableRows(topic, Math.round(rows * SCALE), seed + s);
    data[0].push('Quantity', 'Unit price', 'Total', 'Status', 'Comment');
    const rand = rng(seed + s * 31);
    for (let r = 1; r < data.length; r++) {
      const q = 1 + Math.floor(rand() * 40);
      const p = Math.round(rand() * 50000) / 100;
      data[r][3] = Number(data[r][3]);
      data[r].push(
        q,
        p,
        { t: 'n', f: `H${r + 1}*I${r + 1}` },
        rand() < 0.8 ? 'approved' : 'open',
        topic.keywords[r % topic.keywords.length]
      );
    }
    data.push(['', '', 'Sum', { t: 'n', f: `SUM(D2:D${data.length})` }]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), `Sheet ${s + 1}`);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

// --- PDF ----------------------------------------------------------------------
async function makePdf({ topic, pages, tables, images, seed, title, scanned = false }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('IntraFind load test');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595;
  const H = 842;
  if (scanned) {
    // Image-only pages: no text layer, like a scanner's output.
    for (let i = 0; i < pages; i++) {
      const img = await pdf.embedPng(makePng(1000, 1414, seed + i, 10, true));
      pdf.addPage([W, H]).drawImage(img, { x: 0, y: 0, width: W, height: H });
    }
    return Buffer.from(await pdf.save());
  }
  const pngs = [];
  for (let i = 0; i < Math.min(images, 4); i++)
    pngs.push(await pdf.embedPng(makePng(640, 400, seed + i * 17)));
  const lines = [];
  for (const s of sections(topic, pages, seed)) {
    lines.push({ h: s.heading });
    for (const p of s.paragraphs) {
      let rest = p;
      while (rest.length) {
        let cut = rest.length > 95 ? rest.lastIndexOf(' ', 95) : rest.length;
        if (cut < 40) cut = Math.min(95, rest.length);
        lines.push({ t: rest.slice(0, cut) });
        rest = rest.slice(cut).trimStart();
      }
      lines.push({ t: '' });
    }
  }
  const tableEvery = tables ? Math.max(1, Math.floor(pages / tables)) : Infinity;
  const imageEvery = images ? Math.max(1, Math.floor(pages / images)) : Infinity;
  let li = 0;
  let pageNo = 0;
  let tablesDone = 0;
  let imagesDone = 0;
  while (li < lines.length) {
    const page = pdf.addPage([W, H]);
    pageNo += 1;
    let y = H - 60;
    page.drawText(title, { x: 50, y: H - 35, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(`Page ${pageNo}`, { x: W - 90, y: 25, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
    if (pageNo % tableEvery === 0 && tablesDone < tables) {
      const rows = tableRows(topic, 10, seed + pageNo);
      const colW = [55, 85, 210, 60, 45, 55];
      for (const [ri, row] of rows.entries()) {
        let x = 45;
        row.forEach((cell, ci) => {
          page.drawRectangle({
            x,
            y: y - 4,
            width: colW[ci],
            height: 14,
            borderColor: rgb(0.6, 0.6, 0.6),
            borderWidth: 0.5
          });
          const txt =
            cell.length > colW[ci] / 4.4
              ? `${cell.slice(0, Math.floor(colW[ci] / 4.4) - 2)}..`
              : cell;
          page.drawText(txt, { x: x + 2, y, size: 7, font: ri === 0 ? bold : font });
          x += colW[ci];
        });
        y -= 14;
      }
      y -= 16;
      tablesDone += 1;
    }
    if (pageNo % imageEvery === 0 && imagesDone < images && pngs.length) {
      page.drawImage(pngs[imagesDone % pngs.length], {
        x: 70,
        y: y - 280,
        width: 450,
        height: 280
      });
      y -= 300;
      imagesDone += 1;
    }
    while (li < lines.length && y > 60) {
      const l = lines[li++];
      if (l.h) {
        y -= 6;
        page.drawText(l.h, { x: 50, y, size: 13, font: bold });
        y -= 20;
      } else {
        page.drawText(l.t, { x: 50, y, size: 10, font });
        y -= 13;
      }
    }
  }
  return Buffer.from(await pdf.save());
}

// --- corpus plan --------------------------------------------------------------
const plan = [];
TOPICS.forEach((topic, i) => {
  const s = 5000 + i * 100;
  plan.push({
    name: `${topic.id}-policy.docx`,
    kind: 'docx',
    topic,
    pages: 8,
    tables: 2,
    images: 1,
    seed: s + 1,
    title: `${topic.title} — Policy`
  });
  plan.push({
    name: `${topic.id}-handbook.docx`,
    kind: 'docx',
    topic,
    pages: 40,
    tables: 6,
    images: 5,
    seed: s + 2,
    title: `${topic.title} — Handbook`
  });
  plan.push({
    name: `${topic.id}-overview.pptx`,
    kind: 'pptx',
    topic,
    slides: 16,
    images: 4,
    seed: s + 3,
    title: `${topic.title} — Overview`
  });
  plan.push({
    name: `${topic.id}-register.xlsx`,
    kind: 'xlsx',
    topic,
    sheets: 2,
    rows: 2000,
    seed: s + 4
  });
  plan.push({
    name: `${topic.id}-guideline.pdf`,
    kind: 'pdf',
    topic,
    pages: 12,
    tables: 3,
    images: 1,
    seed: s + 5,
    title: `${topic.title} — Guideline`
  });
  plan.push({
    name: `${topic.id}-report.pdf`,
    kind: 'pdf',
    topic,
    pages: 40,
    tables: 8,
    images: 6,
    seed: s + 6,
    title: `${topic.title} — Annual Report`
  });
});
const [travel, security, onboarding, product, procurement] = TOPICS;
plan.push(
  {
    name: 'procurement-framework-contract.docx',
    kind: 'docx',
    topic: procurement,
    pages: 25,
    tables: 4,
    images: 0,
    seed: 7001,
    title: 'Framework Contract'
  },
  {
    name: 'onboarding-meeting-minutes.docx',
    kind: 'docx',
    topic: onboarding,
    pages: 3,
    tables: 1,
    images: 0,
    seed: 7002,
    title: 'Meeting Minutes'
  },
  {
    name: 'product-roadmap.pptx',
    kind: 'pptx',
    topic: product,
    slides: 40,
    images: 12,
    seed: 7003,
    title: 'Product Roadmap 2027'
  },
  {
    name: 'product-sales-kickoff.pptx',
    kind: 'pptx',
    topic: product,
    slides: 30,
    images: 14,
    seed: 7004,
    title: 'Sales Kickoff'
  },
  {
    name: 'security-awareness-training.pptx',
    kind: 'pptx',
    topic: security,
    slides: 25,
    images: 6,
    seed: 7005,
    title: 'Security Awareness Training'
  },
  {
    name: 'procurement-budget-2027.xlsx',
    kind: 'xlsx',
    topic: procurement,
    sheets: 4,
    rows: 500,
    seed: 7006
  },
  {
    name: 'procurement-inventory-large.xlsx',
    kind: 'xlsx',
    topic: procurement,
    sheets: 1,
    rows: 30000,
    seed: 7007
  },
  {
    name: 'travel-kpi-dashboard.xlsx',
    kind: 'xlsx',
    topic: travel,
    sheets: 3,
    rows: 120,
    seed: 7008
  },
  {
    name: 'product-technical-manual.pdf',
    kind: 'pdf',
    topic: product,
    pages: 250,
    tables: 30,
    images: 10,
    seed: 7009,
    title: 'Technical Manual'
  },
  {
    name: 'procurement-invoice-batch.pdf',
    kind: 'pdf',
    topic: procurement,
    pages: 30,
    tables: 30,
    images: 0,
    seed: 7010,
    title: 'Invoice Batch'
  },
  {
    name: 'security-audit-report.pdf',
    kind: 'pdf',
    topic: security,
    pages: 120,
    tables: 15,
    images: 24,
    seed: 7011,
    title: 'Security Audit Report'
  },
  {
    name: 'scanned-letter.pdf',
    kind: 'pdf',
    topic: null,
    pages: 3,
    scanned: true,
    seed: 7012,
    title: 'Scanned letter'
  }
);

fs.mkdirSync(OUT, { recursive: true });
const manifest = [];
const t0 = Date.now();
for (const spec of plan) {
  let buf;
  if (spec.kind === 'docx') buf = await makeDocx(spec);
  else if (spec.kind === 'pptx') buf = await makePptx(spec);
  else if (spec.kind === 'xlsx') buf = makeXlsx(spec);
  else buf = await makePdf({ ...spec, topic: spec.topic || TOPICS[0] });
  fs.writeFileSync(path.join(OUT, spec.name), buf);
  manifest.push({
    name: spec.name,
    topic: spec.topic?.id ?? null,
    bytes: buf.length,
    pages: spec.pages ?? null,
    slides: spec.slides ?? null,
    rows: spec.rows ? spec.rows * (spec.sheets || 1) : null,
    noText: Boolean(spec.scanned)
  });
  console.log(`${spec.name.padEnd(40)} ${(buf.length / 1048576).toFixed(2).padStart(6)} MB`);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
const total = manifest.reduce((a, m) => a + m.bytes, 0);
console.log(
  `\n${manifest.length} files, ${(total / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${OUT}`
);

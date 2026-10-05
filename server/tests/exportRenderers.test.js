/**
 * Specs for the server-side export renderers (EU AI Act Art. 50, concept
 * "EU AI Act Content Marking" §5.3 / §8.3). Every format must produce a
 * valid file that shows the visible AI label, survive characters the PDF
 * font lacks, keep spreadsheet formula injection out, and escape raw HTML.
 *
 * Signing and provenance metadata are ExportSigner's job and not tested here.
 *
 * Run: node --test server/tests/exportRenderers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  EXPORT_FORMATS,
  FORMAT_INFO,
  renderExport
} from '../services/provenance/export/renderers/index.js';
import { toFontSafeText } from '../services/provenance/export/renderers/fontMetrics.js';
import {
  isSafeLinkTarget,
  normalizeDoc,
  sanitizeForSpreadsheet,
  stripXmlInvalidChars
} from '../services/provenance/export/renderers/common.js';
import { MAX_CELL_CHARS, splitForCells } from '../services/provenance/export/renderers/xlsx.js';
import { csvField } from '../services/provenance/export/renderers/csv.js';
import { createTranslator } from '../services/provenance/export/renderers/strings.js';

const LABEL = 'AI-generated content — created with iHub Apps';
const CONTACT = 'editor@example.com';
const INJECTION = '=HYPERLINK("http://evil.example","click")';

/** Long enough to push the PDF onto a second page. */
const LONG_PARAGRAPH = Array.from(
  { length: 90 },
  (_, i) =>
    `Sentence ${i} of a long answer about Grüße, the € sign and naïve cafés that wraps across many lines.`
).join(' ');

const ASSISTANT_MARKDOWN = [
  '# Plan comparison',
  '',
  'A *short* summary with `inline code`, a [safe link](https://example.com), a [bad link](javascript:alert(1)) and <script>alert(1)</script>.',
  '',
  '| Plan | Price | Notes |',
  '|:-----|------:|:-----:|',
  '| Basic | 10 € | good for **small** teams |',
  '| Pro | 25 € | 👨‍👩‍👧 family<br>second line |',
  '',
  '- first',
  '- second',
  '  - nested',
  '',
  '3. three',
  '4. four',
  '',
  '> quoted',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  LONG_PARAGRAPH
].join('\n');

/**
 * A chat export like ExportService prepares it.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function makeDoc(overrides = {}) {
  return {
    title: 'Pricing discussion — Q3 😀',
    appName: 'Sales Assistant',
    exportedAt: '2026-09-29T12:34:56.000Z',
    language: 'en',
    settings: { model: 'gpt-4o', temperature: 0.7, variables: { region: 'EMEA' } },
    messages: [
      {
        index: 0,
        role: 'user',
        content: 'Compare the plans, please 👍🏽 — Straße, 東京',
        timestamp: '2026-09-29T12:00:00Z',
        verification: 'human'
      },
      {
        index: 1,
        role: 'assistant',
        content: ASSISTANT_MARKDOWN,
        timestamp: '2026-09-29T12:00:05Z',
        model: 'gpt-4o',
        verification: 'verified',
        contentId: 'c-1'
      },
      {
        index: 2,
        role: 'assistant',
        content: '-1 is the corrected answer',
        model: 'gpt-4o',
        verification: 'edited'
      },
      { index: 3, role: 'user', content: INJECTION, verification: 'human' }
    ],
    source: 'chat',
    label: {
      show: true,
      text: LABEL,
      euIcon: true,
      humanReviewed: true,
      editorialContact: CONTACT,
      provider: 'Example GmbH'
    },
    template: 'default',
    single: false,
    ...overrides
  };
}

/** Text of a PDF (all pages), whitespace collapsed, plus page count and info. */
async function readPdf(buffer) {
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' '));
    }
    const { info } = await pdf.getMetadata();
    return { text: pages.join('\n').replace(/\s+/g, ' '), numPages: pdf.numPages, info };
  } finally {
    await task.destroy();
  }
}

/** Concatenated XML of the zip parts whose names match. */
async function zipParts(buffer, pattern) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter(name => pattern.test(name));
  assert.ok(names.length > 0, `no zip part matches ${pattern}`);
  const parts = await Promise.all(names.map(name => zip.file(name).async('string')));
  return parts.join('\n');
}

const utf8 = buffer => buffer.toString('utf8');

describe('export renderers: API', () => {
  it('lists every format with a mime type and extension', () => {
    assert.deepEqual(
      [...EXPORT_FORMATS],
      ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'markdown', 'html', 'json', 'jsonl']
    );
    for (const format of EXPORT_FORMATS) {
      assert.ok(FORMAT_INFO[format].mimeType, `${format} mime type`);
      assert.ok(FORMAT_INFO[format].extension, `${format} extension`);
    }
    assert.equal(FORMAT_INFO.markdown.extension, 'md');
    assert.equal(FORMAT_INFO.pdf.mimeType, 'application/pdf');
  });

  it('rejects an unknown format with status 400', async () => {
    for (const format of ['exe', 'constructor', '__proto__', '', undefined]) {
      await assert.rejects(renderExport(format, makeDoc()), error => error.status === 400);
    }
  });

  it('rejects a missing document with status 400', async () => {
    await assert.rejects(renderExport('pdf', null), error => error.status === 400);
  });

  for (const format of EXPORT_FORMATS) {
    it(`renders ${format} with its mime type and extension`, async () => {
      const result = await renderExport(format, makeDoc());
      assert.ok(Buffer.isBuffer(result.buffer));
      assert.ok(result.buffer.length > 100, 'non-trivial output');
      assert.equal(result.mimeType, FORMAT_INFO[format].mimeType);
      assert.equal(result.extension, FORMAT_INFO[format].extension);
    });
  }
});

describe('export renderers: PDF', () => {
  it('writes a multi-page PDF with header, label, badge, markers and footer', async () => {
    const { buffer } = await renderExport('pdf', makeDoc());
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(!buffer.includes('/ObjStm'), 'saved without object streams');
    const { text, numPages, info } = await readPdf(buffer);
    assert.ok(numPages >= 2, `long paragraph breaks the page (got ${numPages})`);
    assert.ok(text.includes(LABEL), 'label text');
    assert.ok(text.includes('AI GENERATED'), 'badge caption');
    assert.ok(text.includes(`Reviewed by a human; editorial responsibility: ${CONTACT}`));
    assert.ok(text.includes('Exported on'), 'export date');
    assert.ok(text.includes('User') && text.includes('Assistant'), 'role framing');
    assert.ok(text.includes('edited after generation / not verified'), 'edited marker');
    assert.ok(text.includes('Chat Settings') && text.includes('Temperature: 0.7'));
    assert.ok(text.includes('Plan comparison') && text.includes('Basic'), 'markdown body');
    assert.ok(text.includes('Straße'), 'Latin-1 text survives');
    assert.ok(text.includes(`1 / ${numPages}`), 'page number footer');
    assert.equal(info.Title, 'Pricing discussion — Q3 😀');
    assert.equal(info.Creator, 'iHub Apps');
    assert.equal(info.Producer, 'iHub Apps');
    assert.equal(info.Author, 'Sales Assistant');
  });

  it('renders every template', async () => {
    for (const template of ['default', 'professional', 'minimal', 'unknown']) {
      const { buffer } = await renderExport('pdf', makeDoc({ template }));
      const { text } = await readPdf(buffer);
      assert.ok(text.includes(LABEL), `${template} shows the label`);
    }
  });

  it('replaces characters the font lacks instead of crashing', async () => {
    assert.equal(toFontSafeText('a😀b'), 'a?b');
    assert.equal(toFontSafeText('👨‍👩‍👧'), '?', 'one ? per emoji sequence');
    assert.equal(toFontSafeText('ok️​'), 'ok', 'invisible characters dropped');
    assert.equal(toFontSafeText('a b'), 'a b', 'unsupported space becomes a space');
    assert.equal(toFontSafeText('Grüße €'), 'Grüße €');
    const doc = makeDoc({
      messages: [{ role: 'assistant', content: '😀🎉 東京 \u0007 𝔘𝔫𝔦', verification: 'verified' }]
    });
    const { text } = await readPdf((await renderExport('pdf', doc)).buffer);
    assert.ok(text.includes('?'), 'glyph-less characters shown as ?');
  });

  it('shows no label when the label is off', async () => {
    const doc = makeDoc({ label: { show: false, text: LABEL, euIcon: true } });
    const { text } = await readPdf((await renderExport('pdf', doc)).buffer);
    assert.ok(!text.includes(LABEL));
    assert.ok(!text.includes('AI GENERATED'));
  });

  it('prints German fixed labels', async () => {
    const doc = makeDoc({ language: 'de' });
    const { text } = await readPdf((await renderExport('pdf', doc)).buffer);
    assert.ok(text.includes('Exportiert am'));
    assert.ok(text.includes('KI-GENERIERT'));
    assert.ok(text.includes('Benutzer') && text.includes('Assistent'));
    assert.ok(text.includes('nach der Erzeugung bearbeitet / nicht verifiziert'));
  });
});

describe('export renderers: Office formats', () => {
  it('docx carries the label in body and page header and sets core properties', async () => {
    const { buffer } = await renderExport('docx', makeDoc());
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK');
    const body = await zipParts(buffer, /^word\/document\.xml$/);
    assert.ok(body.includes(LABEL));
    assert.ok(body.includes('AI GENERATED'));
    assert.ok(body.includes('prst="roundRect"'), 'drawn rounded AI badge');
    assert.ok(body.includes('edited after generation / not verified'));
    assert.ok(body.includes('Plan comparison'));
    assert.ok(!body.includes('javascript:'), 'unsafe link not emitted');
    const header = await zipParts(buffer, /^word\/header\d+\.xml$/);
    assert.ok(header.includes(LABEL), 'label on every page');
    const core = await zipParts(buffer, /^docProps\/core\.xml$/);
    assert.ok(core.includes('<dc:title>Pricing discussion — Q3 😀</dc:title>'));
    assert.ok(core.includes('<dc:creator>Sales Assistant</dc:creator>'));
    assert.ok(core.includes(`<dc:description>${LABEL}</dc:description>`));
  });

  it('pptx shows the label on the title slide and every slide footer', async () => {
    const { buffer } = await renderExport('pptx', makeDoc());
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK');
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files).filter(name =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    );
    assert.ok(slideNames.length >= 4, 'title, messages (continued) and settings slides');
    for (const name of slideNames) {
      const xml = await zip.file(name).async('string');
      assert.ok(xml.includes(LABEL), `${name} shows the label`);
      for (const paragraph of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []) {
        const count = (paragraph.match(/<a:pPr\b/g) || []).length;
        assert.ok(count <= 1, `${name}: at most one pPr per paragraph`);
        if (count === 1) assert.ok(paragraph.startsWith('<a:p><a:pPr'), `${name}: pPr leads`);
      }
    }
    const slides = await zipParts(buffer, /^ppt\/slides\/slide\d+\.xml$/);
    assert.ok(slides.includes('AI GENERATED'));
    assert.ok(slides.includes('prst="roundRect"'), 'drawn rounded AI badge');
    assert.ok(slides.includes('Assistant (continued)'), 'long message continues');
    assert.ok(slides.includes('edited after generation / not verified'));
  });

  it('xlsx has a label row and writes formula-like text as plain strings', async () => {
    const { buffer } = await renderExport('xlsx', makeDoc());
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK');
    const strings = await zipParts(buffer, /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/);
    assert.ok(strings.includes(LABEL));
    assert.ok(strings.includes('Verification'));
    assert.ok(strings.includes('edited after generation'), 'verification column');
    assert.ok(strings.includes('>-1 is the corrected answer'), 'text kept as written');
    assert.ok(!strings.includes("'-1 is the corrected answer"), 'no guard apostrophe');
    assert.ok(/<t[^>]*>=HYPERLINK\(/.test(strings), 'formula-like text stays a string');
    assert.ok(!strings.includes('<f>'), 'no formula cells');
  });

  it('splits content longer than an Excel cell', () => {
    const text = 'x'.repeat(MAX_CELL_CHARS * 2 + 10);
    const chunks = splitForCells(text);
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every(chunk => chunk.length <= MAX_CELL_CHARS));
    assert.deepEqual(splitForCells('short'), ['short']);
  });
});

describe('export renderers: text formats', () => {
  it('csv: BOM, label, machine columns, quoting and injection guard', async () => {
    const { buffer } = await renderExport('csv', makeDoc());
    const csv = utf8(buffer);
    assert.ok(csv.startsWith('﻿'), 'UTF-8 BOM');
    assert.ok(csv.slice(1).startsWith(`"${LABEL}"`), 'label first');
    assert.ok(csv.includes('"role","content","timestamp","model","ai_generated","verification"'));
    assert.ok(csv.includes('"assistant",'), 'assistant rows');
    assert.ok(csv.includes(',"true","verified"'), 'ai_generated + verification');
    assert.ok(csv.includes(',"false","human"'));
    assert.ok(
      csv.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`),
      'guarded + escaped'
    );
    assert.ok(!/(^|,)"[=+\-@]/m.test(csv), 'no field starts with a formula character');
    assert.ok(csv.endsWith('"'), 'last field quoted (signpost goes inside it)');
    assert.equal(csvField('+1'), `"'+1"`);
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
  });

  it('txt: label at the top, content verbatim, markers', async () => {
    const txt = utf8((await renderExport('txt', makeDoc())).buffer);
    assert.ok(txt.startsWith(`${LABEL}\n`));
    assert.ok(txt.includes(`Reviewed by a human; editorial responsibility: ${CONTACT}`));
    assert.ok(txt.includes(ASSISTANT_MARKDOWN), 'content is not rewritten');
    assert.ok(txt.includes('[Assistant] - gpt-4o (edited after generation / not verified)'));
    assert.ok(txt.includes('Temperature: 0.7'));
  });

  it('markdown: label blockquote first, transcript headings', async () => {
    const md = utf8((await renderExport('markdown', makeDoc())).buffer);
    assert.ok(md.startsWith(`> **${LABEL}**`));
    assert.ok(md.includes('## User'));
    assert.ok(md.includes('*edited after generation / not verified*'));
    assert.ok(md.includes(ASSISTANT_MARKDOWN), 'content is not rewritten');
    assert.ok(!md.startsWith('---'), 'no front matter (ExportSigner adds it)');
  });

  it('html: banner with badge, escaped raw HTML, no unsafe links', async () => {
    const html = utf8((await renderExport('html', makeDoc())).buffer);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('</head>'), 'ExportSigner inserts before </head>');
    assert.ok(html.includes('class="ai-label"'));
    assert.ok(html.includes(LABEL));
    assert.ok(html.includes('class="ai-badge-mark"') && html.includes('AI GENERATED'));
    assert.ok(!/<script/i.test(html), 'no script element');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'raw HTML shown as text');
    assert.ok(!html.includes('javascript:'), 'unsafe link dropped');
    assert.ok(html.includes('href="https://example.com"'), 'safe link kept');
    assert.ok(html.includes('<table>'), 'markdown table rendered');
    assert.ok(html.includes('verification-warning'));
  });

  it('json: aiLabel, messages with aiGenerated and verification', async () => {
    const json = JSON.parse(utf8((await renderExport('json', makeDoc())).buffer));
    assert.equal(json.aiLabel, LABEL);
    assert.equal(json.title, 'Pricing discussion — Q3 😀');
    assert.equal(json.appName, 'Sales Assistant');
    assert.equal(json.exportedAt, '2026-09-29T12:34:56.000Z');
    assert.equal(json.settings.model, 'gpt-4o');
    assert.equal(json.messages.length, 4);
    assert.deepEqual(
      json.messages.map(m => [m.role, m.aiGenerated, m.verification]),
      [
        ['user', false, 'human'],
        ['assistant', true, 'verified'],
        ['assistant', true, 'edited'],
        ['user', false, 'human']
      ]
    );
    assert.equal(json.messages[1].content, ASSISTANT_MARKDOWN);
    assert.equal(json.provenance, undefined, 'provenance is added by ExportSigner');
  });

  it('jsonl: meta line with aiLabel, then one message per line', async () => {
    const lines = utf8((await renderExport('jsonl', makeDoc())).buffer)
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.equal(lines.length, 5);
    assert.equal(lines[0].aiLabel, LABEL);
    assert.equal(lines[0].meta.title, 'Pricing discussion — Q3 😀');
    assert.equal(lines[2].role, 'assistant');
    assert.equal(lines[2].aiGenerated, true);
    assert.equal(lines[3].verification, 'edited');
  });

  it('omits the label everywhere when label.show is false', async () => {
    const doc = makeDoc({ label: { show: false, text: LABEL, euIcon: true } });
    for (const format of ['txt', 'markdown', 'html', 'csv']) {
      const text = utf8((await renderExport(format, doc)).buffer);
      assert.ok(!text.includes(LABEL), `${format} has no label`);
    }
    const json = JSON.parse(utf8((await renderExport('json', doc)).buffer));
    assert.equal(json.aiLabel, undefined);
  });
});

describe('export renderers: sources and label variants', () => {
  it('canvas: one document body with the "edited by user" note and no role framing', async () => {
    const doc = makeDoc({
      source: 'canvas',
      appName: 'Canvas Writer',
      settings: null,
      messages: [
        {
          index: 0,
          role: 'assistant',
          content: '# Draft\n\nCanvas body text.',
          verification: 'edited'
        }
      ],
      label: { show: true, text: LABEL, euIcon: false, humanReviewed: false }
    });
    const txt = utf8((await renderExport('txt', doc)).buffer);
    assert.ok(txt.includes('AI-assisted, edited by user'));
    assert.ok(!txt.includes('[Assistant]'), 'no transcript framing');
    assert.ok(txt.includes('Canvas body text.'));
    const { text } = await readPdf((await renderExport('pdf', doc)).buffer);
    assert.ok(text.includes('AI-assisted, edited by user'));
    assert.ok(!text.includes('Assistant'), 'no role band');
    assert.ok(!text.includes('AI GENERATED'), 'no EU icon when off');
    const html = utf8((await renderExport('html', doc)).buffer);
    assert.ok(html.includes('AI-assisted, edited by user'));
    assert.ok(!html.includes('class="message assistant-message"'), 'no message card');
    assert.ok(html.includes('class="document"'));
  });

  it('single message: body without "User / Assistant" framing', async () => {
    const doc = makeDoc({
      single: true,
      messages: [{ role: 'assistant', content: 'Only answer', verification: 'asserted' }]
    });
    const md = utf8((await renderExport('markdown', doc)).buffer);
    assert.ok(!md.includes('## Assistant'));
    assert.ok(md.includes('*edited after generation / not verified*'));
    assert.ok(md.includes('Only answer'));
  });

  it('human review falls back to the provider, or stands alone', () => {
    const t = createTranslator('en');
    const withProvider = normalizeDoc(
      makeDoc({ label: { show: true, text: LABEL, humanReviewed: true, provider: 'Example GmbH' } })
    );
    assert.equal(withProvider.label.editorialContact, null);
    assert.equal(
      t('export.label.humanReviewed', { contact: withProvider.label.provider }),
      'Reviewed by a human; editorial responsibility: Example GmbH'
    );
  });

  it('normalises unknown values to safe defaults', () => {
    const doc = normalizeDoc({
      messages: [{ role: 'robot', content: 42, verification: 'trusted' }],
      template: 'fancy',
      language: 'fr'
    });
    assert.equal(doc.language, 'en');
    assert.equal(doc.template, 'default');
    assert.equal(doc.source, 'chat');
    assert.equal(doc.messages[0].role, 'assistant');
    assert.equal(doc.messages[0].content, '42');
    assert.equal(doc.messages[0].verification, 'asserted', 'never claims more than proven');
    assert.equal(doc.label.show, false);
  });
});

describe('export renderers: guards', () => {
  it('sanitizeForSpreadsheet prefixes formula characters', () => {
    for (const value of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      assert.equal(sanitizeForSpreadsheet(value), `'${value}`);
    }
    assert.equal(sanitizeForSpreadsheet('plain'), 'plain');
    assert.equal(sanitizeForSpreadsheet(null), '');
  });

  it('stripXmlInvalidChars removes characters XML cannot carry', () => {
    assert.equal(stripXmlInvalidChars('a\u0000b\u0007c\td\ne'), 'abc\td\ne');
    assert.equal(stripXmlInvalidChars('x\uD800y'), 'xy', 'lone surrogate');
    assert.equal(stripXmlInvalidChars('😀'), '😀', 'surrogate pairs kept');
  });

  it('isSafeLinkTarget accepts web links only', () => {
    assert.ok(isSafeLinkTarget('https://example.com'));
    assert.ok(isSafeLinkTarget('mailto:a@example.com'));
    assert.ok(!isSafeLinkTarget('javascript:alert(1)'));
    assert.ok(!isSafeLinkTarget('java\tscript:alert(1)'));
    assert.ok(!isSafeLinkTarget('data:text/html,x'));
    assert.ok(!isSafeLinkTarget('/relative'));
    assert.ok(isSafeLinkTarget('/relative', { allowRelative: true }));
    assert.ok(!isSafeLinkTarget('//evil.example', { allowRelative: true }));
  });

  it('control characters in content do not break the Office formats', async () => {
    const doc = makeDoc({
      messages: [
        { role: 'assistant', content: 'bell\u0007 null\u0000 end', verification: 'verified' }
      ]
    });
    for (const format of ['docx', 'pptx', 'xlsx']) {
      const xml = await zipParts(
        (await renderExport(format, doc)).buffer,
        /(document|slide\d+|sharedStrings)\.xml$/
      );
      assert.ok(!/[\u0000\u0007]/.test(xml), `${format} XML has no control characters`);
      assert.ok(xml.includes('bell'), `${format} keeps the text`);
    }
  });
});

/**
 * The server-side PDF engine behind the `pdf` system skill and PDF exports
 * (services/documents/pdf): Markdown conversion, the layout-block sanitiser
 * that keeps model-authored layouts from reaching files or URLs, glyph
 * handling, rendering in the worker, and page previews.
 *
 * Run: node --test server/tests/pdf-engine.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';

import { markdownToContent } from '../services/documents/pdf/markdownToPdfmake.js';
import { sanitizeBlocks } from '../services/documents/pdf/sanitizeBlocks.js';
import { printableRuns } from '../services/documents/pdf/glyphs.js';
import { isColor, resolveTheme } from '../services/documents/pdf/themes.js';
import { CREATE_PDF_TOOL } from '../services/documents/pdf/pdfToolDefinitions.js';
import { renderPdfSpec } from '../services/documents/pdf/renderPdf.js';
import {
  createPdf,
  PdfGenerationError,
  renderPagePreview
} from '../services/documents/pdf/PdfService.js';
import { specFromToolArgs } from '../services/documents/pdf/pdfTools.js';
import {
  checkImageDataUri,
  imagePixelSize,
  sanitizeSvg,
  svgImageCallback
} from '../services/documents/pdf/validators.js';

// A 2×1 red PNG.
const PNG_2X1 = (() => {
  const png = new PNG({ width: 2, height: 1 });
  png.data = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255]);
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
})();

function ctx(extra = {}) {
  return {
    theme: resolveTheme('default'),
    contentWidth: 495,
    contentHeight: 718,
    warnings: [],
    nodeCount: 0,
    imageBytes: 0,
    ...extra
  };
}

/** Every string anywhere in a content tree, for "does X appear" checks. */
function collectText(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach(n => collectText(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach(v => collectText(v, out));
  return out;
}

function pdfText(buffer) {
  return buffer.toString('latin1');
}

describe('markdown conversion', () => {
  it('maps headings, lists, tables, code and breaks to pdfmake nodes', () => {
    const content = markdownToContent(
      '# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n\n```\n\tindented\n```\n\n\\pagebreak\n\nEnd',
      ctx()
    );
    const heading = content.find(n => n.headlineLevel === 1);
    assert.ok(heading, 'a level-1 heading');
    const paragraph = content.find(n => Array.isArray(n.text));
    assert.ok(paragraph.text.some(run => run.bold && run.text === 'bold'));
    assert.ok(paragraph.text.some(run => run.italics && run.text === 'italic'));
    assert.ok(content.some(n => Array.isArray(n.ul) && n.ul.length === 2));
    const table = content.find(n => n.table?.headerRows === 1);
    assert.equal(table.table.body[1][1].alignment, 'right');
    const code = content.find(n => n.layout === 'ihubCode');
    assert.equal(code.table.body[0][0].text, '    indented', 'tabs become spaces');
    assert.ok(content.some(n => n.pageBreak === 'after'));
  });

  it('supports <sub>/<sup> and task lists', () => {
    const content = markdownToContent(
      'H<sub>2</sub>O and m<sup>2</sup>\n\n- [x] done\n- [ ] open',
      ctx()
    );
    const runs = content[0].text;
    assert.ok(runs.some(r => r.sub && r.text === '2'));
    assert.ok(runs.some(r => r.sup && r.text === '2'));
    const items = content[1].ul;
    assert.ok(collectText(items).includes('☑ '));
    assert.ok(collectText(items).includes('☐ '));
    assert.ok(items.every(item => item.listType === 'none'));
  });

  it('keeps only http(s) and mailto links', () => {
    const content = markdownToContent(
      '[ok](https://example.com) [bad](javascript:alert(1))',
      ctx()
    );
    const links = content[0].text.filter(r => r.link);
    assert.deepEqual(
      links.map(l => l.link),
      ['https://example.com']
    );
  });

  it('renders images only from PNG/JPEG data URIs, at their natural size', () => {
    const c = ctx();
    const content = markdownToContent(
      `![logo](${PNG_2X1})\n\n![remote](https://example.com/x.png)\n\n![local](/etc/passwd)`,
      c
    );
    // A captioned image: the picture, then its alt text as the caption.
    const [image, caption] = content[0].stack;
    assert.equal(image.image.startsWith('data:image/png;base64,'), true);
    assert.equal(image.width, 1.5, '2 px at 96 dpi');
    assert.equal(caption.text, 'logo');
    assert.ok(collectText(content).includes('[remote]'));
    assert.ok(collectText(content).includes('[local]'));
    assert.ok(c.warnings.some(w => w.includes('only data:image/png')));
  });
});

describe('layout block sanitiser', () => {
  it('drops images that are paths or URLs', () => {
    const c = ctx();
    const content = sanitizeBlocks(
      [{ image: '/etc/passwd' }, { image: 'https://example.com/a.png' }, { image: PNG_2X1 }],
      c
    );
    assert.equal(content.length, 1);
    assert.ok(content[0].image.startsWith('data:image/png'));
  });

  it('rejects a data URI whose bytes are not the declared image type', () => {
    const fake = `data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}`;
    assert.equal(checkImageDataUri(fake).ok, false);
    assert.deepEqual(imagePixelSize(PNG_2X1), { width: 2, height: 1 });
  });

  it('strips scripts, foreign objects and external images from SVG', () => {
    const svg = sanitizeSvg(
      '<svg><script>alert(1)</script><foreignObject><p>x</p></foreignObject>' +
        '<image href="/etc/hosts" width="1" height="1"/>' +
        '<image xlink:href="https://example.com/x.png"/>' +
        `<image href="${PNG_2X1}"/>` +
        '<use href="https://example.com/sprite.svg#a"/><use href="#local"/></svg>'
    );
    assert.doesNotMatch(svg, /script|foreignObject|\/etc\/hosts|example\.com/);
    assert.match(svg, /data:image\/png/);
    assert.match(svg, /href="#local"/);
    // The renderer's second layer: whatever still reaches svg-to-pdfkit.
    assert.notEqual(svgImageCallback('/etc/hosts'), '/etc/hosts');
    assert.match(svgImageCallback('/etc/hosts'), /^data:image\/png/);
  });

  it('checks every link attribute of an SVG element, not only the first', () => {
    const svg = sanitizeSvg(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xl="http://www.w3.org/1999/xlink">' +
        `<image id="pair" href="${PNG_2X1}" xlink:href="/etc/passwd"/>` +
        `<image id="prefixed" href="${PNG_2X1}" xl:href="file:///etc/passwd"/>` +
        '<use id="u" href="#local" xlink:href="https://example.com/s.svg#a"/>' +
        '<a href="https://example.com/ok" xlink:href="javascript:alert(1)"><text>x</text></a>' +
        '<linearGradient id="g" xlink:href="https://example.com/g.svg#h"/>' +
        '<linearGradient id="g2" xlink:href="#g"/></svg>'
    );
    assert.doesNotMatch(svg, /id="pair"|id="prefixed"|id="u"|etc\/passwd|javascript|g\.svg/);
    assert.match(svg, /href="https:\/\/example.com\/ok"/);
    assert.match(svg, /<linearGradient id="g"\/>/);
    assert.match(svg, /xlink:href="#g"/);
  });

  it('parses SVG as XML and refuses markup that is not a well-formed <svg>', () => {
    assert.equal(sanitizeSvg('<svg><script>alert(1)</script\t\n bar></svg>'), null);
    assert.equal(sanitizeSvg('<html><svg/></html>'), null);
    assert.equal(sanitizeSvg('not markup'), null);
    const svg = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><!-- note --><rect onclick="x" onload="y" width="1"/>' +
        '<a href="javascript:alert(1)"><text>bad</text></a><a href="https://example.com"><text>ok</text></a>' +
        '<style>@import url(https://example.com/x.css); .a{fill:red}</style></svg>'
    );
    assert.doesNotMatch(svg, /onclick|onload|javascript|note|@import/);
    assert.match(svg, /href="https:\/\/example.com"/);
    assert.match(svg, /\.a\{fill:red\}/);
    const c = ctx();
    assert.deepEqual(sanitizeBlocks([{ svg: '<svg><g></svg>' }], c), []);
    assert.ok(c.warnings.some(w => w.includes('not well-formed')));
  });

  it('strips nested tags from raw HTML until none are left', () => {
    const content = markdownToContent('<div><scr<b>ipt>alert(1)</scr</b>ipt></div>', ctx());
    const text = collectText(content).join('');
    assert.doesNotMatch(text, /[<>]/);
    assert.match(text, /alert\(1\)/);
  });

  it('keeps only known content keys and valid values', () => {
    const c = ctx();
    const content = sanitizeBlocks(
      [
        { attachments: { a: { src: '/etc/passwd' } } },
        { text: 'x', link: 'file:///etc/passwd', font: 'Comic Sans', fontSize: 9999 },
        { table: { body: [['a', 'b']] }, layout: 'evil' }
      ],
      c
    );
    assert.equal(content.length, 2);
    assert.equal(content[0].link, undefined);
    assert.equal(content[0].font, 'Sans', 'unknown fonts fall back to the theme font');
    assert.equal(content[0].fontSize, 144, 'clamped');
    assert.equal(content[1].layout, 'ihubTable');
    assert.ok(c.warnings.some(w => w.includes('attachments')));
  });

  it('accepts only the colours pdfkit knows', () => {
    assert.equal(isColor('teal'), true);
    assert.equal(isColor('#0f766e'), true);
    assert.equal(isColor('#abc'), true);
    assert.equal(isColor('brandblue'), false);
    assert.equal(isColor('Red'), false, 'pdfkit looks names up as written');
    const [node] = sanitizeBlocks([{ text: 'x', color: 'brandblue' }], ctx());
    assert.equal(node.color, undefined);
    assert.notEqual(resolveTheme('default', { primaryColor: 'brandblue' }).primary, 'brandblue');
  });

  it('builds callouts and boxes as flowing one-cell tables', () => {
    const content = sanitizeBlocks(
      [{ callout: { tone: 'warning', title: 'Note', markdown: '**x**' } }, { box: { text: 'y' } }],
      ctx()
    );
    for (const node of content) {
      assert.deepEqual(node.table.widths, ['*']);
      assert.ok(node.layout.declarative, 'a declarative layout for the worker');
    }
  });

  it('refuses a document with too many layout elements', () => {
    const blocks = Array.from({ length: 60_000 }, () => 'x');
    assert.throws(() => sanitizeBlocks(blocks, ctx()), /too large/);
  });
});

describe('glyphs', () => {
  it('maps common colour emoji and drops what no font has', () => {
    const stats = { dropped: 0 };
    assert.equal(printableRuns('Done ✅', 'Sans', stats), 'Done ✔');
    assert.equal(printableRuns('中文', 'Sans', stats), '');
    assert.equal(stats.dropped, 2);
  });

  it('draws symbols a serif document lacks in Sans', () => {
    const runs = printableRuns('Check ✓', 'Serif', { dropped: 0 });
    assert.deepEqual(runs, ['Check ', { text: '✓', font: 'Sans' }]);
  });
});

describe('rendering', () => {
  it('produces a parseable PDF with metadata and a table of contents', async () => {
    const { buffer, pages, warnings } = await renderPdfSpec({
      title: 'Größenbericht',
      author: 'iHub',
      language: 'de',
      coverPage: true,
      toc: true,
      watermark: 'ENTWURF',
      markdown: '# Teil 1\n\nText.\n\n\\pagebreak\n\n# Teil 2\n\nMehr → ✓'
    });
    assert.equal(pages, 4, 'cover, contents, two parts');
    assert.deepEqual(warnings, []);
    const doc = await PDFDocument.load(buffer);
    assert.equal(doc.getTitle(), 'Größenbericht');
    assert.equal(doc.getAuthor(), 'iHub');
    assert.doesNotMatch(pdfText(buffer), /\/EmbeddedFile/);
  });

  it('never embeds a local file an SVG points at', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-pdf-'));
    const localPng = path.join(dir, 'secret.png');
    await fs.writeFile(localPng, Buffer.from(PNG_2X1.split(',')[1], 'base64'));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="50"><image href="${localPng}" width="50" height="50"/><image xlink:href="${localPng}" width="50" height="50"/></svg>`;
    const withLocal = await renderPdfSpec({
      title: 't',
      blocks: [{ svg }, { image: localPng }]
    });
    assert.doesNotMatch(pdfText(withLocal.buffer), /\/Subtype\s*\/Image/);
    const withInline = await renderPdfSpec({ title: 't', blocks: [{ image: PNG_2X1 }] });
    assert.match(pdfText(withInline.buffer), /\/Subtype\s*\/Image/);
  });

  it('renders every example of the pdf skill reference without warnings', async () => {
    const markdown = await fs.readFile(
      new URL('../systemSkills/pdf/references/examples.md', import.meta.url),
      'utf8'
    );
    const examples = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
    assert.ok(examples.length >= 4);
    for (const args of examples) {
      const { pages, warnings } = await renderPdfSpec(specFromToolArgs(args));
      assert.ok(pages >= 1, args.filename);
      assert.deepEqual(warnings, [], args.filename);
    }
  });

  it('accepts blocks, styles and images given as JSON strings', () => {
    const spec = specFromToolArgs({
      title: 't',
      blocks: '[{"text":"x","style":"badge"}]',
      styles: '{"badge":{"bold":true}}'
    });
    assert.deepEqual(spec.blocks, [{ text: 'x', style: 'badge' }]);
    assert.deepEqual(spec.styles, { badge: { bold: true } });
    assert.throws(() => specFromToolArgs({ title: 't', blocks: '[' }), PdfGenerationError);
  });

  it('declares blocks, styles and images as JSON text', () => {
    // Blocks are alternatives (one content key each); a schema'd array would
    // become "every key required" under a provider's strict schema mode.
    const { properties } = CREATE_PDF_TOOL.parameters;
    for (const key of ['blocks', 'styles', 'images']) {
      assert.equal(properties[key].type, 'string', key);
    }
  });
});

describe('PdfService', () => {
  it('renders in a worker and previews a page as PNG', async () => {
    const { buffer, pages } = await createPdf({ title: 'Worker', markdown: 'Hello' });
    assert.equal(pages, 1);
    const preview = await renderPagePreview(buffer, 1);
    assert.equal(preview.pages, 1);
    assert.equal(preview.png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.ok(preview.width > 500 && preview.height > preview.width);
  });

  it('stops a render that runs past its time budget', async () => {
    await assert.rejects(
      createPdf({ title: 'Slow', markdown: 'x' }, { timeoutMs: 1 }),
      error => error instanceof PdfGenerationError && error.code === 'timeout'
    );
  });

  it('reports a document without content as invalid', async () => {
    await assert.rejects(
      createPdf({ title: 'Empty' }),
      error => error instanceof PdfGenerationError && /no content/.test(error.message)
    );
  });
});

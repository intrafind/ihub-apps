// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Document templates (corporate design) and the Word and PowerPoint engines:
 * the template store and its file checks, which template a document gets,
 * templates applied to PDFs (logo, fonts, letterhead), Word documents built
 * on their own and merged into a localized Word template, presentations
 * built on the built-in master and on an uploaded template, and the tools
 * adapting to an app's template.
 *
 * Run: node --test server/tests/document-templates.test.js
 */
import fsSync from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The template store lives under CONTENTS_DIR, which the config module reads
// on import: point it at a scratch folder first.
const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-document-templates-'));
process.env.CONTENTS_DIR = path.join(baseDir, 'contents');

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const mammoth = require('mammoth');
const { PNG } = require('pngjs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const docx = require('docx');

const { documentTemplateSchema } = await import('../validators/documentTemplateSchema.js');
const templates = await import('../services/documents/templates/DocumentTemplateService.js');
const { checkTemplateAsset, TemplateAssetError } =
  await import('../services/documents/templates/templateAssets.js');
const { applyTemplateToPdfSpec, applyTemplateToDocxSpec, applyTemplateToPptxSpec } =
  await import('../services/documents/templates/applyTemplate.js');
const { renderPdfSpec } = await import('../services/documents/pdf/renderPdf.js');
const { renderDocx } = await import('../services/documents/docx/renderDocx.js');
const { renderPptx } = await import('../services/documents/pptx/renderPptx.js');
const { buildBaseTemplate } = await import('../services/documents/pptx/baseTemplate.js');
const { analyzePowerpointTemplate, chooseLayouts, loadPresentationTemplate } =
  await import('../services/documents/pptx/pptxTemplate.js');
const { sanitizeSlides } = await import('../services/documents/pptx/buildPptx.js');
const { sanitizeChart } = await import('../services/documents/pptx/charts.js');
const { mergeIntoWordTemplate } = await import('../services/documents/docx/wordTemplate.js');
const { buildDocx } = await import('../services/documents/docx/buildDocx.js');
const { openPackage, PACKAGE_LIMITS } = await import('../services/documents/ooxml/opcPackage.js');
const { applyLetterhead, letterheadPageFormat } =
  await import('../services/documents/pdf/letterhead.js');
const { pptxSpecFromToolArgs, runCreatePptx } =
  await import('../services/documents/pptx/pptxTools.js');
const { runCreateDocx } = await import('../services/documents/docx/docxTools.js');
const { heldGeneratedFile } = await import('../services/documents/generatedFiles.js');
const { systemSkillToolsFor, usesDocumentTemplates } =
  await import('../services/systemSkillTools.js');
const { renderTemplateSample } = await import('../services/documents/templates/templateSamples.js');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

after(() => fsSync.rmSync(baseDir, { recursive: true, force: true }));

// --- Fixtures -------------------------------------------------------------------

function pngBytes(width = 300, height = 100) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = 227;
    png.data[i * 4 + 1] = 6;
    png.data[i * 4 + 2] = 19;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function letterheadBytes() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawRectangle({ x: 0, y: 820, width: 595.28, height: 22, color: rgb(0.9, 0, 0.1) });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('LETTERHEAD ADDRESS LINE', { x: 50, y: 20, size: 8, font });
  return Buffer.from(await doc.save());
}

const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const serifFont = () => fsSync.readFileSync(path.join(FONT_DIR, 'DejaVuSerif.ttf'));

/**
 * A Word template as German Word writes one: style ids from the localized
 * names ("berschrift1" for "heading 1"), placeholders split over runs, a
 * logo in the header and the company in the footer.
 */
async function germanWordTemplate() {
  const { AlignmentType, Document, Footer, Header, ImageRun, Packer, Paragraph, TextRun } = docx;
  const document = new Document({
    styles: {
      paragraphStyles: [
        { id: 'berschrift1', name: 'heading 1', run: { size: 34, bold: true, color: '005A9C' } },
        { id: 'Titel', name: 'Title', run: { size: 60, color: '005A9C' } },
        { id: 'Listenabsatz', name: 'List Paragraph', paragraph: { indent: { left: 720 } } }
      ]
    },
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new ImageRun({
                    type: 'png',
                    data: pngBytes(),
                    transformation: { width: 120, height: 40 }
                  })
                ]
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [new TextRun('{{com'), new TextRun({ text: 'pany}} – Vertraulich' })]
              })
            ]
          })
        },
        children: [
          new Paragraph({
            style: 'Titel',
            children: [new TextRun('{{ti'), new TextRun({ text: 'tle}}', italics: true })]
          }),
          new Paragraph({ children: [new TextRun('Stand: {{date}}')] }),
          new Paragraph({ children: [new TextRun('{{content}}')] }),
          new Paragraph({ children: [new TextRun('Ende des Dokuments')] })
        ]
      }
    ]
  });
  return Packer.toBuffer(document);
}

/**
 * Every internal relationship of a package points at a part that exists, and
 * every part has a content type — what Office checks before it opens a file.
 */
async function assertPackageIntegrity(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const types = await zip.file('[Content_Types].xml').async('string');
  const defaults = new Set(
    [...types.matchAll(/Extension="([^"]+)"/g)].map(m => m[1].toLowerCase())
  );
  const overrides = new Set([...types.matchAll(/PartName="([^"]+)"/g)].map(m => m[1]));
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir || name === '[Content_Types].xml') continue;
    const ext = name.split('.').pop().toLowerCase();
    assert.ok(overrides.has(`/${name}`) || defaults.has(ext), `part ${name} has no content type`);
    if (!name.endsWith('.rels')) continue;
    const owner = name === '_rels/.rels' ? '' : name.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2');
    const dir = owner.includes('/') ? owner.slice(0, owner.lastIndexOf('/')) : '';
    const xml = await entry.async('string');
    for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = match[0];
      if (/TargetMode="External"/.test(tag)) continue;
      const target = /Target="([^"]+)"/.exec(tag)[1];
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(dir, target));
      assert.ok(zip.file(resolved), `${name} points at missing ${resolved}`);
    }
  }
  return zip;
}

const VALID = {
  id: 'acme',
  name: { en: 'ACME' },
  brand: { primaryColor: '#E30613', bodyFont: 'Brand Serif', companyName: 'ACME GmbH' },
  document: { header: '{title}', footer: '{company} · Internal' }
};

// --- Schema and store -------------------------------------------------------------

describe('document template schema', () => {
  it('accepts a template and fills the sections', () => {
    const parsed = documentTemplateSchema.parse(VALID);
    assert.equal(parsed.enabled, true);
    assert.deepEqual(parsed.fonts, []);
    assert.deepEqual(parsed.pptx, {});
  });

  it('refuses reserved ids, bad colours, unknown keys and duplicate font families', () => {
    for (const id of ['default', 'minimal', 'new', 'Has Space', '../x']) {
      assert.equal(documentTemplateSchema.safeParse({ ...VALID, id }).success, false, id);
    }
    assert.equal(
      documentTemplateSchema.safeParse({ ...VALID, brand: { primaryColor: 'red' } }).success,
      false
    );
    assert.equal(documentTemplateSchema.safeParse({ ...VALID, script: 'x' }).success, false);
    const font = { family: 'A', normal: 'font-a-normal.ttf' };
    assert.equal(
      documentTemplateSchema.safeParse({ ...VALID, fonts: [font, { ...font, family: 'a' }] })
        .success,
      false
    );
    assert.equal(
      documentTemplateSchema.safeParse({ ...VALID, brand: { logo: '../../etc/passwd' } }).success,
      false
    );
    // A file must be of the kind its slot takes.
    assert.equal(
      documentTemplateSchema.safeParse({ ...VALID, docx: { template: 'letterhead.pdf' } }).success,
      false
    );
    assert.equal(
      documentTemplateSchema.safeParse({
        ...VALID,
        fonts: [{ family: 'A', normal: 'logo.png' }]
      }).success,
      false
    );
  });
});

describe('template files', () => {
  it('accepts what each slot needs and refuses the rest', async () => {
    assert.equal((await checkTemplateAsset('logo', pngBytes(), 'png')).width, 300);
    await assert.rejects(checkTemplateAsset('logo', pngBytes(), 'jpg'), TemplateAssetError);
    await assert.rejects(checkTemplateAsset('letterhead', pngBytes(), 'pdf'), /must be a PDF/);
    assert.equal((await checkTemplateAsset('letterhead', await letterheadBytes(), 'pdf')).pages, 1);
    assert.match((await checkTemplateAsset('font', serifFont(), 'ttf')).familyName, /DejaVu/);
    await assert.rejects(checkTemplateAsset('font', pngBytes(), 'ttf'), /font file/);
    await assert.rejects(
      checkTemplateAsset('wordTemplate', pngBytes(), 'docx'),
      TemplateAssetError
    );
  });

  it('refuses Office files with macros', async () => {
    const zip = await JSZip.loadAsync(await germanWordTemplate());
    zip.file('word/vbaProject.bin', 'macro');
    const withMacro = await zip.generateAsync({ type: 'nodebuffer' });
    await assert.rejects(checkTemplateAsset('wordTemplate', withMacro, 'docx'), /macros/);
  });

  it('describes a Word template: placeholders and styles', async () => {
    const info = await checkTemplateAsset('wordTemplate', await germanWordTemplate(), 'dotx');
    assert.equal(info.contentPlaceholder, true);
    assert.deepEqual(info.placeholders, ['company', 'content', 'date', 'title']);
    assert.equal(info.styles.title, true);
  });
});

describe('template store', () => {
  it('creates, uploads, resolves and deletes templates', async () => {
    templates.clearTemplateCaches();
    await templates.saveTemplate('acme', { ...VALID, default: true }, { create: true });
    await assert.rejects(templates.saveTemplate('acme', VALID, { create: true }), /already exists/);
    await templates.saveTemplate(
      'other',
      { ...VALID, id: 'other', name: { en: 'Other' } },
      {
        create: true
      }
    );

    const { template, file } = await templates.saveTemplateAsset('acme', {
      slot: 'logo',
      data: pngBytes(),
      originalName: 'Company Logo.PNG'
    });
    assert.equal(file, 'logo.png');
    assert.equal(template.brand.logo, 'logo.png');
    await templates.saveTemplateAsset('acme', {
      slot: 'font',
      data: serifFont(),
      originalName: 'serif.ttf',
      family: 'Brand Serif',
      face: 'normal'
    });
    await assert.rejects(
      templates.saveTemplateAsset('acme', {
        slot: 'font',
        data: serifFont(),
        originalName: 'serif.ttf',
        family: 'New Family',
        face: 'bold'
      }),
      /regular style/
    );
    // Files are set by uploads only: a settings save (an editor opened
    // before the upload) neither drops the logo nor names another file.
    const saved = await templates.saveTemplate('acme', {
      ...VALID,
      default: true,
      brand: { ...VALID.brand, logo: undefined },
      pdf: { letterhead: 'letterhead.pdf' }
    });
    assert.equal(saved.brand.logo, 'logo.png');
    assert.equal(saved.pdf.letterhead, undefined);
    assert.equal(saved.fonts[0].family, 'Brand Serif');

    // Families whose names slug alike get files of their own.
    await templates.saveTemplateAsset('acme', {
      slot: 'font',
      data: serifFont(),
      originalName: 'x.ttf',
      family: 'Brand_Serif',
      face: 'normal'
    });
    const both = (await templates.getTemplate('acme')).fonts.map(font => font.normal);
    assert.equal(new Set(both).size, 2, both.join());

    // Resolution: the app's pinned template, else the request, else the default.
    assert.deepEqual(await templates.resolveTemplateId({}), { id: 'acme', pinned: false });
    assert.deepEqual(await templates.resolveTemplateId({ requested: 'other' }), {
      id: 'other',
      pinned: false
    });
    assert.deepEqual(
      await templates.resolveTemplateId({ app: { documentTemplate: 'other' }, requested: 'acme' }),
      { id: 'other', pinned: true }
    );
    assert.deepEqual(await templates.resolveTemplateId({ requested: 'missing' }), {
      id: 'acme',
      pinned: false
    });

    // Only one default: making "other" the default clears it on "acme".
    await templates.saveTemplate('other', {
      ...VALID,
      id: 'other',
      name: { en: 'Other' },
      default: true
    });
    const list = await templates.listTemplates();
    assert.deepEqual(
      list.filter(t => t.default).map(t => t.id),
      ['other']
    );

    const bundle = await templates.loadTemplateBundle('acme', 'pdf');
    assert.equal(bundle.assets.logo.extension, 'png');
    assert.equal(bundle.assets.fonts[0].family, 'Brand Serif');
    assert.equal(bundle.assets.fonts.length, 2);

    // Removing the logo removes its file.
    await templates.removeTemplateAsset('acme', { slot: 'logo' });
    const dir = path.join(process.env.CONTENTS_DIR, 'document-templates', 'acme');
    assert.equal(fsSync.existsSync(path.join(dir, 'logo.png')), false);

    await templates.deleteTemplate('other');
    assert.equal(await templates.getTemplate('other'), null);
    await assert.rejects(templates.deleteTemplate('../acme'), /Invalid template id/);
  });
});

// --- PDF ----------------------------------------------------------------------------

async function pageTexts(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false })
    .promise;
  const texts = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    texts.push(content.items.map(item => item.str).join(' '));
  }
  return texts;
}

describe('PDF with a template', () => {
  const bundle = async () => ({
    template: documentTemplateSchema.parse({
      ...VALID,
      document: { ...VALID.document, logoPosition: 'header-left', margins: [60, 90, 60, 70] },
      pdf: { theme: 'professional' }
    }),
    assets: {
      logo: { data: pngBytes(), extension: 'png' },
      letterhead: { data: await letterheadBytes() },
      fonts: [{ family: 'Brand Serif', faces: { normal: serifFont() } }]
    }
  });

  it('takes colours, fonts, page setup and header from the template', async () => {
    const { spec, assets } = applyTemplateToPdfSpec(
      {
        title: 'Report',
        markdown: 'Body',
        theme: 'minimal',
        themeOptions: { primaryColor: '#00ff00', font: 'mono' },
        page: { orientation: 'landscape', margins: [20, 20, 20, 20] },
        header: 'model header'
      },
      await bundle()
    );
    assert.equal(spec.theme, 'professional');
    assert.equal(spec.themeOptions.primaryColor, '#E30613');
    assert.equal(spec.themeOptions.font, 'Brand Serif');
    assert.deepEqual(spec.page.margins, [60, 90, 60, 70]);
    // A letterhead fixes the orientation it was drawn for.
    assert.equal(spec.page.orientation, 'portrait');
    assert.equal(spec.footer, 'ACME GmbH · Internal');
    assert.equal(spec.header, '{title}');
    assert.equal(spec.logo.position, 'header-left');
    assert.equal(assets.fonts.length, 1);
  });

  it('prints the letterhead under the content and embeds the brand font', async () => {
    const { spec, assets } = applyTemplateToPdfSpec(
      { title: 'Quarterly report', markdown: '## Overview\n\nThe body text.', coverPage: true },
      await bundle()
    );
    const { buffer, pages, warnings } = await renderPdfSpec(spec, assets);
    assert.equal(pages, 2);
    assert.deepEqual(warnings, []);
    const [cover, body] = await pageTexts(buffer);
    // The cover page has no letterhead; the following pages have.
    assert.doesNotMatch(cover, /LETTERHEAD ADDRESS LINE/);
    assert.match(body, /LETTERHEAD ADDRESS LINE/);
    assert.match(body, /The body text\./);
    assert.match(body, /ACME GmbH · Internal/);
    // The letterhead is drawn first, under the page's own content.
    const doc = await PDFDocument.load(buffer);
    const contents = doc.getPage(1).node.Contents();
    const first = doc.context.lookup(contents.get(0));
    const operators = zlib.inflateSync(Buffer.from(first.getContents())).toString('latin1');
    assert.match(operators, /\/Letterhead-?\d* Do/);
  });
});

// --- Word ---------------------------------------------------------------------------

const DOC_MARKDOWN = `# Overview

Text with **bold** and a [link](https://example.com).

> [!WARNING]
> Renew by 31 March.

| Region | Revenue |
|---|---:|
| EMEA | 1,200 |

1. First
2. Second
   - nested

A second list starts again at one:

1. Restarted

\`\`\`
const code = true;
\`\`\`

![Logo](data:image/png;base64,${pngBytes(40, 20).toString('base64')})
`;

describe('Word documents', () => {
  it('build with headings, lists, tables and pictures', async () => {
    const { buffer, warnings } = await renderDocx({
      title: 'Report',
      language: 'en',
      markdown: DOC_MARKDOWN,
      toc: true,
      header: '{title}',
      footer: 'Footer',
      colors: { primary: '#E30613' },
      logo: {
        image: `data:image/png;base64,${pngBytes().toString('base64')}`,
        position: 'header-right',
        width: 80
      }
    });
    assert.deepEqual(warnings, []);
    const zip = await assertPackageIntegrity(buffer);
    const xml = await zip.file('word/document.xml').async('string');
    assert.match(xml, /w:pStyle w:val="Heading1"/);
    assert.match(xml, /w:pStyle w:val="Title"/);
    // Two ordered lists: two numbering instances, so the second restarts.
    const numIds = new Set([...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(m => m[1]));
    assert.ok(numIds.size >= 3, `numbering instances: ${[...numIds]}`);
    const { value: text } = await mammoth.extractRawText({ buffer });
    for (const expected of ['Overview', 'Renew by 31 March.', 'EMEA', 'Restarted', 'Warning']) {
      assert.ok(text.includes(expected), `missing "${expected}"`);
    }
    assert.ok(Object.keys(zip.files).some(name => name.startsWith('word/media/')));
  });

  it('merge into a localized Word template', async () => {
    const { spec, assets } = applyTemplateToDocxSpec(
      { title: 'Quarterly report', markdown: DOC_MARKDOWN, language: 'de' },
      {
        template: documentTemplateSchema.parse({
          ...VALID,
          docx: { template: 'word-template.dotx' }
        }),
        assets: { wordTemplate: { data: await germanWordTemplate(), extension: 'dotx' } }
      }
    );
    const { buffer } = await renderDocx(spec, assets);
    const zip = await assertPackageIntegrity(buffer);
    const xml = await zip.file('word/document.xml').async('string');
    // The template's own styles, by built-in name.
    assert.match(xml, /w:pStyle w:val="berschrift1"/);
    assert.match(xml, /w:pStyle w:val="Listenabsatz"/);
    assert.doesNotMatch(xml, /w:pStyle w:val="Heading1"/);
    // Placeholders filled, also across runs; the content replaced {{content}}.
    assert.doesNotMatch(xml, /\{\{/);
    const { value: text } = await mammoth.extractRawText({ buffer });
    assert.ok(text.indexOf('Quarterly report') < text.indexOf('Overview'));
    assert.ok(text.indexOf('Overview') < text.indexOf('Ende des Dokuments'));
    const footer = await zip.file('word/footer1.xml').async('string');
    assert.match(footer.replaceAll(/<[^>]+>/g, ''), /ACME GmbH – Vertraulich/);
    // Styles the template lacks were copied over; the header logo stays.
    const styles = await zip.file('word/styles.xml').async('string');
    assert.match(styles, /w:styleId="IhubCode"/);
    assert.ok(zip.file('word/header1.xml'));
    // A .dotx became a document.
    const types = await zip.file('[Content_Types].xml').async('string');
    assert.match(types, /wordprocessingml\.document\.main\+xml/);
    assert.doesNotMatch(types, /template\.main\+xml/);
  });
});

// --- PowerPoint ------------------------------------------------------------------------

const SLIDES = [
  { layout: 'title', title: 'Deck', subtitle: 'Subtitle' },
  { title: 'Bullets', text: '- One\n- Two\n  - Nested', notes: 'Say this.' },
  { layout: 'section', title: 'Part two' },
  {
    title: 'Chart',
    chart: {
      type: 'column',
      categories: ['A', 'B'],
      series: [{ name: 'S', values: [1, 2] }]
    },
    text: 'Beside the chart'
  },
  { title: 'Table', table: { header: ['A', 'B'], rows: [['1', '2']] } },
  {
    layout: 'two-column',
    title: 'Two',
    left: { heading: 'L', text: '- a' },
    right: { image: `data:image/png;base64,${pngBytes(80, 40).toString('base64')}` }
  }
];

async function slideXml(zip, number) {
  return zip.file(`ppt/slides/slide${number}.xml`).async('string');
}

describe('presentations', () => {
  it('build on the built-in master made from the brand', async () => {
    const { buffer, meta, warnings } = await renderPptx(
      {
        title: 'Deck',
        language: 'en-US',
        footer: 'Footer text',
        slides: SLIDES,
        brand: { primaryColor: '#E30613', bodyFont: 'Carlito' }
      },
      { logo: { data: pngBytes(), extension: 'png', width: 300, height: 100 } }
    );
    assert.equal(meta.slides, SLIDES.length);
    assert.deepEqual(warnings, []);
    const zip = await assertPackageIntegrity(buffer);
    const theme = await zip.file('ppt/theme/theme1.xml').async('string');
    assert.match(theme, /<a:accent1><a:srgbClr val="E30613"\/>/);
    assert.match(theme, /<a:minorFont><a:latin typeface="Carlito"\/>/);
    // Titles and text go into the layout's placeholders.
    const bullets = await slideXml(zip, 2);
    assert.match(bullets, /<p:ph type="title"\/>/);
    assert.match(bullets, /<p:ph idx="1"\/>/);
    assert.match(bullets, /<a:pPr lvl="1">/);
    assert.match(bullets, /Footer text/);
    // A native chart with its workbook; notes on slide 2.
    assert.ok(Object.keys(zip.files).some(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)));
    assert.ok(Object.keys(zip.files).some(name => name.endsWith('.xlsx')));
    assert.ok(Object.keys(zip.files).some(name => name.startsWith('ppt/notesSlides/')));
    assert.match(await slideXml(zip, 5), /<a:tbl>/);
    assert.match(await slideXml(zip, 6), /<p:pic>/);
  });

  it('fill an uploaded template, without its sample slides', async () => {
    // A template that comes with slides of its own.
    const base = await buildBaseTemplate({ primaryColor: '#005A9C' });
    const withSlides = await renderPptx(
      { title: 'Old', slides: [{ title: 'OLD SAMPLE SLIDE' }, { title: 'ANOTHER' }] },
      { powerpointTemplate: base }
    );
    const analysis = await analyzePowerpointTemplate(withSlides.buffer);
    assert.equal(analysis.mapping.content, 'Title and Content');
    assert.equal(analysis.mapping.twoColumn, 'Two Content');

    const { spec, assets } = applyTemplateToPptxSpec(
      { title: 'New', slides: SLIDES.slice(0, 2) },
      {
        template: documentTemplateSchema.parse({
          ...VALID,
          pptx: { template: 'powerpoint-template.pptx', footer: '{company}' }
        }),
        assets: { powerpointTemplate: { data: withSlides.buffer, extension: 'pptx' } }
      }
    );
    const { buffer, meta } = await renderPptx(spec, assets);
    assert.equal(meta.slides, 2);
    const zip = await assertPackageIntegrity(buffer);
    const all = await Promise.all(
      Object.keys(zip.files)
        .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .map(name => zip.file(name).async('string'))
    );
    assert.equal(all.length, 2);
    assert.ok(all.every(xml => !xml.includes('OLD SAMPLE SLIDE')));
    assert.match(all.join(''), /ACME GmbH/);
    const presentation = await zip.file('ppt/presentation.xml').async('string');
    assert.equal([...presentation.matchAll(/<p:sldId /g)].length, 2);
  });

  it('use the layouts an admin names', async () => {
    const template = await loadPresentationTemplate(await buildBaseTemplate());
    const chosen = chooseLayouts(template.layouts, { content: 'Title Only' });
    assert.equal(chosen.content.name, 'Title Only');
    assert.equal(
      chooseLayouts(template.layouts, { content: 'Missing' }).content.name,
      'Title and Content'
    );
  });

  it('limit slides, tables and charts from the model', () => {
    const ctx = { warnings: [], imageBytes: 0 };
    const slides = sanitizeSlides(
      [
        {
          title: 'x'.repeat(1000),
          table: { header: ['a'], rows: Array.from({ length: 50 }, () => ['1']) }
        },
        { chart: { type: 'pie', categories: ['a'], series: [{ values: [1] }, { values: [2] }] } },
        { image: 'https://example.com/a.png' }
      ],
      ctx
    );
    assert.equal(slides[0].title.length, 300);
    assert.equal(slides[0].table.rows.length, 30);
    assert.equal(slides[1].chart.series.length, 1);
    assert.equal(slides[2].image, null);
    assert.ok(ctx.warnings.some(w => /table was cut/.test(w)));
    assert.ok(ctx.warnings.some(w => /image was skipped/.test(w)));
    assert.throws(() => pptxSpecFromToolArgs({ title: 't', slides: '[' }), /JSON/);
    assert.throws(() => pptxSpecFromToolArgs({ title: 't', slides: '[]' }), /non-empty/);
  });
});

// --- Tools and samples ---------------------------------------------------------------

describe('document tools and templates', () => {
  const skills = ['pdf', 'docx', 'pptx'].map(name => ({
    name,
    isSystem: true,
    providedTools: { pdf: ['create_pdf'], docx: ['create_docx'], pptx: ['create_pptx'] }[name]
  }));

  it('drop the brand parameters when the app pins a template', () => {
    assert.equal(usesDocumentTemplates(skills), true);
    const tools = systemSkillToolsFor(skills, {
      templates: { pinned: { id: 'acme', name: 'ACME' }, choices: [], defaultName: null }
    });
    const pdf = tools.find(t => t.id === 'create_pdf');
    assert.equal(pdf.parameters.properties.primaryColor, undefined);
    assert.equal(pdf.parameters.properties.theme, undefined);
    assert.equal(pdf.parameters.properties.template, undefined);
    assert.match(pdf.description, /"ACME"/);
  });

  it('offer a template choice otherwise', () => {
    const tools = systemSkillToolsFor(skills, {
      templates: {
        pinned: null,
        choices: [{ id: 'acme', name: 'ACME', description: '', default: true }],
        defaultName: 'ACME'
      }
    });
    for (const tool of tools) {
      assert.deepEqual(tool.parameters.properties.template.enum, ['default', 'acme']);
    }
    // Without templates nothing changes.
    const plain = systemSkillToolsFor(skills, { templates: { pinned: null, choices: [] } });
    assert.equal(plain[0].parameters.properties.template, undefined);
  });

  it('render the admin samples in every format', async () => {
    const template = documentTemplateSchema.parse(VALID);
    for (const format of ['png', 'docx', 'pptx']) {
      const { buffer } = await renderTemplateSample(template, format, 'de');
      assert.ok(buffer.length > 1000, format);
    }
  });

  it('create_docx and create_pptx render in the worker and hold the file for the chat', async () => {
    const user = { id: 'u1' };
    const docxResult = await runCreateDocx({
      filename: 'Proposal',
      title: 'Proposal',
      markdown: '# Scope\n\n- One\n- Two',
      user,
      chatId: 'chat-1',
      appConfig: { id: 'writer' }
    });
    assert.equal(docxResult.success, true, docxResult.error);
    assert.equal(docxResult.files[0].name, 'Proposal.docx');
    assert.equal(
      heldGeneratedFile(user, docxResult.file.id, { chatId: 'chat-1' }).mimeType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    const pptxResult = await runCreatePptx({
      filename: 'Deck',
      title: 'Deck',
      slides: JSON.stringify(SLIDES.slice(0, 2)),
      user,
      chatId: 'chat-1'
    });
    assert.equal(pptxResult.success, true, pptxResult.error);
    assert.equal(pptxResult.files[0].slides, 2);
    assert.equal(pptxResult.files[0].name, 'Deck.pptx');
    // The model's result names the file but never carries its bytes.
    assert.equal(JSON.stringify(pptxResult).includes('UEsDB'), false);

    const failure = await runCreatePptx({ title: 'x', slides: '{"not":"a list"}', user });
    assert.equal(failure.success, false);
    assert.match(failure.error, /non-empty JSON array/);
  });
});

// --- Review fixes ---------------------------------------------------------------------

/** A minimal Word template whose body is given as WordprocessingML. */
async function wordTemplateWithBody(bodyXml) {
  const zip = await JSZip.loadAsync(await germanWordTemplate());
  const xml = await zip.file('word/document.xml').async('string');
  const start = xml.indexOf('<w:body>') + '<w:body>'.length;
  const sectStart = xml.lastIndexOf('<w:sectPr');
  zip.file('word/document.xml', xml.slice(0, start) + bodyXml + xml.slice(sectStart));
  return zip.generateAsync({ type: 'nodebuffer' });
}

const para = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe('Word template merge, edge cases', () => {
  it('does not loop on a value that holds its own placeholder, nor touch the content', async () => {
    const template = await wordTemplateWithBody(para('{{title}}') + para('{{ content }}'));
    const { buffer: generated } = await buildDocx(
      { title: 'Using {{title}} placeholders', markdown: 'Write {{author}} here.' },
      { forTemplate: true }
    );
    const started = Date.now();
    const merged = await mergeIntoWordTemplate(generated, template, {
      values: { title: 'Using {{title}} placeholders', author: 'Alice' }
    });
    assert.ok(Date.now() - started < 5000);
    const xml = await (await JSZip.loadAsync(merged)).file('word/document.xml').async('string');
    const text = xml.replaceAll(/<[^>]+>/g, '');
    assert.match(text, /Using \{\{title\}\} placeholders/);
    // The model's own "{{author}}" stays as written; "{{ content }}" was the marker.
    assert.match(text, /Write \{\{author\}\} here\./);
    assert.doesNotMatch(text, /\{\{ content \}\}/);
  });

  it('keeps a section break stored in the content marker paragraph', async () => {
    const landscapeBreak =
      '<w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:pPr>' +
      '<w:r><w:t>{{content}}</w:t></w:r></w:p>';
    const template = await wordTemplateWithBody(landscapeBreak + para('Appendix'));
    const { buffer: generated } = await buildDocx({ markdown: 'Body' }, { forTemplate: true });
    const merged = await mergeIntoWordTemplate(generated, template, { values: {} });
    const xml = await (await JSZip.loadAsync(merged)).file('word/document.xml').async('string');
    assert.equal([...xml.matchAll(/<w:sectPr/g)].length, 2);
    assert.match(xml, /w:orient="landscape"/);
    assert.ok(xml.indexOf('Body') < xml.indexOf('w:orient="landscape"'));
  });

  it('refuses a Word template it cannot read with a message', async () => {
    const zip = await JSZip.loadAsync(await germanWordTemplate());
    zip.file('word/document.xml', '<w:document><w:body>');
    const broken = await zip.generateAsync({ type: 'nodebuffer' });
    await assert.rejects(checkTemplateAsset('wordTemplate', broken, 'docx'), TemplateAssetError);
  });

  it('accepts three-digit colours', async () => {
    const { buffer } = await renderDocx({ markdown: '# A', colors: { primary: '#fa0' } });
    const styles = await (await JSZip.loadAsync(buffer)).file('word/styles.xml').async('string');
    assert.match(styles, /FFAA00/);
  });
});

describe('Office packages', () => {
  it('stop inflating a part beyond the limit, whatever the archive declares', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<a/>');
    zip.file('word/big.xml', Buffer.alloc(8 * 1024 * 1024, 65));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await assert.rejects(
      openPackage(bytes, { ...PACKAGE_LIMITS, maxPartBytes: 1024 * 1024 }),
      /too large when unpacked/
    );
    await assert.rejects(
      openPackage(bytes, { ...PACKAGE_LIMITS, maxUncompressedBytes: 2 * 1024 * 1024 }),
      /too large/
    );
    assert.ok((await openPackage(bytes)).file('word/big.xml'));
  });
});

describe('letterheads, edge cases', () => {
  it('use the trim box wherever its origin is, and report their page format', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.setMediaBox(100, 100, 612, 792);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('OFFSET LETTERHEAD', { x: 150, y: 150, size: 10, font });
    const letterhead = Buffer.from(await doc.save());
    assert.deepEqual(await letterheadPageFormat(letterhead), {
      size: 'LETTER',
      orientation: 'portrait'
    });
    const { buffer } = await renderPdfSpec({ title: 'T', markdown: 'Body' });
    const printed = await applyLetterhead(buffer, { first: letterhead });
    const [text] = await pageTexts(printed);
    assert.match(text, /OFFSET LETTERHEAD/);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(printed) }).promise;
    const items = (await (await pdf.getPage(1)).getTextContent()).items;
    const item = items.find(i => i.str.includes('OFFSET'));
    // 50 pt in from the box origin, scaled from Letter to A4 width.
    assert.ok(item.transform[4] > 30 && item.transform[4] < 70, `x = ${item.transform[4]}`);
  });

  it("give templates without a page size the letterhead's format", async () => {
    const { spec } = applyTemplateToPdfSpec(
      { title: 'T', markdown: 'x', page: { size: 'A4', orientation: 'landscape' } },
      {
        template: documentTemplateSchema.parse(VALID),
        assets: {
          letterhead: {
            data: Buffer.alloc(1),
            pageFormat: { size: 'LETTER', orientation: 'portrait' }
          }
        }
      }
    );
    assert.equal(spec.page.size, 'LETTER');
    assert.equal(spec.page.orientation, 'portrait');
  });
});

describe('presentations, edge cases', () => {
  it('keep Markdown tables in slide text within the table limits', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| ${i} | x |`).join('\n');
    const { buffer, warnings } = await renderPptx({
      title: 'T',
      slides: [{ title: 'Big', text: `| A | B |\n|---|---|\n${rows}` }]
    });
    assert.ok(warnings.some(w => /table was cut/.test(w)));
    const xml = await (await JSZip.loadAsync(buffer)).file('ppt/slides/slide1.xml').async('string');
    assert.equal([...xml.matchAll(/<a:tr /g)].length, 31);
  });

  it('strip characters XML cannot hold from charts, and keep pie labels in percent', () => {
    const chart = sanitizeChart(
      {
        type: 'pie',
        title: 'T\u0001',
        categories: ['a\u0002', 'b'],
        series: [{ name: 'S\u0003', values: [1, 2] }],
        numberFormat: '#,##0'
      },
      []
    );
    assert.equal(chart.title, 'T');
    assert.deepEqual(chart.categories, ['a', 'b']);
    assert.equal(chart.series[0].name, 'S');
  });

  it('put two columns side by side in a comparison layout', async () => {
    // A layout with a heading box stacked over a content box on each side.
    const base = await buildBaseTemplate();
    const zip = await JSZip.loadAsync(base);
    const layoutPath = 'ppt/slideLayouts/slideLayout4.xml';
    let layout = await zip.file(layoutPath).async('string');
    const box = (id, idx, x, y, cx, cy, type = '') =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="P${id}"/><p:cNvSpPr/><p:nvPr><p:ph ${type}idx="${idx}"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr></p:sp>`;
    layout = layout
      .replace(
        /<p:sp><p:nvSpPr><p:cNvPr id="3"[\s\S]*?<\/p:sp><p:sp><p:nvSpPr><p:cNvPr id="4"[\s\S]*?<\/p:sp>/,
        ''
      )
      .replace(
        '</p:spTree>',
        box(5, 1, 457200, 1400000, 5000000, 400000, 'type="body" ') +
          box(6, 2, 457200, 1900000, 5000000, 3500000) +
          box(7, 3, 6400000, 1400000, 5000000, 400000, 'type="body" ') +
          box(8, 4, 6400000, 1900000, 5000000, 3500000) +
          '</p:spTree>'
      );
    zip.file(layoutPath, layout);
    const template = await zip.generateAsync({ type: 'nodebuffer' });
    const { buffer } = await renderPptx(
      {
        title: 'T',
        slides: [
          {
            layout: 'two-column',
            title: 'Compare',
            left: { text: 'LEFT SIDE' },
            right: { text: 'RIGHT SIDE' }
          }
        ]
      },
      { powerpointTemplate: template }
    );
    const xml = await (await JSZip.loadAsync(buffer)).file('ppt/slides/slide1.xml').async('string');
    assert.match(xml, /<p:ph idx="2"\/>[\s\S]*LEFT SIDE/);
    assert.match(xml, /<p:ph idx="4"\/>[\s\S]*RIGHT SIDE/);
  });
});

describe('Office packages, part names', () => {
  it('keep a part its relationship names percent-encoded or in another case', async () => {
    const { buffer } = await renderPptx({
      title: 'T',
      slides: [
        { title: 'Pic', image: `data:image/png;base64,${pngBytes(20, 10).toString('base64')}` }
      ]
    });
    const zip = await JSZip.loadAsync(buffer);
    const relsPath = 'ppt/slides/_rels/slide1.xml.rels';
    const rels = await zip.file(relsPath).async('string');
    const media = Object.keys(zip.files).find(name => name.startsWith('ppt/media/ihub-image'));
    const renamed = media.replace('ihub-image', 'ihub image');
    zip.file(renamed, await zip.file(media).async('nodebuffer'));
    zip.remove(media);
    zip.file(
      relsPath,
      rels.replace(
        media.split('/').pop(),
        renamed.split('/').pop().replace(' ', '%20').toUpperCase()
      )
    );
    const template = await zip.generateAsync({ type: 'nodebuffer' });
    // Filling it removes the old slides, but not by mistake a part still used.
    const opened = await openPackage(template);
    const { removeUnreachableParts, ContentTypes } =
      await import('../services/documents/ooxml/opcPackage.js');
    const removed = await removeUnreachableParts(opened, await ContentTypes.read(opened));
    assert.ok(!removed.includes(renamed), removed.join());
  });

  it('read table alignments only from their own names', async () => {
    const { buffer } = await renderPptx({
      title: 'T',
      slides: [
        {
          title: 'Tab',
          table: { header: ['a', 'b'], rows: [['1', '2']], align: ['constructor', 'right'] }
        }
      ]
    });
    const xml = await (await JSZip.loadAsync(buffer)).file('ppt/slides/slide1.xml').async('string');
    assert.doesNotMatch(xml, /function/);
    assert.match(xml, /algn="r"/);
  });
});

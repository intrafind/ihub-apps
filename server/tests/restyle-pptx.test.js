// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Moving an uploaded presentation onto the document template's PowerPoint
 * template (`restyle_pptx`): layouts by kind, titles and footers in the
 * template's positions, content scaled into its content area, pictures,
 * charts, tables and notes kept, colours following the template's theme.
 *
 * Run: node --test server/tests/restyle-pptx.test.js
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The template store lives under CONTENTS_DIR, which the config module reads
// on import: point it at a scratch folder first.
const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-restyle-'));
process.env.CONTENTS_DIR = path.join(baseDir, 'contents');

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { PNG } = require('pngjs');

const { restylePptx, RestyleError } = await import('../services/documents/pptx/restylePptx.js');
const { renderPptx } = await import('../services/documents/pptx/renderPptx.js');
const { buildBaseTemplate } = await import('../services/documents/pptx/baseTemplate.js');
const { contentArea } = await import('../services/documents/pptx/buildPptx.js');
const { chooseLayouts, loadPresentationTemplate } =
  await import('../services/documents/pptx/pptxTemplate.js');
const { assertWellFormed, openPackage, parseXml, readRels, resolveTarget } =
  await import('../services/documents/ooxml/opcPackage.js');
const templates = await import('../services/documents/templates/DocumentTemplateService.js');
const { runRestylePptx } = await import('../services/documents/pptx/pptxTools.js');
const { heldGeneratedFile } = await import('../services/documents/generatedFiles.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
const { default: configCache } = await import('../configCache.js');
const { getChatFileRepository } = await import('../services/chatFiles/ChatFileRepository.js');

after(() => fsSync.rmSync(baseDir, { recursive: true, force: true }));

// --- Fixtures -------------------------------------------------------------------

function pngDataUri(width = 200, height = 100) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data.set([30, 120, 200, 255], i * 4);
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

const SLIDES = [
  { layout: 'title', title: 'Vendor Briefing', subtitle: 'Mai 2026' },
  {
    title: 'Revenue grew 12 %',
    metrics: [{ value: '€3M', label: 'Revenue', note: '+12 %' }],
    text: '- One\n- Two',
    notes: 'Start with the enterprise deals.'
  },
  { layout: 'section', title: 'Financials', subtitle: 'Where the growth came from' },
  {
    title: 'EMEA leads',
    chart: {
      type: 'column',
      categories: ['EMEA', 'APAC'],
      series: [{ name: '2026', values: [1.2, 0.8] }]
    },
    text: 'Revenue in € million'
  },
  { layout: 'two-column', title: 'Options', left: { text: '- A' }, right: { text: '- B' } },
  {
    title: 'Next steps',
    table: { header: ['Action', 'Owner'], rows: [['Sign', 'CFO']] }
  },
  { title: 'The picture', image: { data: pngDataUri(), caption: 'A picture' } }
];

/** The deck as it comes from elsewhere: another design (blue), optionally 4:3. */
async function sourceDeck(aspectRatio = '16:9', slides = SLIDES) {
  const { buffer } = await renderPptx({
    title: 'Old deck',
    slides,
    brand: { aspectRatio, primaryColor: '#1E3A8A', accentColor: '#0F766E' }
  });
  return buffer;
}

/** The company template: another colour, always 16:9. */
const companyTemplate = () =>
  buildBaseTemplate({ primaryColor: '#AB0D19', accentColor: '#008EB7', aspectRatio: '16:9' });

const text = async (zip, name) => zip.file(name).async('string');

/** The name of the layout a slide uses. */
async function layoutNameOf(zip, number) {
  const slidePath = `ppt/slides/slide${number}.xml`;
  const rel = (await readRels(zip, slidePath)).find(r => r.type.endsWith('/slideLayout'));
  const layout = await text(zip, resolveTarget(slidePath, rel.target));
  return /<p:cSld name="([^"]*)"/.exec(layout)[1];
}

function rectOf(element) {
  const off = element.getElementsByTagName('a:off')[0];
  const ext = element.getElementsByTagName('a:ext')[0];
  return {
    x: Number(off.getAttribute('x')),
    y: Number(off.getAttribute('y')),
    cx: Number(ext.getAttribute('cx')),
    cy: Number(ext.getAttribute('cy'))
  };
}

// --- The engine -------------------------------------------------------------------

describe('restylePptx', () => {
  it('puts every slide on the template layout of its kind', async () => {
    const { buffer, slides } = await restylePptx(await sourceDeck(), await companyTemplate());
    assert.equal(slides, SLIDES.length);
    await assertWellFormed(await openPackage(buffer));
    const zip = await JSZip.loadAsync(buffer);
    const names = [];
    for (let n = 1; n <= slides; n += 1) names.push(await layoutNameOf(zip, n));
    assert.deepEqual(names, [
      'Title Slide',
      'Title and Content',
      'Section Header',
      'Title and Content',
      'Two Content',
      'Title and Content',
      'Title and Content'
    ]);
  });

  it('lets titles take the template positions and keeps the text', async () => {
    const { buffer } = await restylePptx(await sourceDeck(), await companyTemplate());
    const zip = await JSZip.loadAsync(buffer);
    const doc = parseXml(await text(zip, 'ppt/slides/slide2.xml'));
    const title = [...doc.getElementsByTagName('p:sp')].find(sp =>
      /<p:ph type="title"/.test(sp.toString())
    );
    assert.ok(title, 'the title is still a title placeholder');
    assert.equal(title.getElementsByTagName('a:xfrm').length, 0, 'it inherits its position');
    assert.match(await text(zip, 'ppt/slides/slide2.xml'), /Revenue grew 12 %/);
    // The cover keeps its title and subtitle.
    const cover = await text(zip, 'ppt/slides/slide1.xml');
    assert.match(cover, /Vendor Briefing/);
    assert.match(cover, /Mai 2026/);
  });

  it('gives body text alone on a slide the template content area, as a placeholder', async () => {
    const { buffer } = await restylePptx(
      await sourceDeck('16:9', [SLIDES[0], { title: 'Bullets', text: '- One\\n- Two' }]),
      await companyTemplate()
    );
    const zip = await JSZip.loadAsync(buffer);
    const slide = await text(zip, 'ppt/slides/slide2.xml');
    const shapes = [...parseXml(slide).getElementsByTagName('p:sp')];
    assert.ok(shapes.length >= 2);
    for (const shape of shapes) {
      assert.equal(shape.getElementsByTagName('a:xfrm').length, 0, 'it inherits its position');
    }
    assert.match(slide, /<p:ph idx="1"/);
  });

  it('drops backgrounds and the old theme: colours follow the template', async () => {
    const { buffer } = await restylePptx(await sourceDeck(), await companyTemplate());
    const zip = await JSZip.loadAsync(buffer);
    const chart = await text(
      zip,
      Object.keys(zip.files).find(name => /^ppt\/charts\/chart[^/]*\.xml$/.test(name))
    );
    assert.doesNotMatch(chart, /1E3A8A/i, 'the old primary colour is gone from the chart');
    assert.match(chart, /schemeClr val="accent1"/);
    const theme = await text(zip, 'ppt/theme/theme1.xml');
    assert.match(theme, /AB0D19/);
    assert.doesNotMatch(theme, /1E3A8A/i);
    for (let n = 1; n <= SLIDES.length; n += 1) {
      assert.doesNotMatch(await text(zip, `ppt/slides/slide${n}.xml`), /<p:bg>/);
    }
  });

  it('keeps charts with their data, pictures, tables and speaker notes', async () => {
    const { buffer } = await restylePptx(await sourceDeck(), await companyTemplate());
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);
    assert.ok(
      names.some(n => /^ppt\/charts\/chart[^/]*\.xml$/.test(n)),
      'chart'
    );
    assert.ok(
      names.some(n => /^ppt\/embeddings\/.*\.xlsx$/.test(n)),
      'its data workbook'
    );
    assert.ok(
      names.some(n => /^ppt\/media\/.*\.png$/.test(n)),
      'picture'
    );
    assert.match(await text(zip, 'ppt/slides/slide6.xml'), /<a:tbl>/);
    assert.match(await text(zip, 'ppt/slides/slide6.xml'), /Sign/);

    // The chart and the picture are reachable from their slides.
    const chartRel = (await readRels(zip, 'ppt/slides/slide4.xml')).find(r =>
      r.type.endsWith('/chart')
    );
    assert.ok(zip.file(resolveTarget('ppt/slides/slide4.xml', chartRel.target)));
    const imageRel = (await readRels(zip, 'ppt/slides/slide7.xml')).find(r =>
      r.type.endsWith('/image')
    );
    assert.ok(zip.file(resolveTarget('ppt/slides/slide7.xml', imageRel.target)));

    // The notes are on the template's notes master.
    const notesRel = (await readRels(zip, 'ppt/slides/slide2.xml')).find(r =>
      r.type.endsWith('/notesSlide')
    );
    const notesPath = resolveTarget('ppt/slides/slide2.xml', notesRel.target);
    assert.match(await text(zip, notesPath), /Start with the enterprise deals/);
    const masterRel = (await readRels(zip, notesPath)).find(r => r.type.endsWith('/notesMaster'));
    assert.ok(zip.file(resolveTarget(notesPath, masterRel.target)));
  });

  it('scales mixed content, together, into the content area', async () => {
    const template = await companyTemplate();
    const { buffer } = await restylePptx(await sourceDeck('4:3'), template);
    const zip = await JSZip.loadAsync(buffer);
    const target = await loadPresentationTemplate(template);
    const area = contentArea(
      target.layouts.find(l => l.name === 'Title and Content'),
      chooseLayouts(target.layouts),
      target.slideSize
    );

    // Slide 4: text beside a chart. Both lie inside the content area.
    const doc = parseXml(await text(zip, 'ppt/slides/slide4.xml'));
    // Shapes that carry a position of their own (the title and the footers inherit theirs).
    const shapes = [
      ...doc.getElementsByTagName('p:graphicFrame'),
      ...doc.getElementsByTagName('p:sp')
    ].filter(shape => shape.getElementsByTagName('a:off').length > 0);
    assert.ok(shapes.length >= 2);
    for (const shape of shapes) {
      const rect = rectOf(shape);
      assert.ok(rect.x >= area.x - 2 && rect.y >= area.y - 2, 'starts inside the content area');
      assert.ok(rect.x + rect.cx <= area.x + area.cx + 2, 'ends inside the content area (right)');
      assert.ok(rect.y + rect.cy <= area.y + area.cy + 2, 'ends inside the content area (bottom)');
    }
  });

  it('fits a deck of another size onto the template size', async () => {
    const { buffer, warnings } = await restylePptx(
      await sourceDeck('4:3'),
      await companyTemplate()
    );
    assert.deepEqual(warnings, []);
    const zip = await JSZip.loadAsync(buffer);
    for (let n = 1; n <= SLIDES.length; n += 1) {
      const doc = parseXml(await text(zip, `ppt/slides/slide${n}.xml`));
      for (const off of [...doc.getElementsByTagName('a:off')]) {
        const ext = off.parentNode.getElementsByTagName('a:ext')[0];
        if (!ext) continue;
        assert.ok(Number(off.getAttribute('x')) + Number(ext.getAttribute('cx')) <= 12192000 + 2);
        assert.ok(Number(off.getAttribute('y')) + Number(ext.getAttribute('cy')) <= 6858000 + 2);
      }
    }
  });

  it('adds the template footer and slide numbers where the slide has none, not on the cover', async () => {
    const source = await sourceDeck('16:9', SLIDES.slice(0, 3));
    const { buffer } = await restylePptx(source, await companyTemplate(), {
      footer: 'Confidential',
      slideNumbers: true
    });
    const zip = await JSZip.loadAsync(buffer);
    assert.doesNotMatch(await text(zip, 'ppt/slides/slide1.xml'), /Confidential|type="sldNum"/);
    const second = await text(zip, 'ppt/slides/slide2.xml');
    assert.match(second, /Confidential/);
    assert.match(second, /type="sldNum"/);
  });

  it('refuses what is no presentation', async () => {
    await assert.rejects(restylePptx(Buffer.from('nope'), await companyTemplate()));
    await assert.rejects(restylePptx(await sourceDeck(), Buffer.from('nope')));
    assert.ok(new RestyleError('x') instanceof Error);
  });
});

// --- The tool -----------------------------------------------------------------------

describe('restyle_pptx', () => {
  const user = { id: 'u-restyle' };
  const chatId = 'chat-restyle';
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  let repo;

  before(async () => {
    await bootstrapStorage({
      storage: {
        provider: 'filesystem',
        filesystem: { baseDir: path.join(baseDir, 'storage'), flushIntervalMs: 25 }
      }
    });
    configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
    repo = getChatFileRepository();
    // A document template with the company's PowerPoint template.
    await templates.saveTemplate('acme', { name: { en: 'ACME' } }, { create: true });
    await templates.saveTemplateAsset('acme', {
      slot: 'powerpointTemplate',
      data: await companyTemplate(),
      originalName: 'master.pptx'
    });
  });

  after(() => shutdownStorageBootstrap());

  async function upload(bytes, name = 'old-deck.pptx', mimeType = PPTX) {
    const file = await repo.put(
      { type: 'chat', id: chatId },
      {
        ownerId: user.id,
        name,
        mimeType,
        text: 'text',
        originalBuffer: bytes,
        storageMode: 'original_and_text'
      }
    );
    return file.id;
  }

  const run = params => runRestylePptx({ user, chatId, appConfig: { id: 'chat' }, ...params });
  const open = result => JSZip.loadAsync(heldGeneratedFile(user, result.file.id, { chatId }).data);

  it('moves an uploaded deck onto the document template and hands it to the chat', async () => {
    const fileId = await upload(await sourceDeck('4:3'));
    const result = await run({ fileId, template: 'acme', filename: 'branded' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.template, 'acme');
    assert.equal(result.file.name, 'branded.pptx');
    assert.equal(result.files[0].slides, SLIDES.length);
    assert.match(result.message, /"acme" document template/);
    const zip = await open(result);
    assert.equal(await layoutNameOf(zip, 1), 'Title Slide');
    assert.match(await text(zip, 'ppt/theme/theme1.xml'), /AB0D19/);
    assert.match(await text(zip, 'ppt/slides/slide2.xml'), /Revenue grew 12 %/);
  });

  it('names the file after the upload by default', async () => {
    const fileId = await upload(await sourceDeck(), 'Quarterly review.pptx');
    const result = await run({ fileId, template: 'acme' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.file.name, 'Quarterly review.pptx');
  });

  it('uses the built-in slide design when no document template applies', async () => {
    const fileId = await upload(await sourceDeck());
    const result = await run({ fileId });
    assert.equal(result.success, true, result.error);
    assert.equal(result.template, undefined);
    assert.match(result.message, /built-in slide design/);
  });

  it('refuses files that are no decks and unknown ids', async () => {
    const docx = await upload(
      Buffer.from('x'),
      'notes.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    const wrong = await run({ fileId: docx, template: 'acme' });
    assert.equal(wrong.success, false);
    assert.match(wrong.error, /not a PowerPoint/);
    assert.equal((await run({ fileId: 'file_unknown' })).success, false);
    assert.equal((await run({})).success, false);
  });
});

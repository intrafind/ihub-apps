// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The slide frame of a document template: a cover and a frame (top and left
 * strip, logo) put on a finished presentation, the template slots that hold
 * its pictures, and `create_pptx` building decks with it.
 *
 * Run: node --test server/tests/slide-frame.test.js
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The template store lives under CONTENTS_DIR, which the config module reads
// on import: point it at a scratch folder first.
const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-slide-frame-'));
process.env.CONTENTS_DIR = path.join(baseDir, 'contents');

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { PNG } = require('pngjs');

const { applySlideFrame, coverTextOf, frameHasContent, SlideFrameError } =
  await import('../services/documents/pptx/slideFrame.js');
const { renderPptx } = await import('../services/documents/pptx/renderPptx.js');
const { assertWellFormed, openPackage, parseXml } =
  await import('../services/documents/ooxml/opcPackage.js');
const { documentTemplateSchema, referencedAssets } =
  await import('../validators/documentTemplateSchema.js');
const templates = await import('../services/documents/templates/DocumentTemplateService.js');
const { checkTemplateAsset, TemplateAssetError } =
  await import('../services/documents/templates/templateAssets.js');
const { runCreatePptx, runFramePptx } = await import('../services/documents/pptx/pptxTools.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
const { default: configCache } = await import('../configCache.js');
const { getChatFileRepository } = await import('../services/chatFiles/ChatFileRepository.js');
const { heldGeneratedFile } = await import('../services/documents/generatedFiles.js');

after(() => fsSync.rmSync(baseDir, { recursive: true, force: true }));

// --- Fixtures -------------------------------------------------------------------

function pngBytes(width, height, [r, g, b] = [10, 140, 90]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

const IMAGES = {
  coverBackground: { data: pngBytes(160, 90, [20, 30, 90]), extension: 'png' },
  stripTop: { data: pngBytes(200, 6), extension: 'png' },
  stripLeft: { data: pngBytes(6, 106), extension: 'png' },
  logo: { data: pngBytes(118, 13, [170, 13, 25]), extension: 'png' }
};

const SLIDES = [
  { layout: 'title', title: 'Vendor Briefing', subtitle: 'Mai 2026' },
  { title: 'Revenue grew', text: '- One\n- Two' },
  { title: 'Next', text: '- Three' }
];

async function build(slides = SLIDES) {
  const { buffer } = await renderPptx({ title: 'Deck', slides, brand: { aspectRatio: '16:9' } });
  return buffer;
}

async function slideXml(buffer, number) {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file(`ppt/slides/slide${number}.xml`).async('string');
}

const count = (text, pattern) => (text.match(pattern) || []).length;

/** A template with a logo and the frame's three pictures; the frame is switched on. */
async function framedTemplate(id, frame = {}) {
  await templates.saveTemplate(id, { name: { en: id } }, { create: true });
  for (const [slot, data] of [
    ['logo', IMAGES.logo.data],
    ['frameCover', IMAGES.coverBackground.data],
    ['frameTop', IMAGES.stripTop.data],
    ['frameLeft', IMAGES.stripLeft.data]
  ]) {
    await templates.saveTemplateAsset(id, { slot, data, originalName: `${slot}.png` });
  }
  const current = await templates.getTemplate(id, { includeDisabled: true });
  await templates.saveTemplate(id, {
    ...current,
    brand: { ...current.brand, companyName: 'ACME GmbH', textColor: '#58585A' },
    pptx: { ...current.pptx, frame: { ...current.pptx.frame, enabled: true, ...frame } }
  });
}

// --- The engine -------------------------------------------------------------------

describe('applySlideFrame', () => {
  it('rebuilds the first slide as the cover and frames the others', async () => {
    const deck = await build();
    const before = await slideXml(deck, 2);
    const { buffer, slides, cover } = await applySlideFrame(deck, IMAGES);
    assert.equal(slides, 3);
    assert.equal(cover, true);
    await assertWellFormed(await openPackage(buffer));

    // Cover: background, panel, logo, title and date from the slide itself, footer.
    const first = await slideXml(buffer, 1);
    assert.match(first, /name="Cover background"/);
    assert.match(first, /name="Cover panel"/);
    assert.match(first, /<a:t>Vendor Briefing<\/a:t>/);
    assert.match(first, /<a:t>Mai 2026<\/a:t>/);
    assert.match(first, /<a:t>Vendor Briefing · Mai 2026<\/a:t>/);
    assert.equal(count(first, /<p:pic>/g), 3, 'background and two logos');
    assert.doesNotMatch(first, /type="ctrTitle"/, 'the original placeholders are gone');

    // Content slide: its own shapes stay, the frame is added on top.
    const second = await slideXml(buffer, 2);
    const own = before.slice(before.indexOf('<p:spTree>'), before.indexOf('</p:spTree>'));
    assert.ok(second.includes(own.slice(own.indexOf('<p:sp>'), own.indexOf('<p:sp>') + 200)));
    assert.match(second, /<a:t>Revenue grew<\/a:t>/);
    assert.match(second, /name="Frame top"/);
    assert.match(second, /name="Frame left"/);
    assert.match(second, /name="Logo"/);
    assert.ok(second.lastIndexOf('name="Logo"') > second.indexOf('<a:t>Revenue grew</a:t>'));

    // Media parts are shared, content types declared.
    const zip = await JSZip.loadAsync(buffer);
    const media = Object.keys(zip.files).filter(name => name.startsWith('ppt/media/ihub-frame-'));
    assert.deepEqual(media.sort(), [
      'ppt/media/ihub-frame-coverBackground.png',
      'ppt/media/ihub-frame-logo.png',
      'ppt/media/ihub-frame-stripLeft.png',
      'ppt/media/ihub-frame-stripTop.png'
    ]);
    assert.match(await zip.file('[Content_Types].xml').async('string'), /Extension="png"/);
  });

  it('keeps the strips in the proportions of their pictures and scales to the slide', async () => {
    const { buffer } = await applySlideFrame(await build(), IMAGES);
    const doc = parseXml(await slideXml(buffer, 2));
    const sizeOf = name => {
      const pic = [...doc.getElementsByTagName('p:pic')].find(
        p => p.getElementsByTagName('p:cNvPr')[0].getAttribute('name') === name
      );
      const ext = pic.getElementsByTagName('a:ext')[0];
      const off = pic.getElementsByTagName('a:off')[0];
      return {
        x: Number(off.getAttribute('x')),
        y: Number(off.getAttribute('y')),
        cx: Number(ext.getAttribute('cx')),
        cy: Number(ext.getAttribute('cy'))
      };
    };
    const W = 12192000;
    const H = 6858000;
    const top = sizeOf('Frame top');
    assert.deepEqual([top.x, top.y, top.cx], [0, 0, W]);
    assert.equal(top.cy, Math.round(W * (6 / 200)));
    const left = sizeOf('Frame left');
    assert.equal(left.y, top.cy);
    assert.equal(left.cy, H - top.cy);
    assert.equal(left.cx, Math.round((H - top.cy) * (6 / 106)));
    const logo = sizeOf('Logo');
    // A quarter inch from the right and bottom edge (the reference canvas is 13.333 in wide:
    // a few EMU of rounding).
    assert.ok(Math.abs(W - (logo.x + logo.cx) - 228600) <= 10);
    assert.ok(Math.abs(H - (logo.y + logo.cy) - 228600) <= 10);
  });

  it('takes the cover texts from the options, with {title} and {date} in the footer', async () => {
    const { buffer } = await applySlideFrame(await build(), IMAGES, {
      title: 'Override',
      date: 'Heute',
      footer: '{title} / {date} / IntraFind'
    });
    const first = await slideXml(buffer, 1);
    assert.match(first, /<a:t>Override<\/a:t>/);
    assert.match(first, /<a:t>Heute<\/a:t>/);
    assert.match(first, /<a:t>Override \/ Heute \/ IntraFind<\/a:t>/);
  });

  it('frames every slide when the first one is not a cover', async () => {
    const { buffer, cover } = await applySlideFrame(await build(), IMAGES, { cover: false });
    assert.equal(cover, false);
    const first = await slideXml(buffer, 1);
    assert.match(first, /<a:t>Vendor Briefing<\/a:t>/);
    assert.match(first, /name="Frame top"/);
    assert.doesNotMatch(first, /Cover background/);
  });

  it('without a cover picture there is no cover, only the frame', async () => {
    const { buffer, cover } = await applySlideFrame(await build(), {
      stripTop: IMAGES.stripTop,
      logo: IMAGES.logo
    });
    assert.equal(cover, false);
    assert.match(await slideXml(buffer, 1), /name="Frame top"/);
    assert.doesNotMatch(await slideXml(buffer, 2), /Frame left/);
  });

  it('crops a cover picture of another proportion instead of stretching it', async () => {
    const wide = { data: pngBytes(200, 50), extension: 'png' };
    const { buffer } = await applySlideFrame(await build(), { ...IMAGES, coverBackground: wide });
    assert.match(await slideXml(buffer, 1), /<a:srcRect l="\d+" r="\d+"\/>/);
    const exact = await applySlideFrame(await build(), IMAGES);
    assert.doesNotMatch(await slideXml(exact.buffer, 1), /srcRect/);
  });

  it('refuses a frame without pictures, and a file that is no presentation', async () => {
    await assert.rejects(applySlideFrame(await build(), { logo: IMAGES.logo }), SlideFrameError);
    await assert.rejects(applySlideFrame(Buffer.from('nope'), IMAGES));
    assert.equal(frameHasContent({ logo: IMAGES.logo }), false);
    assert.equal(frameHasContent({ stripTop: IMAGES.stripTop }), true);
  });
});

describe('coverTextOf', () => {
  const doc = body =>
    parseXml(
      `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
    );
  const sp = (text, ph) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

  it('prefers the title and subtitle placeholders', () => {
    const text = coverTextOf(
      doc(sp('Some note') + sp('The date', 'subTitle') + sp('The title', 'ctrTitle'))
    );
    assert.deepEqual(text, { title: 'The title', date: 'The date' });
  });

  it('otherwise takes the first two text shapes, skipping footers and slide numbers', () => {
    const text = coverTextOf(
      doc(sp('9', 'sldNum') + sp('First') + sp('') + sp('Second') + sp('Third'))
    );
    assert.deepEqual(text, { title: 'First', date: 'Second' });
  });
});

// --- Template settings and files ------------------------------------------------------

describe('the frame in a document template', () => {
  const base = { id: 'acme', name: { en: 'ACME' } };

  it('is part of the template schema; its pictures count as files of the template', () => {
    const parsed = documentTemplateSchema.parse({
      ...base,
      pptx: {
        frame: {
          enabled: true,
          coverBackground: 'frame-cover.jpeg',
          stripTop: 'frame-top.png',
          stripLeft: 'frame-left.png',
          coverFooter: '{title} · {company}'
        }
      }
    });
    assert.equal(parsed.pptx.frame.enabled, true);
    assert.deepEqual(referencedAssets(parsed).sort(), [
      'frame-cover.jpeg',
      'frame-left.png',
      'frame-top.png'
    ]);
    assert.equal(
      documentTemplateSchema.parse({ ...base, pptx: { frame: {} } }).pptx.frame.enabled,
      false
    );
  });

  it('refuses a picture slot filled with another kind of file, and unknown settings', () => {
    assert.throws(() =>
      documentTemplateSchema.parse({ ...base, pptx: { frame: { stripTop: 'frame-top.pdf' } } })
    );
    assert.throws(() =>
      documentTemplateSchema.parse({ ...base, pptx: { frame: { color: '#fff' } } })
    );
  });

  it('checks the pictures at upload', async () => {
    const info = await checkTemplateAsset('frameTop', pngBytes(200, 6), 'png');
    assert.deepEqual([info.width, info.height], [200, 6]);
    await assert.rejects(
      checkTemplateAsset('frameCover', Buffer.from('not an image'), 'jpg'),
      error => error instanceof TemplateAssetError && /cover picture/.test(error.message)
    );
    await assert.rejects(
      checkTemplateAsset('frameLeft', Buffer.from('x'), 'gif'),
      TemplateAssetError
    );
  });

  it('stores the pictures per slot, keeps them over a settings save, and removes them', async () => {
    await templates.saveTemplate('framed', { name: { en: 'Framed' } }, { create: true });
    const up = await templates.saveTemplateAsset('framed', {
      slot: 'frameTop',
      data: IMAGES.stripTop.data,
      originalName: 'strip.PNG'
    });
    assert.equal(up.file, 'frame-top.png');
    assert.equal(up.template.pptx.frame.stripTop, 'frame-top.png');
    await templates.saveTemplateAsset('framed', {
      slot: 'frameCover',
      data: IMAGES.coverBackground.data,
      originalName: 'cover.png'
    });

    // A save from an editor that knows no pictures neither drops nor swaps them.
    const saved = await templates.saveTemplate('framed', {
      name: { en: 'Framed' },
      pptx: { frame: { enabled: true, coverFooter: '{title}' } }
    });
    assert.deepEqual(saved.pptx.frame, {
      enabled: true,
      coverFooter: '{title}',
      stripTop: 'frame-top.png',
      coverBackground: 'frame-cover.png'
    });

    const bundle = await templates.loadTemplateBundle('framed', 'pptx');
    assert.deepEqual(Object.keys(bundle.assets.frame).sort(), ['coverBackground', 'stripTop']);

    const removed = await templates.removeTemplateAsset('framed', { slot: 'frameTop' });
    assert.equal(removed.pptx.frame.stripTop, undefined);
    assert.equal(removed.pptx.frame.coverBackground, 'frame-cover.png');
    assert.equal(
      fsSync.existsSync(path.join(templates.templatesDirectory(), 'framed', 'frame-top.png')),
      false
    );
  });

  it('is not loaded while the frame is switched off', async () => {
    await templates.saveTemplate('quiet', { name: { en: 'Quiet' } }, { create: true });
    await templates.saveTemplateAsset('quiet', {
      slot: 'frameTop',
      data: IMAGES.stripTop.data,
      originalName: 'strip.png'
    });
    const bundle = await templates.loadTemplateBundle('quiet', 'pptx');
    assert.equal(bundle.assets.frame, undefined);
  });
});

describe('create_pptx with a framed template', () => {
  const user = { id: 'u1' };

  async function create(slides, template) {
    const result = await runCreatePptx({
      filename: 'deck',
      title: 'Deck',
      slides: JSON.stringify(slides),
      template,
      user,
      chatId: 'chat-1'
    });
    assert.equal(result.success, true, result.error);
    return JSZip.loadAsync(heldGeneratedFile(user, result.file.id, { chatId: 'chat-1' }).data);
  }

  it('puts the cover and frame on the deck', async () => {
    await framedTemplate('acme-framed', { coverFooter: '{title} · {company}' });
    const zip = await create(SLIDES, 'acme-framed');
    const first = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.match(first, /name="Cover background"/);
    assert.match(first, /<a:t>Vendor Briefing<\/a:t>/);
    assert.match(first, /<a:t>Vendor Briefing · ACME GmbH<\/a:t>/);
    assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /name="Frame top"/);
    // The built-in master keeps its own logo out of the way.
    const master = await zip.file('ppt/slideMasters/slideMaster1.xml').async('string');
    assert.doesNotMatch(master, /<p:pic>/);
  });

  it('does not rebuild a first slide that is not a title slide', async () => {
    await framedTemplate('acme-notitle');
    const zip = await create(SLIDES.slice(1), 'acme-notitle');
    const first = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.doesNotMatch(first, /Cover background/);
    assert.match(first, /<a:t>Revenue grew<\/a:t>/);
    assert.match(first, /name="Frame top"/);
  });

  it('leaves decks alone when the frame is off', async () => {
    await framedTemplate('acme-off', { enabled: false });
    const zip = await create(SLIDES, 'acme-off');
    assert.doesNotMatch(await zip.file('ppt/slides/slide2.xml').async('string'), /Frame top/);
  });
});

describe('frame_pptx', () => {
  const user = { id: 'u-frame' };
  const chatId = 'chat-frame';
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
    await framedTemplate('frame-tool', { coverFooter: '{title} · {company}' });
    await templates.saveTemplate('plain', { name: { en: 'Plain' } }, { create: true });
  });

  after(() => shutdownStorageBootstrap());

  async function upload(bytes, name = 'old-deck.pptx') {
    const file = await repo.put(
      { type: 'chat', id: chatId },
      {
        ownerId: user.id,
        name,
        mimeType: PPTX,
        text: 'text',
        originalBuffer: bytes,
        storageMode: 'original_and_text'
      }
    );
    return file.id;
  }

  const run = params => runFramePptx({ user, chatId, appConfig: { id: 'chat' }, ...params });
  const open = result => JSZip.loadAsync(heldGeneratedFile(user, result.file.id, { chatId }).data);

  it('puts the frame on an uploaded deck and keeps its content', async () => {
    const fileId = await upload(await build());
    const result = await run({ fileId, template: 'frame-tool', coverDate: 'Heute' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.cover, true);
    assert.equal(result.file.name, 'old-deck.pptx');
    assert.equal(result.files[0].slides, 3);

    const zip = await open(result);
    const first = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.match(first, /<a:t>Vendor Briefing<\/a:t>/, "the deck's own title");
    assert.match(first, /<a:t>Heute<\/a:t>/, 'the date given');
    assert.match(first, /<a:t>Vendor Briefing · ACME GmbH<\/a:t>/, "the template's footer");
    const second = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.match(second, /<a:t>Revenue grew<\/a:t>/);
    assert.match(second, /name="Frame top"/);
  });

  it('can leave the first slide alone and name the file', async () => {
    const fileId = await upload(await build());
    const result = await run({ fileId, template: 'frame-tool', cover: false, filename: 'branded' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.file.name, 'branded.pptx');
    const first = await (await open(result)).file('ppt/slides/slide1.xml').async('string');
    assert.doesNotMatch(first, /Cover background/);
    assert.match(first, /name="Frame top"/);
  });

  it('explains when the template has no frame, and refuses files that are no decks', async () => {
    const fileId = await upload(await build());
    const none = await run({ fileId, template: 'plain' });
    assert.equal(none.success, false);
    assert.match(none.error, /No slide frame is set up/);

    const noTemplate = await run({ fileId });
    assert.equal(noTemplate.success, false);

    const text = await repo.put(
      { type: 'chat', id: chatId },
      {
        ownerId: user.id,
        name: 'notes.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        text: 'x',
        originalBuffer: Buffer.from('x'),
        storageMode: 'original_and_text'
      }
    );
    const wrong = await run({ fileId: text.id, template: 'frame-tool' });
    assert.equal(wrong.success, false);
    assert.match(wrong.error, /not a PowerPoint/);
    assert.equal((await run({ fileId: 'file_unknown', template: 'frame-tool' })).success, false);
  });
});

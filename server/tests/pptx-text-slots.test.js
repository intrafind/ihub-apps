// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text slots of slide layouts — a label above the title, an introduction under
 * it, the presenter on a title slide — and the footer strip of a title slide:
 * placeholders a template declares by name (`pptx.slots`) or names by
 * convention, the layout of a slide that has the most of the slots it fills,
 * fallbacks for layouts without them, and what the model is told about them.
 *
 * Run: node --test server/tests/pptx-text-slots.test.js
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The template store lives under CONTENTS_DIR, which the config module reads
// on import: point it at a scratch folder first.
const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-slots-'));
process.env.CONTENTS_DIR = path.join(baseDir, 'contents');
after(() => fsSync.rmSync(baseDir, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const { buildBaseTemplate } = await import('../services/documents/pptx/baseTemplate.js');
const { renderPptx } = await import('../services/documents/pptx/renderPptx.js');
const { sanitizeSlides } = await import('../services/documents/pptx/buildPptx.js');
const {
  analyzePowerpointTemplate,
  chooseLayoutForSlots,
  chooseLayouts,
  contentPlaceholders,
  layoutSlotIds,
  loadPresentationTemplate,
  slotPlaceholder
} = await import('../services/documents/pptx/pptxTemplate.js');
const { buildSlideGuide } = await import('../services/documents/pptx/slideGuide.js');
const { documentTemplateSchema } = await import('../validators/documentTemplateSchema.js');
const templates = await import('../services/documents/templates/DocumentTemplateService.js');
const { systemSkillToolsFor } = await import('../services/systemSkillTools.js');

// --- Fixtures -------------------------------------------------------------------

const INCH = 914400;
const shape = (id, name, ph, rect, text = '', size = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${rect[0]}" y="${rect[1]}"/><a:ext cx="${rect[2]}" cy="${rect[3]}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${size ? `<a:lvl1pPr><a:defRPr sz="${size}"/></a:lvl1pPr>` : ''}</a:lstStyle><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

const BOX = {
  above: [INCH, Math.round(0.05 * INCH), 11 * INCH, Math.round(0.25 * INCH)],
  below: [INCH, Math.round(1.4 * INCH), 11 * INCH, Math.round(0.7 * INCH)],
  bottom: [INCH, Math.round(6.4 * INCH), 4 * INCH, Math.round(0.3 * INCH)]
};
const KICKER = shape(
  40,
  'Kicker (Label above the title)',
  'type="body" sz="quarter" idx="13"',
  BOX.above,
  'Kicker',
  1200
);
const LEAD = shape(
  41,
  'Lead (introduction)',
  'type="body" sz="quarter" idx="14"',
  BOX.below,
  'Lead',
  1700
);

async function layoutPart(zip, name) {
  for (const file of Object.keys(zip.files)) {
    if (!/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(file)) continue;
    if ((await zip.file(file).async('string')).includes(`<p:cSld name="${name}"`)) return file;
  }
  throw new Error(`no layout ${name}`);
}

/** Add a copy of a layout of the zip, with more shapes, and register it with the master. */
async function addLayout(zip, baseName, name, shapes) {
  const source = await layoutPart(zip, baseName);
  const number = Object.keys(zip.files).filter(f => /slideLayout\d+\.xml$/.test(f)).length + 1;
  const target = `ppt/slideLayouts/slideLayout${number}.xml`;
  zip.file(
    target,
    (await zip.file(source).async('string'))
      .replace(`<p:cSld name="${baseName}"`, `<p:cSld name="${name}"`)
      .replace('</p:spTree>', `${shapes}</p:spTree>`)
  );
  zip.file(
    `ppt/slideLayouts/_rels/slideLayout${number}.xml.rels`,
    await zip.file(source.replace('slideLayouts/', 'slideLayouts/_rels/') + '.rels').async('string')
  );
  zip.file(
    '[Content_Types].xml',
    (await zip.file('[Content_Types].xml').async('string')).replace(
      '</Types>',
      `<Override PartName="/${target}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/></Types>`
    )
  );
  const relsPath = 'ppt/slideMasters/_rels/slideMaster1.xml.rels';
  const rels = await zip.file(relsPath).async('string');
  const relId = `rId${Math.max(...[...rels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]))) + 1}`;
  zip.file(
    relsPath,
    rels.replace(
      '</Relationships>',
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${number}.xml"/></Relationships>`
    )
  );
  const master = await zip.file('ppt/slideMasters/slideMaster1.xml').async('string');
  const ids = [...master.matchAll(/<p:sldLayoutId id="(\d+)"/g)].map(m => Number(m[1]));
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    master.replace(
      '</p:sldLayoutIdLst>',
      `<p:sldLayoutId id="${Math.max(...ids) + 1}" r:id="${relId}"/></p:sldLayoutIdLst>`
    )
  );
  return target.split('/').pop();
}

/** The built-in template with the given extra layouts: `[baseName, name, shapes]`. */
async function templateWith(...layouts) {
  const zip = await JSZip.loadAsync(await buildBaseTemplate({}));
  const parts = [];
  for (const [baseName, name, shapes] of layouts) {
    parts.push(await addLayout(zip, baseName, name, shapes));
  }
  return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), parts };
}

async function render(slides, template, spec = {}) {
  const { buffer, warnings } = await renderPptx(
    { title: 'Deck', language: 'en-US', slides, slideNumbers: false, brand: {}, ...spec },
    template ? { powerpointTemplate: template } : {}
  );
  const zip = await JSZip.loadAsync(buffer);
  const slideXml = [];
  const layoutOf = [];
  for (let n = 1; zip.file(`ppt/slides/slide${n}.xml`); n += 1) {
    slideXml.push(await zip.file(`ppt/slides/slide${n}.xml`).async('string'));
    const rels = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`).async('string');
    layoutOf.push(/slideLayouts\/(slideLayout\d+\.xml)/.exec(rels)[1]);
  }
  return { zip, slideXml, layoutOf, warnings };
}

const textsOf = xml => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);

// --- Detection ------------------------------------------------------------------

describe('text slots in a template', () => {
  it('are found by convention: body placeholders named like Kicker or Lead', async () => {
    const { buffer } = await templateWith([
      'Title and Content',
      'Content with slots',
      KICKER + LEAD
    ]);
    const template = await loadPresentationTemplate(buffer);
    const layout = template.layouts.find(l => l.name === 'Content with slots');
    assert.deepEqual(layoutSlotIds(layout), ['kicker', 'lead']);
    assert.equal(slotPlaceholder(layout, 'kicker').idx, '13');
    assert.equal(slotPlaceholder(layout, 'lead').text, 'Lead');
    // They do not turn a one-content layout into something else, and are no content areas.
    assert.equal(contentPlaceholders(layout).length, 1);
    const plain = template.layouts.find(l => l.name === 'Title and Content');
    assert.deepEqual(layoutSlotIds(plain), []);
    assert.equal(slotPlaceholder(plain, 'kicker'), null);
  });

  it('are found by the name a document template declares, in any language and case', async () => {
    const { buffer } = await templateWith([
      'Title and Content',
      'Contenu avec chapô',
      shape(40, 'Étiquette', 'type="body" idx="13"', BOX.above) +
        shape(41, 'CHAPÔ', 'type="body" idx="14"', BOX.below)
    ]);
    const slots = { kicker: { placeholder: 'étiquette' }, lead: { placeholder: 'Chapô' } };
    const layout = (await loadPresentationTemplate(buffer, { slots })).layouts.find(
      l => l.name === 'Contenu avec chapô'
    );
    assert.deepEqual(layoutSlotIds(layout), ['kicker', 'lead']);
    // Without the declaration the French names mean nothing.
    const undeclared = (await loadPresentationTemplate(buffer)).layouts.find(
      l => l.name === 'Contenu avec chapô'
    );
    assert.deepEqual(layoutSlotIds(undeclared), []);
    assert.equal(contentPlaceholders(undeclared).length, 3);
  });

  it('can be declared on any text placeholder, and a declaration replaces the convention', async () => {
    const { buffer } = await templateWith([
      'Title and Content',
      'Odd',
      shape(40, 'Kicker', 'type="body" idx="13"', BOX.above) +
        shape(41, 'Side note', 'idx="20"', BOX.below)
    ]);
    const slots = { note: { placeholder: 'Side note' }, kicker: { placeholder: 'Nothing' } };
    const layout = (await loadPresentationTemplate(buffer, { slots })).layouts.find(
      l => l.name === 'Odd'
    );
    // A declared slot may sit on a content-type placeholder; "kicker" now means a placeholder
    // named "Nothing", so the one named Kicker is a plain body placeholder again.
    assert.deepEqual(layoutSlotIds(layout), ['note']);
    assert.equal(contentPlaceholders(layout).length, 2);
  });

  it('are reported to the admin page with where they are and what is missing', async () => {
    const { buffer } = await templateWith([
      'Title and Content',
      'Content with slots',
      KICKER + LEAD
    ]);
    const analysis = await analyzePowerpointTemplate(buffer, undefined, {
      slots: { presenter: { placeholder: 'Presenter', description: { en: 'Who speaks.' } } }
    });
    const byId = Object.fromEntries(analysis.slots.map(s => [s.id, s]));
    assert.equal(byId.kicker.source, 'convention');
    assert.deepEqual(byId.kicker.layouts, [{ name: 'Content with slots', kind: 'content' }]);
    assert.equal(byId.lead.ifMissing, 'text');
    assert.equal(byId.presenter.source, 'config');
    assert.deepEqual(byId.presenter.layouts, []);
    const layout = analysis.layouts.find(l => l.name === 'Content with slots');
    const kicker = layout.elements.find(e => e.slot === 'kicker');
    assert.equal(kicker.role, 'slot');
    assert.equal(kicker.position, 'above-title');
    assert.equal(layout.elements.find(e => e.slot === 'lead').position, 'below-title');
    assert.deepEqual(kicker.capacity.lines, 1);
    assert.ok(kicker.capacity.chars > 50 && kicker.capacity.chars < 200);
    assert.ok(layout.elements.some(e => e.role === 'content'));
  });
});

// --- Suggestions ----------------------------------------------------------------

describe('slot suggestions from the template file', () => {
  const NOTE = shape(
    42,
    'Notiz',
    'type="body" idx="16"',
    [INCH, Math.round(6 * INCH), 4 * INCH, Math.round(0.3 * INCH)],
    'Notiz: ein kurzer Hinweis',
    1100
  );
  const FIXTURE = [
    'Title and Content',
    'Odd',
    shape(40, 'Referent/in', 'type="body" idx="13"', BOX.below, 'Name der Person', 1400) +
      shape(41, 'Chapter label (shown above)', 'type="body" idx="14"', BOX.above, '', 1200) +
      shape(43, 'Textplatzhalter 5', 'type="body" idx="15"', BOX.bottom) +
      shape(44, 'Big notes', 'type="body" idx="17"', [INCH, 2 * INCH, 6 * INCH, 3 * INCH]) +
      NOTE
  ];

  it('are named, small text placeholders: with an id, the prompt text and where they are', async () => {
    const { buffer } = await templateWith(FIXTURE);
    const { suggestedSlots } = await analyzePowerpointTemplate(buffer);
    const byId = Object.fromEntries(suggestedSlots.map(s => [s.id, s]));
    assert.deepEqual(Object.keys(byId).sort(), ['chapterLabel', 'notiz', 'referentIn']);
    assert.equal(byId.referentIn.placeholder, 'Referent/in');
    assert.equal(byId.referentIn.prompt, 'Name der Person');
    assert.equal(byId.referentIn.position, 'below-title');
    assert.equal(byId.chapterLabel.position, 'above-title');
    assert.deepEqual(byId.notiz.layouts, [{ name: 'Odd', kind: 'content' }]);
    assert.ok(byId.notiz.capacity.chars > 0);
  });

  it('leave out what is declared, what follows the convention and what is no slot', async () => {
    const { buffer } = await templateWith(FIXTURE, ['Title and Content', 'Both', KICKER + LEAD]);
    const slots = { person: { placeholder: 'referent/IN' } };
    const { suggestedSlots, slots: summary } = await analyzePowerpointTemplate(buffer, undefined, {
      slots
    });
    const names = suggestedSlots.map(s => s.placeholder).sort();
    assert.deepEqual(names, ['Chapter label (shown above)', 'Notiz']);
    // Kicker and lead are slots already; a suggested id never clashes with a slot id.
    assert.deepEqual(summary.map(s => s.id).sort(), ['kicker', 'lead', 'person']);
  });

  it('do not take the subtitle of a title or section slide, and make ids unique', async () => {
    const { buffer } = await templateWith(
      [
        'Section Header',
        'Section with note',
        shape(40, 'Notiz', 'type="body" idx="20"', BOX.bottom, 'Hinweis', 1100)
      ],
      ['Title and Content', 'Second', shape(41, 'Notiz!', 'type="body" idx="21"', BOX.bottom)]
    );
    const { suggestedSlots } = await analyzePowerpointTemplate(buffer);
    // The section layout's own body placeholder is its subtitle (and is named by default anyway).
    assert.deepEqual(suggestedSlots.map(s => s.id).sort(), ['notiz', 'notiz2']);
  });

  it('turn names into ids: accents, capitals and separators', async () => {
    const names = ['Überschrift-Zeile', 'ABT. Name', '2nd line', 'Étiquette (Label)'];
    const { buffer } = await templateWith([
      'Title and Content',
      'Names',
      names.map((n, i) => shape(40 + i, n, `type="body" idx="${30 + i}"`, BOX.bottom)).join('')
    ]);
    const { suggestedSlots } = await analyzePowerpointTemplate(buffer);
    assert.deepEqual(suggestedSlots.map(s => s.id).sort(), [
      'abtName',
      'etiquette',
      'slot2ndLine',
      'uberschriftZeile'
    ]);
  });
});

// --- Choosing the layout --------------------------------------------------------

describe('the layout of a slide with text slots', () => {
  it('has the most of the slots the slide fills, then the fewest others', async () => {
    const { buffer, parts } = await templateWith(
      ['Title and Content', 'Kicker only', KICKER],
      ['Title and Content', 'Kicker and lead', KICKER + LEAD]
    );
    const { layouts } = await loadPresentationTemplate(buffer);
    const base = chooseLayouts(layouts).content;
    assert.equal(base.name, 'Title and Content');
    const pick = ids => chooseLayoutForSlots(layouts, 'content', base, ids).name;
    assert.equal(pick([]), 'Title and Content');
    assert.equal(pick(['kicker']), 'Kicker only');
    assert.equal(pick(['lead']), 'Kicker and lead');
    assert.equal(pick(['kicker', 'lead']), 'Kicker and lead');
    // No layout of the kind has the slot: the slide keeps its layout.
    assert.equal(pick(['presenter']), 'Title and Content');
    assert.equal(parts.length, 2);
  });

  it('is used when the slide fills the slots, and only then', async () => {
    const { buffer, parts } = await templateWith(
      ['Title and Content', 'Kicker only', KICKER],
      ['Title and Content', 'Kicker and lead', KICKER + LEAD]
    );
    const { slideXml, layoutOf, warnings } = await render(
      [
        { title: 'Plain', text: '- One' },
        { title: 'Label', slots: { kicker: 'Vision 2027' }, text: '- Two' },
        {
          title: 'Both',
          slots: { kicker: 'Search & Find', lead: 'We grow into a **platform**.' },
          text: '- Three'
        }
      ],
      buffer
    );
    assert.deepEqual(warnings, []);
    assert.equal(layoutOf[0] === parts[0] || layoutOf[0] === parts[1], false);
    assert.equal(layoutOf[1], parts[0]);
    assert.equal(layoutOf[2], parts[1]);
    // The slot's text is in a placeholder that points at the layout's placeholder, with its name.
    assert.match(
      slideXml[2],
      /name="Kicker \(Label above the title\)"[^]*<p:ph type="body" idx="13"\/>[^]*<a:t>Search &amp; Find<\/a:t>/
    );
    assert.match(slideXml[2], /name="Lead \(introduction\)"[^]*<p:ph type="body" idx="14"\/>/);
    // Inline Markdown works; the text is a paragraph without a bullet.
    assert.match(slideXml[2], /b="1"[^>]*>[^]*<a:t>platform<\/a:t>/);
    assert.match(slideXml[2], /<a:buNone\/><\/a:pPr>[^]*We grow/);
    assert.equal(textsOf(slideXml[2]).filter(t => t === 'Three').length, 1);
  });

  it('is the layout an admin chose for the kind, when that has the slots', async () => {
    const { buffer, parts } = await templateWith(['Title and Content', 'Both', KICKER + LEAD]);
    const { layoutOf } = await render(
      [
        { title: 'T', slots: { kicker: 'K' }, text: '- x' },
        { title: 'No slots', text: '- y' }
      ],
      buffer,
      { slotConfig: undefined, layouts: { content: 'Both' } }
    );
    assert.deepEqual(layoutOf, [parts[0], parts[0]]);
  });

  it('fits a one-line label and a two-line lead into their small boxes without shrinking', async () => {
    const { buffer } = await templateWith(['Title and Content', 'Both', KICKER + LEAD]);
    const { slideXml, warnings } = await render(
      [
        {
          title: 'A title',
          slots: {
            kicker: 'Search & Find',
            lead: 'A sentence that is a little longer than a line, as leads in a strategy deck often are, but not by much.'
          },
          text: '- x'
        }
      ],
      buffer
    );
    assert.deepEqual(warnings, []);
    assert.doesNotMatch(slideXml[0], /fontScale/);
  });

  it('uses a slot declared by the document template, also on a title slide', async () => {
    const { buffer, parts } = await templateWith([
      'Title Slide',
      'Title with presenter',
      shape(40, 'Referent', 'type="body" idx="15"', BOX.bottom, 'Name', 1400)
    ]);
    const slotConfig = { presenter: { placeholder: 'Referent' } };
    const { slideXml, layoutOf, warnings } = await render(
      [{ layout: 'title', title: 'Deck', slots: { presenter: 'Daniel Manzke' } }],
      buffer,
      { slotConfig }
    );
    assert.deepEqual(warnings, []);
    assert.equal(layoutOf[0], parts[0]);
    assert.match(slideXml[0], /<p:ph type="body" idx="15"\/>[^]*<a:t>Daniel Manzke<\/a:t>/);
  });
});

// --- Fallbacks ------------------------------------------------------------------

describe("slots a slide's layout does not have", () => {
  it('are left out, or become the first paragraph of the text, as the slot says', async () => {
    const { slideXml, warnings } = await render([
      {
        title: 'T',
        slots: { kicker: 'Vision 2027', lead: 'The lead sentence.' },
        text: '- One\n- Two'
      },
      {
        layout: 'two-column',
        title: 'Two',
        slots: { lead: 'Lead for columns.' },
        left: { text: '- A' },
        right: { text: '- B' }
      },
      { layout: 'title-only', title: 'Only', slots: { lead: 'No place for it.' } },
      { layout: 'title', title: 'Deck', slots: { lead: 'Becomes the subtitle' } }
    ]);
    assert.deepEqual(warnings, []);
    assert.doesNotMatch(slideXml[0], /Vision 2027/);
    const texts = textsOf(slideXml[0]);
    assert.deepEqual(texts.slice(texts.indexOf('T'), texts.indexOf('T') + 4), [
      'T',
      'The lead sentence.',
      'One',
      'Two'
    ]);
    assert.match(slideXml[1], /<a:t>Lead for columns\.<\/a:t>[^]*<a:t>A<\/a:t>/);
    assert.doesNotMatch(slideXml[2], /No place for it/);
    assert.match(slideXml[3], /<a:t>Becomes the subtitle<\/a:t>/);
  });

  it("follow `ifMissing` of the template's declaration", async () => {
    const slotConfig = {
      kicker: { placeholder: 'Kicker', ifMissing: 'text' },
      lead: { placeholder: 'Lead', ifMissing: 'drop' },
      note: { placeholder: 'Note', ifMissing: 'text' }
    };
    const { slideXml, warnings } = await render(
      [{ title: 'T', slots: { kicker: 'K', lead: 'L', note: 'N' }, text: 'Body' }],
      undefined,
      { slotConfig }
    );
    assert.deepEqual(warnings, []);
    const texts = textsOf(slideXml[0]);
    assert.deepEqual(texts.slice(texts.indexOf('T'), texts.indexOf('T') + 4), [
      'T',
      'K',
      'N',
      'Body'
    ]);
    assert.doesNotMatch(slideXml[0], /<a:t>L<\/a:t>/);
  });

  it("warn, with the ids there are, when a slot id is not one of the template's", async () => {
    const { buffer } = await templateWith(['Title and Content', 'Both', KICKER + LEAD]);
    const { warnings } = await render(
      [
        { title: 'T', slots: { kicker: 'K', chapter: 'C' }, text: '- x' },
        { layout: 'blank', slots: { kicker: 'not on a blank slide' } }
      ],
      buffer
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Slide 1: the template has no slot "chapter".*kicker, lead/);
  });
});

// --- The footer strip of a title slide ------------------------------------------

const strip = (text, name = 'Footer Placeholder') =>
  shape(42, name, 'type="ftr" sz="quarter" idx="11"', [7 * INCH, 7 * INCH, 4 * INCH, 274320], text);

async function templateWithTitleStrip(defaultText) {
  const zip = await JSZip.loadAsync(await buildBaseTemplate({}));
  const file = await layoutPart(zip, 'Title Slide');
  zip.file(
    file,
    (await zip.file(file).async('string')).replace(
      '</p:spTree>',
      `${strip(defaultText)}</p:spTree>`
    )
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('the footer strip of a title slide', () => {
  it('shows the slide footer, else the text the layout has in its footer placeholder', async () => {
    const template = await templateWithTitleStrip('IntraFind Software AG');
    const { slideXml } = await render(
      [
        { layout: 'title', title: 'One', footer: 'Strategy 2027 · November 2026' },
        { layout: 'title', title: 'Two' }
      ],
      template,
      { footer: 'Deck footer' }
    );
    assert.match(
      slideXml[0],
      /<p:ph type="ftr" idx="11"\/>[^]*<a:t>Strategy 2027 · November 2026<\/a:t>/
    );
    assert.match(slideXml[1], /<p:ph type="ftr" idx="11"\/>[^]*<a:t>IntraFind Software AG<\/a:t>/);
    // The deck's footer is for the other slides, not the title slide.
    assert.doesNotMatch(slideXml[0] + slideXml[1], /Deck footer/);
  });

  it('is left alone when the layout has no footer placeholder or no text for it', async () => {
    const { slideXml } = await render([{ layout: 'title', title: 'One' }]);
    assert.doesNotMatch(slideXml[0], /type="ftr"/);
    const empty = await templateWithTitleStrip('');
    const withoutText = await render([{ layout: 'title', title: 'One' }], empty);
    assert.doesNotMatch(withoutText.slideXml[0], /type="ftr"/);
    const withFooter = await render([{ layout: 'title', title: 'One', footer: 'Own text' }], empty);
    assert.match(withFooter.slideXml[0], /<a:t>Own text<\/a:t>/);
  });

  it('can be set on any other slide, in place of the deck footer', async () => {
    const { slideXml } = await render(
      [
        { title: 'A', text: '- x', footer: 'Only here' },
        { title: 'B', text: '- y' }
      ],
      undefined,
      { footer: 'Deck footer' }
    );
    assert.match(slideXml[0], /<a:t>Only here<\/a:t>/);
    assert.doesNotMatch(slideXml[0], /Deck footer/);
    assert.match(slideXml[1], /<a:t>Deck footer<\/a:t>/);
  });
});

// --- Slides from the model ------------------------------------------------------

describe('sanitizing slots and footer', () => {
  it('keeps valid slot ids with text, limits their length and the footer', () => {
    const [slide, other, third] = sanitizeSlides(
      [
        {
          title: 'x',
          slots: { kicker: 'k'.repeat(900), 'Bad id': 'no', empty: '  ', lead: 'ok', n: 5 },
          footer: 'f'.repeat(900)
        },
        { title: 'y', slots: 'kicker' },
        { title: 'z', slots: ['kicker'] }
      ],
      { warnings: [], imageBytes: 0 }
    );
    assert.deepEqual(Object.keys(slide.slots), ['kicker', 'lead']);
    assert.equal(slide.slots.kicker.length, 300);
    assert.equal(slide.footer.length, 200);
    assert.deepEqual(other.slots, {});
    assert.deepEqual(third.slots, {});
  });

  it('takes at most twelve slots', () => {
    const slots = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, 'text']));
    const [slide] = sanitizeSlides([{ title: 't', slots }], { warnings: [], imageBytes: 0 });
    assert.equal(Object.keys(slide.slots).length, 12);
  });
});

describe('declaring slots in a document template', () => {
  const base = { id: 'acme', name: { en: 'ACME' } };
  it('accepts a placeholder name, a description per language and what to do without it', () => {
    const parsed = documentTemplateSchema.parse({
      ...base,
      pptx: {
        slots: {
          chapter: {
            placeholder: 'Kapitel',
            description: { en: 'The chapter.', de: 'Das Kapitel.' },
            ifMissing: 'drop'
          }
        }
      }
    });
    assert.equal(parsed.pptx.slots.chapter.placeholder, 'Kapitel');
  });

  it('refuses odd ids, unknown settings, an empty name and too many slots', () => {
    const parse = slots => documentTemplateSchema.safeParse({ ...base, pptx: { slots } }).success;
    assert.equal(parse({ 'Bad id': { placeholder: 'x' } }), false);
    assert.equal(parse({ a: { placeholder: 'x', ifMissing: 'later' } }), false);
    assert.equal(parse({ a: { placeholder: 'x', other: 1 } }), false);
    assert.equal(parse({ a: { placeholder: ' ' } }), false);
    assert.equal(parse({ a: { placeholder: 'x', description: { en: 'y'.repeat(201) } } }), false);
    const many = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`s${i}`, { placeholder: 'x' }])
    );
    assert.equal(parse(many), false);
  });
});

// --- What the model is told -----------------------------------------------------

describe('the slide guide for the model', () => {
  async function guideFor(extraLayouts, options = {}, slots) {
    const { buffer } = await templateWith(...extraLayouts);
    const analysis = await analyzePowerpointTemplate(buffer, undefined, { slots });
    return buildSlideGuide(analysis, options);
  }

  it('lists the slots with where they are, how much fits and what happens without them', async () => {
    const guide = await guideFor([['Title and Content', 'Both', KICKER + LEAD]]);
    assert.match(guide, /"slots"/);
    assert.match(
      guide,
      /- "kicker": [^\n]*Above the title\. Fits one line, about \d+ characters\. Left out/
    );
    assert.match(guide, /- "lead": [^\n]*Below the title\. Fits 2 lines[^\n]*first paragraph/);
    assert.match(
      guide,
      /- content: title; text, table, chart or picture area \(\d+(\.\d)? × \d+(\.\d)? in\); slot "kicker" \(above the title\); slot "lead" \(below the title\)/
    );
    assert.doesNotMatch(guide, /Other templates/);
  });

  it("uses the admin's descriptions, in the language asked for, and says what a title slide has", async () => {
    const slots = {
      presenter: {
        placeholder: 'Referent',
        description: { en: 'Who presents.', de: 'Wer vorträgt.' }
      }
    };
    const extra = [
      [
        'Title Slide',
        'Title with presenter',
        shape(40, 'Referent', 'type="body" idx="15"', BOX.bottom, 'Name', 1400) + strip('ACME AG')
      ]
    ];
    const en = await guideFor(extra, { others: true }, slots);
    assert.match(en, /- "presenter": Who presents\. At the bottom left\./);
    assert.match(
      en,
      /- title: title; subtitle; slot "presenter" \(at the bottom left\); footer strip text \(slide field "footer"; "ACME AG" if unset\)/
    );
    assert.match(en, /Other templates can differ\.$/);
    const german = await guideFor(extra, { language: 'de' }, slots);
    assert.match(german, /- "presenter": Wer vorträgt\. Unten links\./);
    assert.match(german, /Folientypen \("layout"\)/);
  });

  it('describes the slide types even when the template has no slots, and nothing without layouts', async () => {
    const { buffer } = await templateWith();
    const guide = buildSlideGuide(await analyzePowerpointTemplate(buffer), {});
    assert.doesNotMatch(guide, /"slots"/);
    assert.match(guide, /^Slide types \("layout"\) and what each has:\n- title: title; subtitle/);
    assert.match(guide, /- two-column: title; 2 content areas side by side/);
    assert.match(guide, /- section: title; subtitle\n/);
    assert.equal(buildSlideGuide({ layouts: [] }), '');
    assert.equal(buildSlideGuide(null), '');
  });
});

describe('the slide guide in the tool description', () => {
  async function storeTemplate(id, buffer, extra = {}) {
    templates.clearTemplateCaches();
    await templates.deleteTemplate(id).catch(() => {});
    await templates.saveTemplate(
      id,
      { name: { en: id }, default: true, ...extra },
      { create: true }
    );
    await templates.saveTemplateAsset(id, {
      slot: 'powerpointTemplate',
      data: buffer,
      originalName: 'deck.potx'
    });
  }

  const skills = [{ name: 'pptx', isSystem: true, providedTools: ['create_pptx'] }];
  const descriptionOf = async (app, language = 'en') => {
    const context = await templates.documentTemplateContext({ app, language });
    return systemSkillToolsFor(skills, { language, templates: context }).find(
      t => t.id === 'create_pptx'
    ).description;
  };

  it('tells the model the slots of the pinned or default template, from the stored file', async () => {
    const { buffer } = await templateWith(['Title and Content', 'Both', KICKER + LEAD]);
    await storeTemplate('acme', buffer, {
      pptx: {
        slots: {
          kicker: {
            placeholder: 'Kicker (Label above the title)',
            description: { en: 'The ACME chapter.' }
          }
        }
      }
    });
    const description = await descriptionOf({});
    assert.match(description, /Create a PowerPoint presentation/);
    assert.match(description, /- "kicker": The ACME chapter\. Above the title\./);
    assert.match(description, /- "lead": One sentence under the title/);
    assert.match(description, /- content: title;/);
    // The guide follows the language, and a pinned template does not offer others.
    assert.match(await descriptionOf({ documentTemplate: 'acme' }, 'de'), /Folientypen/);
    assert.doesNotMatch(
      await descriptionOf({ documentTemplate: 'acme' }),
      /Other templates can differ/
    );
  });

  it("follows a change of the template's slots and says nothing without a PowerPoint file", async () => {
    const { buffer } = await templateWith(['Title and Content', 'Both', KICKER + LEAD]);
    await storeTemplate('acme', buffer);
    assert.match(await descriptionOf({}), /"lead"/);
    await templates.saveTemplate('acme', {
      name: { en: 'acme' },
      default: true,
      pptx: { template: 'powerpoint-template.potx', slots: { lead: { placeholder: 'Nothing' } } }
    });
    const changed = await descriptionOf({});
    assert.doesNotMatch(changed, /- "lead": One sentence/);
    await templates.removeTemplateAsset('acme', { slot: 'powerpointTemplate' });
    const without = await descriptionOf({});
    assert.doesNotMatch(without, /Slide types/);
    assert.match(without, /Create a PowerPoint presentation/);
  });
});

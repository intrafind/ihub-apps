// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Kicker and lead of a slide, and the title slide's footer strip: placeholders
 * of a template's layouts told apart by their name, a layout of their own for
 * the slides that have them, and fallbacks for templates without them.
 *
 * Run: node --test server/tests/pptx-text-slots.test.js
 */
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const { buildBaseTemplate } = await import('../services/documents/pptx/baseTemplate.js');
const { renderPptx } = await import('../services/documents/pptx/renderPptx.js');
const { sanitizeSlides } = await import('../services/documents/pptx/buildPptx.js');
const {
  analyzePowerpointTemplate,
  chooseLayouts,
  chooseTextSlotLayouts,
  contentPlaceholders,
  kickerPlaceholder,
  leadPlaceholder,
  loadPresentationTemplate
} = await import('../services/documents/pptx/pptxTemplate.js');

// --- Fixtures -------------------------------------------------------------------

const INCH = 914400;
const shape = (id, name, ph, rect, text = '', size = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${rect[0]}" y="${rect[1]}"/><a:ext cx="${rect[2]}" cy="${rect[3]}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${size ? `<a:lvl1pPr><a:defRPr sz="${size}"/></a:lvl1pPr>` : ''}</a:lstStyle><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

const KICKER = shape(
  40,
  'Kicker (Label above the title)',
  'type="body" sz="quarter" idx="13"',
  [INCH, Math.round(0.5 * INCH), 11 * INCH, Math.round(0.3 * INCH)],
  'Kicker',
  1200
);
const LEAD = shape(
  41,
  'Lead (introduction)',
  'type="body" sz="quarter" idx="14"',
  [INCH, Math.round(1.4 * INCH), 11 * INCH, Math.round(0.7 * INCH)],
  'Lead',
  1700
);

async function partOfLayout(zip, name) {
  for (const file of Object.keys(zip.files)) {
    if (!/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(file)) continue;
    if ((await zip.file(file).async('string')).includes(`<p:cSld name="${name}"`)) return file;
  }
  throw new Error(`no layout ${name}`);
}

/** The built-in template with one more layout: Title and Content with a kicker and a lead. */
async function templateWithLeadLayout() {
  const zip = await JSZip.loadAsync(await buildBaseTemplate({}));
  const source = await partOfLayout(zip, 'Title and Content');
  const number = Object.keys(zip.files).filter(f => /slideLayout\d+\.xml$/.test(f)).length + 1;
  const target = `ppt/slideLayouts/slideLayout${number}.xml`;
  const xml = (await zip.file(source).async('string'))
    .replace('<p:cSld name="Title and Content"', '<p:cSld name="Title, Lead and Content"')
    .replace('</p:spTree>', `${KICKER}${LEAD}</p:spTree>`);
  zip.file(target, xml);
  zip.file(
    `ppt/slideLayouts/_rels/slideLayout${number}.xml.rels`,
    await zip.file(source.replace('slideLayouts/', 'slideLayouts/_rels/') + '.rels').async('string')
  );
  const types = await zip.file('[Content_Types].xml').async('string');
  zip.file(
    '[Content_Types].xml',
    types.replace(
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
  return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), target };
}

/** The base template whose title layout has a footer placeholder with a default text. */
async function templateWithTitleStrip(defaultText) {
  const zip = await JSZip.loadAsync(await buildBaseTemplate({}));
  const file = await partOfLayout(zip, 'Title Slide');
  const strip = shape(
    42,
    'Footer Placeholder',
    'type="ftr" sz="quarter" idx="11"',
    [7 * INCH, 7 * INCH, 4 * INCH, Math.round(0.3 * INCH)],
    defaultText
  );
  zip.file(
    file,
    (await zip.file(file).async('string')).replace('</p:spTree>', `${strip}</p:spTree>`)
  );
  return zip.generateAsync({ type: 'nodebuffer' });
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

// --- Tests ----------------------------------------------------------------------

describe('kicker and lead placeholders in a template', () => {
  it('are body placeholders told apart by name and are not content areas', async () => {
    const { buffer } = await templateWithLeadLayout();
    const template = await loadPresentationTemplate(buffer);
    const variant = template.layouts.find(l => l.name === 'Title, Lead and Content');
    assert.equal(kickerPlaceholder(variant).idx, '13');
    assert.equal(leadPlaceholder(variant).idx, '14');
    assert.equal(kickerPlaceholder(variant).text, 'Kicker');
    // Still a one-content layout: the kicker and lead do not turn it into something else.
    assert.equal(contentPlaceholders(variant).length, 1);
    const plain = template.layouts.find(l => l.name === 'Title and Content');
    assert.equal(kickerPlaceholder(plain), null);
    assert.equal(leadPlaceholder(plain), null);
  });

  it('keep the plain layout for ordinary slides and serve slides with a kicker or lead', async () => {
    const { buffer } = await templateWithLeadLayout();
    const template = await loadPresentationTemplate(buffer);
    assert.equal(chooseLayouts(template.layouts).content.name, 'Title and Content');
    assert.equal(chooseTextSlotLayouts(template.layouts).content.name, 'Title, Lead and Content');
    assert.deepEqual(Object.keys(chooseTextSlotLayouts(template.layouts)), ['content']);
    const analysis = await analyzePowerpointTemplate(buffer);
    assert.deepEqual(analysis.textSlotLayouts, { content: 'Title, Lead and Content' });
    assert.deepEqual(
      (await analyzePowerpointTemplate(await buildBaseTemplate({}))).textSlotLayouts,
      {}
    );
  });
});

describe('slides with a kicker and a lead', () => {
  it('go on the layout that has the placeholders and fill them', async () => {
    const { buffer, target } = await templateWithLeadLayout();
    const { slideXml, layoutOf, warnings } = await render(
      [
        { title: 'Plain', text: '- One' },
        {
          kicker: 'Vision 2027',
          title: 'From search to act',
          lead: 'We grow from a search vendor into a **platform**.',
          text: '- Two'
        },
        { title: 'Plain again', text: '- Three' }
      ],
      buffer
    );
    assert.deepEqual(warnings, []);
    const variant = target.split('/').pop();
    assert.deepEqual(
      layoutOf.map(l => l === variant),
      [false, true, false]
    );
    const slide = slideXml[1];
    assert.match(
      slide,
      /name="Kicker"[^]*<p:ph type="body" idx="13"\/>[^]*<a:t>Vision 2027<\/a:t>/
    );
    assert.match(
      slide,
      /name="Lead"[^]*<p:ph type="body" idx="14"\/>[^]*We grow from a search vendor/
    );
    // The lead is a paragraph without a bullet; its bold run stays bold.
    assert.match(slide, /<a:buNone\/><\/a:pPr>[^]*We grow/);
    assert.match(slide, /b="1"[^>]*>[^]*<a:t>platform<\/a:t>/);
    // The text is in the content placeholder, once.
    assert.equal(slide.match(/<a:t>Two<\/a:t>/g).length, 1);
    assert.doesNotMatch(slideXml[0], /Kicker|Lead/);
  });

  it('do not shrink a one-line kicker or a two-line lead in their small boxes', async () => {
    const { buffer } = await templateWithLeadLayout();
    const { slideXml, warnings } = await render(
      [
        {
          kicker: 'Search & Find',
          title: 'A title',
          lead: 'A sentence that is a little longer than a line, as leads in a strategy deck often are, but not by much.',
          text: '- x'
        }
      ],
      buffer
    );
    assert.deepEqual(warnings, []);
    assert.doesNotMatch(slideXml[0], /fontScale/);
  });

  it('use the plain layout when an admin chose a layout with these placeholders for content', async () => {
    const { buffer, target } = await templateWithLeadLayout();
    const { layoutOf } = await render(
      [
        { kicker: 'K', title: 'T', text: '- x' },
        { title: 'No kicker', text: '- y' }
      ],
      buffer,
      { layouts: { content: 'Title, Lead and Content' } }
    );
    assert.deepEqual(layoutOf, [target.split('/').pop(), target.split('/').pop()]);
  });

  it('leave the kicker out and make the lead the first paragraph in a template without them', async () => {
    const { slideXml, warnings } = await render([
      { kicker: 'Vision 2027', title: 'T', lead: 'The lead sentence.', text: '- One\n- Two' },
      {
        layout: 'two-column',
        title: 'Two',
        lead: 'Lead for columns.',
        left: { text: '- A' },
        right: { text: '- B' }
      },
      { layout: 'title-only', title: 'Only', lead: 'No place for it.' },
      { layout: 'title', title: 'Deck', lead: 'Becomes the subtitle' }
    ]);
    assert.deepEqual(warnings, []);
    assert.doesNotMatch(slideXml[0], /Vision 2027/);
    const paragraphs = [...slideXml[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
    assert.deepEqual(paragraphs.slice(paragraphs.indexOf('T'), paragraphs.indexOf('T') + 4), [
      'T',
      'The lead sentence.',
      'One',
      'Two'
    ]);
    assert.match(slideXml[1], /<a:t>Lead for columns\.<\/a:t>[^]*<a:t>A<\/a:t>/);
    assert.doesNotMatch(slideXml[2], /No place for it/);
    assert.match(slideXml[3], /<a:t>Becomes the subtitle<\/a:t>/);
  });
});

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

describe('sanitizing kicker, lead and footer', () => {
  it('limits their length and ignores other types', () => {
    const [slide, other] = sanitizeSlides(
      [
        { title: 'x', kicker: 'k'.repeat(200), lead: 'l'.repeat(900), footer: 'f'.repeat(900) },
        { title: 'y', kicker: 5, lead: { a: 1 } }
      ],
      { warnings: [], imageBytes: 0 }
    );
    assert.equal(slide.kicker.length, 80);
    assert.equal(slide.lead.length, 300);
    assert.equal(slide.footer.length, 200);
    assert.equal(other.kicker, '');
    assert.equal(other.lead, '');
  });
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The brand of a document template: colours, palette and fonts read from the
 * themes of its Word and PowerPoint files, the order in which the template's
 * own values, the PowerPoint theme, the Word theme and the neutral default
 * count, PDF margins from the Word template, and the new `fields` and
 * `pdf.margins` settings of the template schema.
 *
 * Run: node --test server/tests/template-brand.test.js
 */

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-template-brand-'));
process.env.CONTENTS_DIR = path.join(baseDir, 'contents');

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const { documentTemplateSchema, BUILT_IN_PLACEHOLDERS, MAX_TEMPLATE_FIELDS } =
  await import('../validators/documentTemplateSchema.js');
const templates = await import('../services/documents/templates/DocumentTemplateService.js');
const {
  brandFromTheme,
  readThemeBrand,
  resolveBrand,
  specifiedBrand,
  pdfMarginsFromWordSetup,
  pdfPageFromWordSetup
} = await import('../services/documents/templates/themeBrand.js');
const { applyTemplateToDocxSpec, applyTemplateToPdfSpec, applyTemplateToXlsxSpec } =
  await import('../services/documents/templates/applyTemplate.js');
const { buildBaseTemplate, themeXml } = await import('../services/documents/pptx/baseTemplate.js');

after(() => fsSync.rmSync(baseDir, { recursive: true, force: true }));

// --- Fixtures -------------------------------------------------------------------

/**
 * Theme colours as `themeXml` takes them: accents 1 and 2, then four more.
 * Text is `dk1`.
 */
function themeOptions(
  accents,
  { text = '1F2937', major = 'Brand Serif', minor = 'Brand Sans' } = {}
) {
  const [primary, accent, ...palette] = accents;
  return {
    name: 'Test',
    colors: { text, dark2: text, primary, accent, palette },
    majorFont: major,
    minorFont: minor
  };
}

/** A PowerPoint template whose theme has the given accents. */
async function pptxWithAccents(accents, options) {
  const zip = await JSZip.loadAsync(await buildBaseTemplate({}));
  zip.file('ppt/theme/theme1.xml', themeXml(themeOptions(accents, options)));
  return zip.generateAsync({ type: 'nodebuffer' });
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * A minimal Word template: one section with the given margins (twips), and a
 * theme with the given accents unless `accents` is null.
 */
async function wordTemplate(accents, { margins, options, page } = {}) {
  const m = { top: 1440, right: 1134, bottom: 1134, left: 1701, ...margins };
  const size = { w: 11906, h: 16838, ...page };
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${accents ? '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : ''}</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body><w:p/><w:sectPr><w:pgSz w:w="${size.w}" w:h="${size.h}"${size.orient ? ` w:orient="${size.orient}"` : ''}/><w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  );
  if (accents) {
    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/theme" Target="theme/theme1.xml"/></Relationships>`
    );
    zip.file('word/theme/theme1.xml', themeXml(themeOptions(accents, options)));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const RED = 'E30613';
const SLATE = '374151';
const BLUE = '1D4ED8';
const GREEN = '15803D';
const AMBER = 'F59E0B';
const GREY1 = '7F7F7F';
const GREY2 = 'A6A6A6';

// --- Reading a theme ------------------------------------------------------------

describe('brandFromTheme', () => {
  it('takes the primary colour from the first accent that is a real colour', () => {
    const brand = brandFromTheme({
      colors: {
        accent1: GREY1,
        accent2: RED,
        accent3: BLUE,
        accent4: GREEN,
        accent5: AMBER,
        accent6: GREY2
      }
    });
    assert.equal(brand.primaryColor, `#${RED}`);
  });

  it('takes the accent from the next accent that clearly differs, a grey included', () => {
    const brand = brandFromTheme({ colors: { accent1: RED, accent2: SLATE, accent3: BLUE } });
    assert.equal(brand.primaryColor, `#${RED}`);
    assert.equal(brand.accentColor, `#${SLATE}`);
  });

  it('skips an accent that is almost the primary colour', () => {
    const brand = brandFromTheme({ colors: { accent1: RED, accent2: 'E5101C', accent3: BLUE } });
    assert.equal(brand.accentColor, `#${BLUE}`);
  });

  it('goes round to the accents before the primary colour when none after it differs', () => {
    const brand = brandFromTheme({ colors: { accent1: GREY1, accent2: RED, accent3: 'E5101C' } });
    assert.equal(brand.primaryColor, `#${RED}`);
    assert.equal(brand.accentColor, `#${GREY1}`);
  });

  it('puts the colours first in the palette and the greys last, at most six', () => {
    const brand = brandFromTheme({
      colors: {
        accent1: GREY1,
        accent2: RED,
        accent3: BLUE,
        accent4: GREY2,
        accent5: GREEN,
        accent6: AMBER
      }
    });
    assert.deepEqual(
      brand.palette,
      [RED, BLUE, GREEN, AMBER, GREY1, GREY2].map(c => `#${c}`)
    );
  });

  it('gives no primary, accent or palette to a theme of greys, but its text colour and fonts', () => {
    const brand = brandFromTheme({
      colors: { dk1: '000000', accent1: GREY1, accent2: GREY2 },
      fonts: { major: 'Arial', minor: 'Calibri' }
    });
    assert.equal(brand.primaryColor, undefined);
    assert.equal(brand.accentColor, undefined);
    assert.equal(brand.palette, undefined);
    assert.equal(brand.textColor, '#000000');
    assert.equal(brand.headingFont, 'Arial');
    assert.equal(brand.bodyFont, 'Calibri');
  });

  it('ignores values that are not colours', () => {
    const brand = brandFromTheme({ colors: { accent1: 'red', accent2: BLUE, dk1: 'zzz' } });
    assert.equal(brand.primaryColor, `#${BLUE}`);
    assert.equal(brand.textColor, undefined);
  });
});

describe('readThemeBrand', () => {
  it('reads the colours, text colour and fonts of a PowerPoint template', async () => {
    const buffer = await pptxWithAccents([RED, SLATE, BLUE, GREEN, AMBER, GREY1], {
      text: '111827'
    });
    const brand = await readThemeBrand(buffer, 'pptx');
    assert.equal(brand.primaryColor, `#${RED}`);
    assert.equal(brand.accentColor, `#${SLATE}`);
    assert.equal(brand.textColor, '#111827');
    assert.equal(brand.headingFont, 'Brand Serif');
    assert.equal(brand.bodyFont, 'Brand Sans');
    assert.equal(brand.palette.length, 6);
  });

  it('reads the brand iHub builds a PowerPoint template from', async () => {
    const buffer = await buildBaseTemplate({
      primaryColor: `#${RED}`,
      accentColor: `#${SLATE}`,
      textColor: '#111827',
      headingFont: 'Brand Serif',
      bodyFont: 'Brand Sans'
    });
    const brand = await readThemeBrand(buffer, 'pptx');
    assert.equal(brand.primaryColor, `#${RED}`);
    assert.equal(brand.accentColor, `#${SLATE}`);
    assert.equal(brand.textColor, '#111827');
    assert.equal(brand.headingFont, 'Brand Serif');
  });

  it('reads the theme of a Word template', async () => {
    const brand = await readThemeBrand(
      await wordTemplate([BLUE, AMBER, GREEN, RED, SLATE, GREY1]),
      'docx'
    );
    assert.equal(brand.primaryColor, `#${BLUE}`);
    assert.equal(brand.accentColor, `#${AMBER}`);
  });

  it('reads a theme that names its text colour as a system colour', async () => {
    const zip = await JSZip.loadAsync(await wordTemplate([BLUE, AMBER, GREEN, RED, SLATE, GREY1]));
    const theme = await zip.file('word/theme/theme1.xml').async('string');
    zip.file(
      'word/theme/theme1.xml',
      theme.replace(
        /<a:dk1>.*?<\/a:dk1>/,
        '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
      )
    );
    const brand = await readThemeBrand(await zip.generateAsync({ type: 'nodebuffer' }), 'docx');
    assert.equal(brand.textColor, '#000000');
  });

  it('gives null for a file without a theme', async () => {
    assert.equal(await readThemeBrand(await wordTemplate(null), 'docx'), null);
  });

  it('refuses a file that is not an Office document', async () => {
    await assert.rejects(readThemeBrand(Buffer.from('not a zip'), 'docx'), /not a valid Office/);
  });
});

// --- Which source counts --------------------------------------------------------

describe('resolveBrand', () => {
  const powerpoint = {
    source: 'powerpoint',
    brand: brandFromTheme({ colors: { dk1: '111111', accent1: RED, accent2: SLATE } })
  };
  const word = {
    source: 'word',
    brand: brandFromTheme({
      colors: { dk1: '222222', accent1: BLUE, accent2: AMBER },
      fonts: { major: 'Georgia' }
    })
  };

  it("takes the template's own colours first", () => {
    const brand = resolveBrand({ brand: { primaryColor: '#00FF00' }, themes: [powerpoint, word] });
    assert.equal(brand.primaryColor, '#00FF00');
    assert.equal(brand.sources.primaryColor, 'template');
    assert.equal(brand.accentColor, `#${SLATE}`);
    assert.equal(brand.sources.accentColor, 'powerpoint');
  });

  it('takes the PowerPoint theme before the Word theme', () => {
    const brand = resolveBrand({ themes: [powerpoint, word] });
    assert.equal(brand.primaryColor, `#${RED}`);
    assert.equal(brand.textColor, '#111111');
    assert.equal(brand.sources.primaryColor, 'powerpoint');
  });

  it('takes a value the PowerPoint theme lacks from the Word theme', () => {
    const brand = resolveBrand({ themes: [powerpoint, word] });
    assert.equal(brand.headingFont, 'Georgia');
    assert.equal(brand.sources.headingFont, 'word');
  });

  it('tries the Word theme when the PowerPoint theme has only greys', () => {
    const greys = {
      source: 'powerpoint',
      brand: brandFromTheme({ colors: { dk1: '000000', accent1: GREY1, accent2: GREY2 } })
    };
    const brand = resolveBrand({ themes: [greys, word] });
    assert.equal(brand.primaryColor, `#${BLUE}`);
    assert.equal(brand.sources.primaryColor, 'word');
    assert.equal(brand.textColor, '#000000');
    assert.equal(brand.sources.textColor, 'powerpoint');
  });

  it('falls back to the neutral default, and says so', () => {
    const brand = resolveBrand({});
    assert.match(brand.primaryColor, /^#[0-9A-F]{6}$/);
    assert.equal(brand.sources.primaryColor, 'default');
    assert.equal(brand.palette.length, 6);
    assert.equal(brand.headingFont, undefined);
  });

  it('keeps the neutral defaults out of what may override a request', () => {
    const specified = specifiedBrand(resolveBrand({ brand: { accentColor: '#00FF00' } }));
    assert.deepEqual(specified, { accentColor: '#00FF00' });
  });
});

describe('pdfMarginsFromWordSetup', () => {
  it('converts twips to points as [left, top, right, bottom]', () => {
    assert.deepEqual(
      pdfMarginsFromWordSetup({ margins: { left: 1701, top: 1440, right: 1134, bottom: 1134 } }),
      [85, 72, 57, 57]
    );
  });

  it('keeps the margins within the limits of the template schema', () => {
    assert.deepEqual(
      pdfMarginsFromWordSetup({ margins: { left: 100, top: 100, right: 9000, bottom: 9000 } }),
      [18, 18, 200, 200]
    );
  });
});

describe('pdfPageFromWordSetup', () => {
  const margins = { left: 1134, top: 1134, right: 1134, bottom: 1134 };

  it('names the format of the page, however it is turned', () => {
    assert.equal(
      pdfPageFromWordSetup({ width: 11906, height: 16838, landscape: false, margins }).size,
      'A4'
    );
    assert.equal(
      pdfPageFromWordSetup({ width: 16838, height: 11906, landscape: true, margins }).size,
      'A4'
    );
    assert.equal(
      pdfPageFromWordSetup({ width: 12240, height: 15840, landscape: false, margins }).size,
      'LETTER'
    );
    assert.equal(
      pdfPageFromWordSetup({ width: 16838, height: 23811, landscape: false, margins }).size,
      'A3'
    );
  });

  it('allows a page that is a little off, and names none that is far off', () => {
    assert.equal(
      pdfPageFromWordSetup({ width: 11950, height: 16800, landscape: false, margins }).size,
      'A4'
    );
    assert.equal(
      pdfPageFromWordSetup({ width: 10000, height: 16838, landscape: false, margins }).size,
      undefined
    );
  });

  it('reports the orientation Word does', () => {
    assert.equal(
      pdfPageFromWordSetup({ width: 16838, height: 11906, landscape: true, margins }).orientation,
      'landscape'
    );
    assert.equal(
      pdfPageFromWordSetup({ width: 11906, height: 16838, landscape: false, margins }).orientation,
      'portrait'
    );
  });
});

// --- The template store ---------------------------------------------------------

const BASE = { name: { en: 'Test' } };

describe('the brand of a stored template', () => {
  it('comes from the themes of its Word and PowerPoint files', async () => {
    templates.clearTemplateCaches();
    await templates.saveTemplate('themed', { ...BASE, id: 'themed' }, { create: true });
    await templates.saveTemplateAsset('themed', {
      slot: 'powerpointTemplate',
      data: await pptxWithAccents([RED, SLATE, BLUE, GREEN, AMBER, GREY1], { text: '111827' }),
      originalName: 'deck.potx'
    });
    const brand = await templates.resolveTemplateBrand(await templates.getTemplate('themed'));
    assert.equal(brand.primaryColor, `#${RED}`);
    assert.equal(brand.textColor, '#111827');
    assert.equal(brand.sources.primaryColor, 'powerpoint');
  });

  it('follows a changed file without a restart', async () => {
    await templates.saveTemplateAsset('themed', {
      slot: 'powerpointTemplate',
      data: await pptxWithAccents([BLUE, AMBER, GREEN, RED, SLATE, GREY1]),
      originalName: 'deck.potx'
    });
    const brand = await templates.resolveTemplateBrand(await templates.getTemplate('themed'));
    assert.equal(brand.primaryColor, `#${BLUE}`);
  });

  it("lets the template's own colour win", async () => {
    await templates.saveTemplate(
      'themed',
      {
        ...BASE,
        id: 'themed',
        brand: { primaryColor: '#00FF00' },
        pptx: { template: 'powerpoint-template.potx' }
      },
      {}
    );
    const brand = await templates.resolveTemplateBrand(await templates.getTemplate('themed'));
    assert.equal(brand.primaryColor, '#00FF00');
    assert.equal(brand.sources.primaryColor, 'template');
    assert.equal(brand.accentColor, `#${AMBER}`);
    // The tests below use the theme's colours again.
    await templates.saveTemplate(
      'themed',
      { ...BASE, id: 'themed', pptx: { template: 'powerpoint-template.potx' } },
      {}
    );
  });

  it('is the neutral default for a template without files', async () => {
    await templates.saveTemplate('bare', { ...BASE, id: 'bare' }, { create: true });
    const brand = await templates.resolveTemplateBrand(await templates.getTemplate('bare'));
    assert.equal(brand.sources.primaryColor, 'default');
  });
});

describe("the theme of a format's own file counts first", () => {
  it('gives a Word document the Word theme, and everything else the PowerPoint theme', async () => {
    await templates.saveTemplate('mixed', { ...BASE, id: 'mixed' }, { create: true });
    await templates.saveTemplateAsset('mixed', {
      slot: 'powerpointTemplate',
      data: await pptxWithAccents([RED, SLATE, BLUE, GREEN, AMBER, GREY1]),
      originalName: 'deck.potx'
    });
    await templates.saveTemplateAsset('mixed', {
      slot: 'wordTemplate',
      data: await wordTemplate([GREEN, AMBER, BLUE, RED, SLATE, GREY1]),
      originalName: 'letter.dotx'
    });
    const forWord = await templates.loadTemplateBundle('mixed', 'docx');
    assert.equal(forWord.brand.primaryColor, `#${GREEN}`);
    assert.equal(forWord.brand.sources.primaryColor, 'word');
    for (const format of ['pdf', 'pptx', 'xlsx']) {
      const bundle = await templates.loadTemplateBundle('mixed', format);
      assert.equal(bundle.brand.primaryColor, `#${RED}`, format);
      assert.equal(bundle.brand.sources.primaryColor, 'powerpoint', format);
    }
  });

  it('colours the Word document of such a template in the Word theme', async () => {
    const bundle = await templates.loadTemplateBundle('mixed', 'docx');
    const { spec } = applyTemplateToDocxSpec({ markdown: 'x' }, bundle);
    assert.equal(spec.colors.primary, `#${GREEN}`);
  });
});

describe('what the admin page shows of a stored template', () => {
  it('says where the PDF margins come from: the template, the Word template or the default', async () => {
    await templates.saveTemplate('shown', { ...BASE, id: 'shown' }, { create: true });
    const bare = await templates.resolveTemplateSettings(await templates.getTemplate('shown'));
    assert.deepEqual(bare.pdf, {
      margins: [50, 62, 50, 62],
      source: 'default',
      inherited: { margins: [50, 62, 50, 62], source: 'default' }
    });
    assert.equal(bare.brand.sources.primaryColor, 'default');

    await templates.saveTemplateAsset('shown', {
      slot: 'wordTemplate',
      data: await wordTemplate([BLUE, AMBER, GREEN, RED, SLATE, GREY1]),
      originalName: 'letter.dotx'
    });
    const word = await templates.resolveTemplateSettings(await templates.getTemplate('shown'));
    assert.deepEqual(word.pdf, {
      margins: [85, 72, 57, 57],
      source: 'word',
      inherited: { margins: [85, 72, 57, 57], source: 'word' },
      size: 'A4',
      orientation: 'portrait'
    });
    assert.equal(word.brand.sources.primaryColor, 'word');
    assert.equal(word.brand.primaryColor, `#${BLUE}`);

    await templates.saveTemplate(
      'shown',
      {
        ...BASE,
        id: 'shown',
        pdf: { margins: [30, 40, 30, 40] },
        docx: { template: 'word-template.dotx' }
      },
      {}
    );
    const own = await templates.resolveTemplateSettings(await templates.getTemplate('shown'));
    assert.equal(own.pdf.source, 'template');
    assert.deepEqual(own.pdf.margins, [30, 40, 30, 40]);
    // The Word template's margins are still known, for taking the own ones back.
    assert.deepEqual(own.pdf.inherited, { margins: [85, 72, 57, 57], source: 'word' });
  });
});

describe('what the model is told about the brand', () => {
  it("is the brand each tool's own output uses: the Word theme first for Word", async () => {
    const { systemSkillToolsFor } = await import('../services/systemSkillTools.js');
    const context = await templates.documentTemplateContext({
      app: { documentTemplate: 'mixed' }
    });
    assert.equal(context.brand.primaryColor, `#${RED}`);
    assert.equal(context.brands.docx.primaryColor, `#${GREEN}`);
    const skills = [
      { name: 'docx', isSystem: true, providedTools: ['create_docx'] },
      { name: 'pdf', isSystem: true, providedTools: ['create_pdf'] }
    ];
    const tools = systemSkillToolsFor(skills, { language: 'en', templates: context });
    const description = id => tools.find(t => t.id === id).description;
    assert.match(description('create_docx'), new RegExp(`primary colour #${GREEN}`));
    assert.doesNotMatch(description('create_docx'), new RegExp(`primary colour #${RED}`));
    assert.match(description('create_pdf'), new RegExp(`primary colour #${RED}`));
  });
});

describe('the fields parameter of the Word tool', () => {
  it('is offered when a template has fields or an uploaded Word file can bring its own', async () => {
    const { systemSkillToolsFor } = await import('../services/systemSkillTools.js');
    const skills = [{ name: 'docx', isSystem: true, providedTools: ['create_docx'] }];
    const offered = async app => {
      const context = await templates.documentTemplateContext({ app });
      const tool = systemSkillToolsFor(skills, { language: 'en', templates: context }).find(
        t => t.id === 'create_docx'
      );
      return Boolean(tool.parameters.properties.fields);
    };
    // No template of this installation declares fields.
    assert.equal(await offered({}), true, 'users may upload a Word file');
    assert.equal(await offered({ allowUserTemplateUploads: false }), false);
    assert.equal(
      await offered({ documentTemplate: 'bare' }),
      false,
      'a pinned template, no uploads'
    );
    assert.equal(await offered({ documentTemplate: 'bare', allowUserTemplateUploads: true }), true);
  });
});

describe('the PDF page of a stored template', () => {
  it("comes from the Word template's last section: margins, format and orientation", async () => {
    await templates.saveTemplate('margins', { ...BASE, id: 'margins' }, { create: true });
    await templates.saveTemplateAsset('margins', {
      slot: 'wordTemplate',
      data: await wordTemplate([BLUE, AMBER, GREEN, RED, SLATE, GREY1]),
      originalName: 'letter.dotx'
    });
    assert.deepEqual(await templates.resolvePdfPage(await templates.getTemplate('margins')), {
      margins: [85, 72, 57, 57],
      size: 'A4',
      orientation: 'portrait'
    });
  });

  it("has the template's own margins when it sets them, and the rest from the Word template", async () => {
    await templates.saveTemplate(
      'margins',
      {
        ...BASE,
        id: 'margins',
        pdf: { margins: [40, 50, 40, 50] },
        docx: { template: 'word-template.dotx' }
      },
      {}
    );
    assert.deepEqual(await templates.resolvePdfPage(await templates.getTemplate('margins')), {
      margins: [40, 50, 40, 50],
      size: 'A4',
      orientation: 'portrait'
    });
  });

  it('knows a Letter page and a landscape page', async () => {
    await templates.saveTemplate('wide', { ...BASE, id: 'wide' }, { create: true });
    await templates.saveTemplateAsset('wide', {
      slot: 'wordTemplate',
      data: await wordTemplate([BLUE, AMBER, GREEN, RED, SLATE, GREY1], {
        page: { w: 15840, h: 12240, orient: 'landscape' }
      }),
      originalName: 'wide.dotx'
    });
    const { size, orientation } = await templates.resolvePdfPage(
      await templates.getTemplate('wide')
    );
    assert.equal(size, 'LETTER');
    assert.equal(orientation, 'landscape');
  });

  it('leaves the format to the engine when it is none a PDF has', async () => {
    await templates.saveTemplate('odd', { ...BASE, id: 'odd' }, { create: true });
    await templates.saveTemplateAsset('odd', {
      slot: 'wordTemplate',
      data: await wordTemplate([BLUE, AMBER, GREEN, RED, SLATE, GREY1], {
        page: { w: 9000, h: 9000 }
      }),
      originalName: 'odd.dotx'
    });
    const page = await templates.resolvePdfPage(await templates.getTemplate('odd'));
    assert.equal(page.size, undefined);
    assert.ok(page.margins);
  });

  it("is empty when nothing says, and the PDF engine's default applies", async () => {
    assert.deepEqual(await templates.resolvePdfPage(await templates.getTemplate('bare')), {});
  });
});

describe('a template applied to a document', () => {
  it('gives a PDF the colours of the template theme and the margins of the Word template', async () => {
    const bundle = await templates.loadTemplateBundle('themed', 'pdf');
    const { spec } = applyTemplateToPdfSpec({ title: 'T', markdown: 'x' }, bundle);
    assert.equal(spec.themeOptions.primaryColor, `#${BLUE}`);
    assert.equal(spec.themeOptions.accentColor, `#${AMBER}`);
    assert.equal(spec.themeOptions.textColor, '#1F2937');

    const withMargins = await templates.loadTemplateBundle('margins', 'pdf');
    const { page } = applyTemplateToPdfSpec({ title: 'T', markdown: 'x' }, withMargins).spec;
    assert.deepEqual(page.margins, [40, 50, 40, 50]);
    assert.equal(page.size, 'A4');
  });

  it("keeps a request's colours for a template that says nothing about them", async () => {
    const bundle = await templates.loadTemplateBundle('bare', 'pdf');
    const { spec } = applyTemplateToPdfSpec(
      { title: 'T', markdown: 'x', themeOptions: { primaryColor: '#123456' } },
      bundle
    );
    assert.equal(spec.themeOptions.primaryColor, '#123456');
  });

  it('gives a workbook the colours of the template theme', async () => {
    const bundle = await templates.loadTemplateBundle('themed', 'xlsx');
    const { spec } = applyTemplateToXlsxSpec({ sheets: [] }, bundle);
    assert.equal(spec.brand.primaryColor, `#${BLUE}`);
  });
});

// --- The template schema --------------------------------------------------------

describe('the template schema', () => {
  const parse = extra =>
    documentTemplateSchema.safeParse({ id: 'acme', name: { en: 'Acme' }, ...extra });
  const messages = result => result.error.issues.map(i => i.message);

  it('has no fields by default', () => {
    assert.deepEqual(parse({}).data.fields, {});
  });

  it('accepts custom fields with options and a default', () => {
    const result = parse({
      fields: {
        classification: {
          label: { en: 'Classification', de: 'Klassifizierung' },
          required: true,
          options: ['public', 'internal', 'confidential'],
          default: 'internal'
        },
        department: {}
      }
    });
    assert.equal(result.success, true);
  });

  it('refuses a field named like a built-in placeholder', () => {
    for (const name of BUILT_IN_PLACEHOLDERS) {
      assert.match(messages(parse({ fields: { [name]: {} } })).join(), /built-in placeholder/);
    }
  });

  it('refuses field names that are not lower case letters, digits and underscores', () => {
    for (const name of ['Dept', '1st', 'a-b', 'a b', 'x'.repeat(33)]) {
      assert.equal(parse({ fields: { [name]: {} } }).success, false, name);
    }
  });

  it('refuses a default that is not one of the options', () => {
    const result = parse({ fields: { level: { options: ['a', 'b'], default: 'c' } } });
    assert.match(messages(result).join(), /one of the options/);
  });

  it('refuses an option listed twice', () => {
    assert.equal(parse({ fields: { level: { options: ['a', 'a'] } } }).success, false);
  });

  it('refuses more fields than a template may have', () => {
    const fields = Object.fromEntries(
      Array.from({ length: MAX_TEMPLATE_FIELDS + 1 }, (_, i) => [`field${i}`, {}])
    );
    assert.match(messages(parse({ fields })).join(), /At most 50 fields/);
  });

  it('accepts PDF margins and refuses ones outside the limits', () => {
    assert.equal(parse({ pdf: { margins: [50, 62, 50, 62] } }).success, true);
    assert.equal(parse({ pdf: { margins: [10, 62, 50, 62] } }).success, false);
    assert.equal(parse({ pdf: { margins: [50, 62, 50] } }).success, false);
  });
});

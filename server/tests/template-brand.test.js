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
const { brandFromTheme, readThemeBrand, resolveBrand, specifiedBrand, pdfMarginsFromWordSetup } =
  await import('../services/documents/templates/themeBrand.js');
const { applyTemplateToPdfSpec, applyTemplateToXlsxSpec } =
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
async function wordTemplate(accents, { margins, options } = {}) {
  const m = { top: 1440, right: 1134, bottom: 1134, left: 1701, ...margins };
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
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
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

describe('PDF margins of a stored template', () => {
  it("come from the Word template's last section", async () => {
    await templates.saveTemplate('margins', { ...BASE, id: 'margins' }, { create: true });
    await templates.saveTemplateAsset('margins', {
      slot: 'wordTemplate',
      data: await wordTemplate([BLUE, AMBER, GREEN, RED, SLATE, GREY1]),
      originalName: 'letter.dotx'
    });
    assert.deepEqual(
      await templates.resolvePdfMargins(await templates.getTemplate('margins')),
      [85, 72, 57, 57]
    );
  });

  it("are the template's own when it sets them", async () => {
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
    assert.deepEqual(
      await templates.resolvePdfMargins(await templates.getTemplate('margins')),
      [40, 50, 40, 50]
    );
  });

  it('are left to the PDF engine when nothing says', async () => {
    assert.equal(await templates.resolvePdfMargins(await templates.getTemplate('bare')), undefined);
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
    assert.deepEqual(
      applyTemplateToPdfSpec({ title: 'T', markdown: 'x' }, withMargins).spec.page.margins,
      [40, 50, 40, 50]
    );
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

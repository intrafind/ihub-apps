// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The placeholders of a Word template: `{{year}}` and the template's own
 * fields, `{{page}}` and `{{pages}}` as page number fields, `{{toc}}` as the
 * table of contents, and the values of custom fields (defaults, allowed
 * options, what is missing).
 *
 * Run: node --test server/tests/template-placeholders.test.js
 */

import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const { renderDocx } = await import('../services/documents/docx/renderDocx.js');
const { inspectWordTemplate } = await import('../services/documents/docx/wordTemplate.js');
const { describeFields, givenFieldsOf, resolveFieldValues } =
  await import('../services/documents/templates/templateFields.js');
const { applyTemplateToDocxSpec } =
  await import('../services/documents/templates/applyTemplate.js');
const { docxSpecFromToolArgs } = await import('../services/documents/docx/docxTools.js');

// --- Fixtures -------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** A paragraph from runs; a run is a string or `{ text, bold }`. */
function paragraph(runs) {
  const xml = []
    .concat(runs)
    .map(run => {
      if (run.pageBreak) return '<w:r><w:br w:type="page"/></w:r>';
      const { text, bold } = typeof run === 'string' ? { text: run } : run;
      return `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
    })
    .join('');
  return `<w:p>${xml}</w:p>`;
}

/**
 * A Word template: the body's paragraphs, and optionally a footer. Each
 * paragraph is a list of runs, so a placeholder can be split like Word does.
 */
async function wordTemplate({ body, footer }) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body.map(paragraph).join('')}<w:sectPr>${footer ? '<w:footerReference w:type="default" r:id="rId9"/>' : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  );
  if (footer) {
    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId9" Type="${R}/footer" Target="footer1.xml"/></Relationships>`
    );
    zip.file(
      'word/footer1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${W}">${footer.map(paragraph).join('')}</w:ftr>`
    );
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const SPEC = {
  title: 'Quarterly Report',
  subtitle: 'Q3',
  author: 'Ann Example',
  company: 'Example AG',
  date: '2026-11-26',
  language: 'en',
  markdown: '# Introduction\n\nHello world.'
};

/** Render a spec on a template and give the document and footer XML. */
async function render(template, spec = {}) {
  const { buffer } = await renderDocx({ ...SPEC, ...spec }, { wordTemplate: template });
  const zip = await JSZip.loadAsync(buffer);
  return {
    document: await zip.file('word/document.xml').async('string'),
    footer: zip.file('word/footer1.xml') ? await zip.file('word/footer1.xml').async('string') : '',
    zip
  };
}

/** The text of the `w:t` elements of some XML, in order. */
const textOf = xml => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');

// --- Built-in placeholders and custom fields ------------------------------------

describe('placeholders in a Word template', () => {
  it('fills the built-in placeholders, year included', async () => {
    const template = await wordTemplate({
      body: [
        ['{{title}} / {{subtitle}} by {{author}}, {{company}}'],
        ['Date: {{date}}, year {{year}}'],
        ['{{content}}']
      ]
    });
    const { document } = await render(template);
    const text = textOf(document);
    assert.match(text, /Quarterly Report \/ Q3 by Ann Example, Example AG/);
    assert.match(text, /Date: 2026-11-26, year 2026/);
  });

  it('takes the year from a date that is written out', async () => {
    const template = await wordTemplate({ body: [['{{year}}'], ['{{content}}']] });
    const { document } = await render(template, { date: '26 November 2031' });
    assert.match(textOf(document), /^2031/);
  });

  it("fills the template's own fields, also when Word split the placeholder", async () => {
    const template = await wordTemplate({
      body: [
        ['Department: {{', 'Depart', 'ment}}'],
        ['Level: {{ classification }}'],
        ['{{content}}']
      ]
    });
    const { document } = await render(template, {
      fields: { department: 'Sales', classification: 'internal' }
    });
    const text = textOf(document);
    assert.match(text, /Department: Sales/);
    assert.match(text, /Level: internal/);
  });

  it('lets a built-in placeholder win over a field of the same name', async () => {
    const template = await wordTemplate({ body: [['{{title}}'], ['{{content}}']] });
    const { document } = await render(template, { fields: { title: 'Sneaky' } });
    assert.match(textOf(document), /^Quarterly Report/);
  });

  it('leaves a name that is neither built in nor given as it is', async () => {
    const template = await wordTemplate({ body: [['{{unknown_field}}'], ['{{content}}']] });
    const { document } = await render(template);
    assert.match(textOf(document), /^\{\{unknown_field\}\}/);
  });

  it('matches names with digits and underscores', async () => {
    const template = await wordTemplate({ body: [['{{doc_id2}}'], ['{{content}}']] });
    const { document } = await render(template, { fields: { doc_id2: 'X-7' } });
    assert.match(textOf(document), /^X-7/);
  });
});

describe('page numbers in a Word template', () => {
  it('writes {{page}} and {{pages}} as page number fields that keep the formatting', async () => {
    const template = await wordTemplate({
      body: [['{{content}}']],
      footer: [['Page ', { text: '{{page}}', bold: true }, ' of {{pages}} · {{company}}']]
    });
    const { footer } = await render(template);
    assert.match(footer, /<w:fldSimple w:instr=" PAGE ">/);
    assert.match(footer, /<w:fldSimple w:instr=" NUMPAGES ">/);
    // The page number field keeps the bold of the placeholder's run.
    assert.match(footer, /<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:b\/><\/w:rPr>/);
    assert.equal(textOf(footer).replace(/\s+/g, ' '), 'Page 1 of 1 · Example AG');
  });

  it('writes the fields in the body too, and splits the run in order', async () => {
    const template = await wordTemplate({
      body: [['See page {{page}} of {{pages}}.'], ['{{content}}']]
    });
    const { document } = await render(template);
    assert.ok(document.indexOf('PAGE ') < document.indexOf('NUMPAGES'));
    assert.match(textOf(document), /See page 1 of 1\./);
  });

  it('leaves a private-use character of the template itself alone', async () => {
    const template = await wordTemplate({
      body: [['Icon \uE001 and \uE000 here'], ['Page {{page}}'], ['{{content}}']]
    });
    const { document } = await render(template);
    assert.equal((document.match(/<w:fldSimple /g) || []).length, 1);
    assert.match(textOf(document), /Icon \uE001 and \uE000 here/);
  });

  it('keeps the icon of the template that shares a text with {{page}}', async () => {
    const template = await wordTemplate({
      body: [['Page {{page}} \uE000 of the template'], ['{{content}}']]
    });
    const { document } = await render(template);
    // One field for the placeholder; the icon in the same text stays a character.
    assert.equal((document.match(/<w:fldSimple /g) || []).length, 1);
    assert.match(textOf(document), /\uE000 of the template/);
  });

  it('turns a value that holds the private markers into plain text', async () => {
    const template = await wordTemplate({ body: [['{{title}}'], ['{{content}}']] });
    const { document } = await render(template, { title: 'ABC' });
    assert.doesNotMatch(document, /fldSimple/);
    assert.match(textOf(document), /^ABC/);
  });
});

// --- The table of contents ------------------------------------------------------

describe('{{toc}} in a Word template', () => {
  const body = [['{{toc}}'], ['{{content}}']];
  const tocCount = xml => (xml.match(/<w:instrText[^>]*>TOC /g) || []).length;
  const tocAt = xml => xml.search(/<w:instrText[^>]*>TOC /);

  it('puts the table of contents where the template has it, and only there', async () => {
    const { document } = await render(await wordTemplate({ body }));
    assert.equal(tocCount(document), 1);
    assert.ok(tocAt(document) < document.indexOf('Introduction'));
    assert.match(document, /w:fldCharType="begin" w:dirty="true"/);
    assert.match(textOf(document), /^Contents/);
  });

  it('writes the heading in the language of the document', async () => {
    const { document } = await render(await wordTemplate({ body }), { language: 'de' });
    assert.match(textOf(document), /^Inhalt/);
  });

  it('leaves the table of contents out when the document is asked to have none', async () => {
    const { document } = await render(await wordTemplate({ body }), { toc: false });
    assert.equal(tocCount(document), 0);
    assert.doesNotMatch(document, /\{\{toc\}\}/);
    assert.match(textOf(document), /Introduction/);
  });

  it('asks Word to fill the field when the document is opened', async () => {
    const { document } = await render(await wordTemplate({ body }));
    assert.match(document, /<w:instrText xml:space="preserve">TOC /);
  });

  it('removes {{toc}} that shares its paragraph with text', async () => {
    const template = await wordTemplate({ body: [['Contents: {{toc}}'], ['{{content}}']] });
    const { document } = await render(template);
    assert.equal(tocCount(document), 0);
    assert.match(textOf(document), /^Contents: /);
  });

  it('keeps the old way for a template without {{toc}}: contents at the start of the content', async () => {
    const template = await wordTemplate({ body: [['{{content}}']] });
    const { document } = await render(template, { toc: true });
    assert.equal(tocCount(document), 1);
    assert.ok(tocAt(document) < document.indexOf('Introduction'));
  });

  it('still puts the contents at the start when {{toc}} shares its paragraph and one is asked for', async () => {
    const template = await wordTemplate({ body: [['Contents: {{toc}}'], ['{{content}}']] });
    const { document } = await render(template, { toc: true });
    assert.equal(tocCount(document), 1);
    assert.match(textOf(document), /Contents: /);
  });

  it('keeps the requested table of contents when an uploaded file is used for its look only', async () => {
    // `{{toc}}` but no `{{content}}`: the old body is cleared, the contents stay.
    const template = await wordTemplate({ body: [['Old text'], ['{{toc}}'], ['More old text']] });
    const { document } = await render(template, { templateMode: 'styles_only', toc: true });
    assert.equal(tocCount(document), 1);
    assert.doesNotMatch(textOf(document), /Old text/);
    assert.ok(tocAt(document) < document.indexOf('Introduction'));
  });

  it('keeps the page break that ends the paragraph of {{toc}}', async () => {
    const template = await wordTemplate({
      body: [['{{toc}}', { pageBreak: true }], ['{{content}}']]
    });
    const { document } = await render(template);
    assert.equal(tocCount(document), 1);
    const toc = tocAt(document);
    const pageBreak = document.indexOf('<w:br w:type="page"/>');
    assert.ok(pageBreak > toc, 'the break follows the table of contents');
    assert.ok(pageBreak < document.indexOf('Introduction'), 'and comes before the content');
  });

  it('has no table of contents for a template without {{toc}} unless asked', async () => {
    const template = await wordTemplate({ body: [['{{content}}']] });
    assert.equal(tocCount((await render(template)).document), 0);
  });

  it('is part of the tool arguments only when set, so the template decides otherwise', () => {
    assert.equal(docxSpecFromToolArgs({ markdown: 'x' }).toc, undefined);
    assert.equal(docxSpecFromToolArgs({ markdown: 'x', toc: true }).toc, true);
    assert.equal(docxSpecFromToolArgs({ markdown: 'x', toc: false }).toc, false);
  });
});

describe('inspecting a Word template', () => {
  it('lists the built-in placeholders, the contents and the custom fields', async () => {
    const template = await wordTemplate({
      body: [['{{title}} {{department}}'], ['{{toc}}'], ['{{content}}']],
      footer: [['{{Classification}} {{page}}']]
    });
    const info = await inspectWordTemplate(template);
    assert.equal(info.tocPlaceholder, true);
    assert.equal(info.contentPlaceholder, true);
    assert.deepEqual(info.customFields, ['department', 'classification']);
    assert.ok(info.placeholders.includes('page'));
  });
});

// --- The values of custom fields ------------------------------------------------

describe('resolveFieldValues', () => {
  const definitions = {
    classification: {
      label: { en: 'Classification', de: 'Klassifizierung' },
      required: true,
      options: ['public', 'internal', 'confidential'],
      default: 'internal'
    },
    department: { required: true },
    note: {}
  };

  it('takes what was given, else the default, else leaves the field empty', () => {
    const { values, missing } = resolveFieldValues(definitions, { department: 'Sales' });
    assert.deepEqual(values, { classification: 'internal', department: 'Sales', note: '' });
    assert.deepEqual(missing, []);
  });

  it('reports a required field without a value, with what the user is to be asked', () => {
    const { missing } = resolveFieldValues(definitions, {}, 'de');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'department');
    assert.equal(missing[0].required, true);
    const described = describeFields(definitions, 'de').find(f => f.name === 'classification');
    assert.equal(described.label, 'Klassifizierung');
    assert.deepEqual(described.options, ['public', 'internal', 'confidential']);
  });

  it('matches an option without regard to case and keeps the option spelling', () => {
    const { values, invalid } = resolveFieldValues(definitions, {
      department: 'x',
      classification: 'CONFIDENTIAL'
    });
    assert.equal(values.classification, 'confidential');
    assert.deepEqual(invalid, []);
  });

  it('reports a value that is not one of the options, and does not use it', () => {
    const { values, invalid, missing } = resolveFieldValues(definitions, {
      department: 'x',
      classification: 'secret'
    });
    assert.equal(values.classification, '');
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].value, 'secret');
    assert.deepEqual(invalid[0].options, ['public', 'internal', 'confidential']);
    assert.deepEqual(missing, []);
  });

  it('trims, matches names without regard to case and reports unknown names', () => {
    const { values, unknown } = resolveFieldValues(definitions, {
      Department: '  Sales  ',
      title: 'built in, not reported',
      color: 'blue'
    });
    assert.equal(values.department, 'Sales');
    assert.deepEqual(unknown, ['color']);
  });

  it('takes numbers and booleans as text and ignores anything else', () => {
    const { values } = resolveFieldValues(
      { count: {}, flag: {}, other: {} },
      { count: 3, flag: true, other: { a: 1 } }
    );
    assert.deepEqual(values, { count: '3', flag: 'true', other: '' });
  });
});

describe('givenFieldsOf', () => {
  it('keeps names that are valid and texts that are not empty', () => {
    assert.deepEqual(
      givenFieldsOf({ Department: ' Sales ', 'bad name': 'x', empty: '', n: 5, nested: {} }),
      { department: 'Sales', n: '5' }
    );
  });

  it('gives nothing for what is not an object, and caps the length of a value', () => {
    assert.deepEqual(givenFieldsOf(undefined), {});
    assert.deepEqual(givenFieldsOf(['a']), {});
    assert.equal(givenFieldsOf({ note: 'x'.repeat(900) }).note.length, 500);
  });
});

describe('a template applied to a Word document', () => {
  it("gives the document the values of the template's fields, defaults included", () => {
    const template = {
      id: 'acme',
      brand: {},
      document: {},
      docx: {},
      fields: {
        classification: { options: ['public', 'internal'], default: 'internal' },
        department: {}
      }
    };
    const { spec } = applyTemplateToDocxSpec(
      { markdown: 'x', fields: { department: 'Sales' } },
      { template, assets: {}, brand: undefined }
    );
    assert.deepEqual(spec.fields, { classification: 'internal', department: 'Sales' });
  });
});

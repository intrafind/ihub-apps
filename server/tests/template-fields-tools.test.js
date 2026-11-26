// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The fields of a document template and the tools: what the model is told
 * about them (the guide, the `fields` parameter, the brand), and what
 * `create_docx` and `edit_docx` do with them — fill them, apply defaults,
 * stop and ask when a required value is missing or not allowed.
 *
 * Run: node --test server/tests/template-fields-tools.test.js
 */

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-template-fields-'));
process.env.CONTENTS_DIR = path.join(baseDir, 'contents');

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const templates = await import('../services/documents/templates/DocumentTemplateService.js');
const { fieldsGuide } = await import('../services/documents/templates/templateFields.js');
const { runCreateDocx, runEditDocx } = await import('../services/documents/docx/docxTools.js');
const { heldGeneratedFile } = await import('../services/documents/generatedFiles.js');
const { systemSkillToolsFor } = await import('../services/systemSkillTools.js');
const { buildBaseTemplate } = await import('../services/documents/pptx/baseTemplate.js');

after(() => fsSync.rmSync(baseDir, { recursive: true, force: true }));

// --- Fixtures -------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A minimal Word template with the given body paragraphs. */
async function wordTemplate(paragraphs) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  const body = paragraphs
    .map(text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const FIELDS = {
  classification: {
    label: { en: 'Classification', de: 'Klassifizierung' },
    description: { en: 'How sensitive the document is' },
    required: true,
    options: ['public', 'internal', 'confidential'],
    default: 'internal'
  },
  department: { label: { en: 'Department' }, required: true },
  note: {}
};

// "corporate" is the default template and has fields; "plain" has none.
await templates.saveTemplate(
  'corporate',
  { id: 'corporate', name: { en: 'Corporate', de: 'Konzern' }, default: true, fields: FIELDS },
  { create: true }
);
await templates.saveTemplateAsset('corporate', {
  slot: 'wordTemplate',
  data: await wordTemplate([
    'Classification: {{classification}}',
    'Department: {{department}}',
    '{{content}}'
  ]),
  originalName: 'corporate.dotx'
});
await templates.saveTemplateAsset('corporate', {
  slot: 'powerpointTemplate',
  data: await buildBaseTemplate({
    primaryColor: '#E30613',
    accentColor: '#374151',
    textColor: '#1F2937',
    headingFont: 'Brand Serif',
    bodyFont: 'Brand Sans'
  }),
  originalName: 'corporate.potx'
});
await templates.saveTemplate(
  'plain',
  { id: 'plain', name: { en: 'Plain' }, description: { en: 'No fields' } },
  { create: true }
);
await templates.saveTemplateAsset('plain', {
  slot: 'wordTemplate',
  data: await wordTemplate(['{{content}}']),
  originalName: 'plain.dotx'
});

const USER = { id: 'u1', name: 'Ann Example' };
let chatCounter = 0;

/** Run create_docx for a test of its own and give the result and the held file's text. */
async function create(args = {}, { user = USER } = {}) {
  chatCounter += 1;
  const chatId = `chat-${chatCounter}`;
  const result = await runCreateDocx({
    filename: 'Report',
    title: 'Report',
    markdown: '# Scope\n\nText.',
    user,
    chatId,
    appConfig: {},
    ...args
  });
  return { result, chatId, ...(await textsOf(result, user, chatId)) };
}

async function textsOf(result, user, chatId) {
  if (!result.success) return { document: '', core: '' };
  const zip = await JSZip.loadAsync(heldGeneratedFile(user, result.file.id, { chatId }).data);
  return {
    document: await zip.file('word/document.xml').async('string'),
    core: zip.file('docProps/core.xml') ? await zip.file('docProps/core.xml').async('string') : ''
  };
}

const SKILL = { name: 'docx', isSystem: true, providedTools: ['create_docx', 'edit_docx'] };

/** The create_docx tool as an app with the given template context offers it. */
function docxTool(templatesContext, language = 'en') {
  return systemSkillToolsFor([SKILL], { language, templates: templatesContext }).find(
    t => t.id === 'create_docx'
  );
}

// --- What the model is told -----------------------------------------------------

describe('fieldsGuide', () => {
  const entries = [
    { id: 'corporate', default: true, fields: FIELDS },
    { id: 'plain' },
    { id: 'legal', fields: { matter: { required: true } } }
  ];

  it('describes each field and tells the model to ask instead of inventing', () => {
    const guide = fieldsGuide(entries, { language: 'en' });
    assert.match(guide, /Ask the user for every required field/);
    assert.match(guide, /never invent a value/);
    assert.match(
      guide,
      /classification \(Classification — How sensitive the document is; required; one of: public \| internal \| confidential; default: internal\)/
    );
    assert.match(guide, /department \(Department; required\)/);
    assert.match(guide, /note \(note; optional\)/);
  });

  it('names the template of each line and marks the default one', () => {
    const guide = fieldsGuide(entries);
    assert.match(guide, /Template "corporate" \(default\): classification/);
    assert.match(guide, /Template "legal": matter/);
    assert.doesNotMatch(guide, /Template "plain"/);
  });

  it('leaves out the template names when only one template can apply', () => {
    const guide = fieldsGuide([entries[0]], { single: true });
    assert.doesNotMatch(guide, /Template "/);
    assert.match(guide, /\nclassification \(/);
  });

  it('is written in German for a German app, with the German labels', () => {
    const guide = fieldsGuide([entries[0]], { language: 'de', single: true });
    assert.match(guide, /Pflichtfeld/);
    assert.match(guide, /Klassifizierung/);
    assert.match(guide, /einer von: public/);
  });

  it('is empty when no template has fields, and never longer than the limit', () => {
    assert.equal(fieldsGuide([{ id: 'plain' }]), '');
    const many = [
      {
        id: 'big',
        fields: Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `field${i}`,
            { description: { en: 'x'.repeat(200) } }
          ])
        )
      }
    ];
    assert.ok(fieldsGuide(many).length <= 3000);
  });
});

describe('the template context of an app', () => {
  it('describes the fields of every enabled template when none is pinned', async () => {
    const context = await templates.documentTemplateContext({ app: {}, language: 'en' });
    assert.equal(context.fieldsApply, true);
    assert.match(context.guides.docx, /Template "corporate" \(default\)/);
    assert.doesNotMatch(context.guides.docx, /Template "plain"/);
  });

  it('describes only the fields of the pinned template', async () => {
    const pinned = await templates.documentTemplateContext({
      app: { documentTemplate: 'corporate' }
    });
    assert.equal(pinned.fieldsApply, true);
    assert.doesNotMatch(pinned.guides.docx, /Template "/);
    const plain = await templates.documentTemplateContext({ app: { documentTemplate: 'plain' } });
    assert.equal(plain.fieldsApply, false);
    assert.equal(plain.guides.docx, '');
  });

  it('gives the brand of the template that applies, read from its files', async () => {
    const { brand } = await templates.documentTemplateContext({
      app: { documentTemplate: 'corporate' }
    });
    assert.equal(brand.primaryColor, '#E30613');
    assert.equal(brand.headingFont, 'Brand Serif');
    assert.equal(brand.sources.primaryColor, 'powerpoint');
  });

  it('has no brand to tell when the template takes everything from the neutral default', async () => {
    const { brand } = await templates.documentTemplateContext({
      app: { documentTemplate: 'plain' }
    });
    assert.equal(brand, null);
  });
});

describe('create_docx as the model is offered it', () => {
  it('has a fields parameter and the guide when a template has fields', async () => {
    const context = await templates.documentTemplateContext({ app: {} });
    const tool = docxTool(context);
    assert.equal(tool.parameters.properties.fields.type, 'object');
    assert.match(tool.description, /Ask the user for every required field/);
    assert.match(tool.description, /Template "corporate" \(default\)/);
    assert.ok(tool.parameters.properties.template, 'the templates can be chosen');
  });

  it('tells the model the brand of the template, with the fonts as names only', async () => {
    const context = await templates.documentTemplateContext({
      app: { documentTemplate: 'corporate' }
    });
    const { description } = docxTool(context);
    assert.match(description, /primary colour #E30613, accent colour #374151/);
    assert.match(description, /headings Brand Serif, body Brand Sans \(names only/);
  });

  it('does not offer the brand parameters of a pinned template, but still the fields', async () => {
    const context = await templates.documentTemplateContext({
      app: { documentTemplate: 'corporate' }
    });
    const { parameters } = docxTool(context);
    assert.equal(parameters.properties.primaryColor, undefined);
    assert.equal(parameters.properties.font, undefined);
    assert.ok(parameters.properties.fields);
  });

  it('has no fields parameter when no template has fields', async () => {
    const context = await templates.documentTemplateContext({ app: { documentTemplate: 'plain' } });
    assert.equal(docxTool(context).parameters.properties.fields, undefined);
    assert.equal(
      docxTool({ pinned: null, choices: [], defaultName: null, guides: {}, fieldsApply: false })
        .parameters.properties.fields,
      undefined
    );
  });

  it('still offers the design where no template is pinned, and hides colours and font where one is', async () => {
    const design = ['header', 'footer', 'pageNumbers', 'pageSize', 'orientation'];
    const brand = ['primaryColor', 'accentColor', 'font'];
    const open = docxTool(await templates.documentTemplateContext({ app: {} })).parameters
      .properties;
    for (const name of [...design, ...brand]) assert.ok(open[name], name);
    const pinned = docxTool(
      await templates.documentTemplateContext({ app: { documentTemplate: 'corporate' } })
    ).parameters.properties;
    for (const name of brand) assert.equal(pinned[name], undefined, name);
    for (const name of design) assert.ok(pinned[name], name);
  });

  it('tells the model the table of contents follows the template', async () => {
    const context = await templates.documentTemplateContext({ app: {} });
    assert.match(docxTool(context).parameters.properties.toc.description, /\{\{toc\}\}/);
  });
});

// --- What the tools do ----------------------------------------------------------

describe('create_docx with a template that has fields', () => {
  it('fills the fields it is given', async () => {
    const { result, document } = await create({
      fields: { department: 'Sales', classification: 'confidential', note: 'unused' }
    });
    assert.equal(result.success, true, result.error);
    assert.match(document, /Classification: confidential/);
    assert.match(document, /Department: Sales/);
  });

  it('applies the default of a field that was not given, and matches options without regard to case', async () => {
    const withDefault = await create({ fields: { department: 'Sales' } });
    assert.match(withDefault.document, /Classification: internal/);
    const loose = await create({ fields: { department: 'Sales', classification: 'PUBLIC' } });
    assert.match(loose.document, /Classification: public/);
  });

  it('stops and asks for a required value that is missing', async () => {
    const { result, document } = await create({});
    assert.equal(result.success, false);
    assert.equal(result.code, 'missing_fields');
    assert.equal(document, '');
    assert.match(result.error, /needs more information/);
    assert.match(result.error, /Missing: department \(Department\)/);
    assert.match(result.error, /Ask the user for these values; do not invent them/);
    assert.match(result.error, /call this tool again with "fields"/);
    assert.deepEqual(
      result.details.missing.map(f => f.name),
      ['department']
    );
    assert.equal(result.files, undefined, 'no file was made');
  });

  it('stops and names the allowed values when a value is not one of the options', async () => {
    const { result } = await create({ fields: { department: 'Sales', classification: 'secret' } });
    assert.equal(result.success, false);
    assert.equal(result.code, 'missing_fields');
    assert.match(
      result.error,
      /Not allowed: classification = "secret" \(use one of: public, internal, confidential\)/
    );
    assert.equal(result.details.invalid[0].value, 'secret');
    assert.deepEqual(result.details.missing, []);
  });

  it('names a field it does not have and goes on', async () => {
    const { result } = await create({ fields: { department: 'Sales', colour: 'blue' } });
    assert.equal(result.success, true, result.error);
    assert.match(result.warnings.join(' '), /no field named colour/);
  });

  it('asks for nothing from a template without fields', async () => {
    const { result } = await create({ template: 'plain' });
    assert.equal(result.success, true, result.error);
  });

  it('takes a value given as a number', async () => {
    const { result, document } = await create({ fields: { department: 42 } });
    assert.equal(result.success, true, result.error);
    assert.match(document, /Department: 42/);
  });
});

describe('the author of a Word document', () => {
  it('is the person who asked for it, unless the model names one', async () => {
    const asked = await create({ fields: { department: 'Sales' } });
    assert.match(asked.core, /Ann Example/);
    const named = await create({ fields: { department: 'Sales' }, author: 'Board' });
    assert.match(named.core, /Board/);
    assert.doesNotMatch(named.core, /Ann Example/);
  });

  it('is not the name of an anonymous visitor', async () => {
    const { result, core } = await create(
      { fields: { department: 'Sales' } },
      { user: { id: 'anonymous', name: 'Anonymous' } }
    );
    assert.equal(result.success, true);
    assert.doesNotMatch(core, /Anonymous/);
  });
});

describe('edit_docx and fields', () => {
  it('changes one field and keeps the others', async () => {
    const { result, chatId } = await create({
      fields: { department: 'Sales', classification: 'confidential' }
    });
    assert.equal(result.success, true, result.error);
    const edited = await runEditDocx({
      filename: result.file.name,
      set: { fields: { department: 'Legal' } },
      user: USER,
      chatId,
      appConfig: {}
    });
    assert.equal(edited.success, true, edited.error);
    const { document } = await textsOf(edited, USER, chatId);
    assert.match(document, /Department: Legal/);
    assert.match(document, /Classification: confidential/);
  });

  it('asks again when a field it removes was required', async () => {
    const { result, chatId } = await create({ fields: { department: 'Sales' } });
    const edited = await runEditDocx({
      filename: result.file.name,
      set: { fields: null },
      user: USER,
      chatId,
      appConfig: {}
    });
    assert.equal(edited.success, false);
    assert.equal(edited.code, 'missing_fields');
  });
});

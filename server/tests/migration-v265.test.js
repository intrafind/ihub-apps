#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V265 specs — document templates move to the Office-file model.
 *
 * The margins move to the PDF section, the settings that go are removed, the
 * logo, font and letterhead files are deleted, and the placeholders of the Word
 * template become fields. A template in the new shape is left alone.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  description,
  fieldNamesOfWordTemplate,
  migrateTemplate,
  precondition,
  readZipEntries,
  up,
  version
} from '../migrations/V265__document_templates_rework.js';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const OLD_TEMPLATE = {
  id: 'corporate',
  name: { en: 'Corporate' },
  enabled: true,
  default: true,
  brand: {
    primaryColor: '#e30613',
    companyName: 'Example AG',
    headingFont: 'Brand Serif',
    bodyFont: 'Brand Sans',
    fontSize: 11,
    logo: 'logo.png'
  },
  fonts: [
    {
      family: 'Brand Serif',
      normal: 'font-brand-serif-normal.ttf',
      bold: 'font-brand-serif-bold.ttf'
    }
  ],
  document: {
    margins: [57, 71, 57, 71],
    header: '{company}',
    footer: 'Confidential',
    pageNumbers: false
  },
  pdf: {
    theme: 'professional',
    letterhead: 'letterhead.pdf',
    letterheadFollowing: 'letterhead-following.pdf'
  },
  docx: { template: 'word-template.dotx' },
  pptx: {
    template: 'powerpoint-template.potx',
    aspectRatio: '16:9',
    footer: 'Example AG',
    slideNumbers: true,
    layouts: { title: 'Titelfolie' },
    slots: { kicker: { placeholder: 'Kicker' } }
  }
};

describe('migrateTemplate', () => {
  it('moves the margins to the PDF section', () => {
    const { template } = migrateTemplate(OLD_TEMPLATE);
    assert.deepEqual(template.pdf.margins, [57, 71, 57, 71]);
  });

  it('keeps the margins a template already has for PDFs', () => {
    const { template } = migrateTemplate({
      ...OLD_TEMPLATE,
      pdf: { ...OLD_TEMPLATE.pdf, margins: [40, 50, 40, 50] }
    });
    assert.deepEqual(template.pdf.margins, [40, 50, 40, 50]);
  });

  it('does not move margins the schema would refuse', () => {
    const { template } = migrateTemplate({ ...OLD_TEMPLATE, document: { margins: [5, 5, 5, 5] } });
    assert.equal(template.pdf.margins, undefined);
  });

  it('removes the settings that go and keeps the rest', () => {
    const { template } = migrateTemplate(OLD_TEMPLATE);
    assert.deepEqual(template, {
      id: 'corporate',
      name: { en: 'Corporate' },
      enabled: true,
      default: true,
      brand: { primaryColor: '#e30613', companyName: 'Example AG' },
      pdf: { margins: [57, 71, 57, 71] },
      docx: { template: 'word-template.dotx' },
      pptx: { template: 'powerpoint-template.potx' }
    });
  });

  it('names the files that go: logo, fonts, letterheads', () => {
    const { files } = migrateTemplate(OLD_TEMPLATE);
    assert.deepEqual(files.sort(), [
      'font-brand-serif-bold.ttf',
      'font-brand-serif-normal.ttf',
      'letterhead-following.pdf',
      'letterhead.pdf',
      'logo.png'
    ]);
  });

  it('leaves a template in the new shape as it is', () => {
    const migrated = migrateTemplate(OLD_TEMPLATE).template;
    const again = migrateTemplate(migrated);
    assert.equal(again.changed, false);
    assert.deepEqual(again.files, []);
  });

  it('copes with a template that has few sections', () => {
    const { template, changed } = migrateTemplate({ id: 'bare', name: { en: 'Bare' } });
    assert.equal(changed, false);
    assert.deepEqual(template, { id: 'bare', name: { en: 'Bare' } });
  });
});

// --- The Word template ------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function wordTemplate({ body, footer }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  const paragraph = runs =>
    `<w:p>${[]
      .concat(runs)
      .map(text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`)
      .join('')}</w:p>`;
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="${W}"><w:body>${body.map(paragraph).join('')}</w:body></w:document>`
  );
  if (footer)
    zip.file('word/footer1.xml', `<w:ftr xmlns:w="${W}">${footer.map(paragraph).join('')}</w:ftr>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('fieldNamesOfWordTemplate', () => {
  it('finds the placeholders that are not built in, also split over runs, and in the footer', async () => {
    const buffer = await wordTemplate({
      body: [['{{title}} {{Department}}'], ['{{', 'classi', 'fication}}'], ['{{content}} {{toc}}']],
      footer: [['{{page}} of {{pages}} {{doc_id2}}']]
    });
    assert.deepEqual(fieldNamesOfWordTemplate(buffer), ['department', 'classification', 'doc_id2']);
  });

  it('names a field once, whatever its case', async () => {
    const buffer = await wordTemplate({ body: [['{{Dept}} {{dept}} {{DEPT}}']] });
    assert.deepEqual(fieldNamesOfWordTemplate(buffer), ['dept']);
  });

  it('reads stored and deflated parts alike, and nothing from a file that is not a ZIP', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      `<w:document xmlns:w="${W}"><w:p><w:r><w:t>{{kept}}</w:t></w:r></w:p></w:document>`
    );
    const stored = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    assert.deepEqual(fieldNamesOfWordTemplate(stored), ['kept']);
    assert.deepEqual(fieldNamesOfWordTemplate(Buffer.from('not a zip at all')), []);
    assert.deepEqual(
      readZipEntries(Buffer.alloc(0), () => true),
      []
    );
  });

  it('decodes the XML entities of a placeholder', async () => {
    const buffer = await wordTemplate({ body: [['&#123;{a&amp;b}}'], ['{{ok}}']] });
    assert.deepEqual(fieldNamesOfWordTemplate(buffer), ['ok']);
  });
});

// --- The migration -----------------------------------------------------------------

let baseDir = null;

function makeCtx(dir) {
  const logs = [];
  const warnings = [];
  return {
    logs,
    warnings,
    contentsDir: dir,
    fileExists: rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    deleteFile: rel => fs.unlink(path.join(dir, rel)),
    listFiles: async directory => {
      try {
        return await fs.readdir(path.join(dir, directory));
      } catch {
        return [];
      }
    },
    log: message => logs.push(message),
    warn: message => warnings.push(message)
  };
}

async function writeTemplate(dir, id, template, files = {}) {
  const folder = path.join(dir, 'document-templates', id);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'template.json'), JSON.stringify(template, null, 2));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(folder, name), content);
  }
  return folder;
}

const exists = file =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

describe('migration V265', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v265-'));
  });
  after(() => fs.rm(baseDir, { recursive: true, force: true }));

  it('has the version and description of its file', () => {
    assert.equal(version, '265');
    assert.equal(description, 'document_templates_rework');
  });

  it('is skipped where there are no document templates', async () => {
    assert.equal(await precondition(makeCtx(baseDir)), false);
  });

  it('migrates a template: shape, files and fields', async () => {
    const word = await wordTemplate({
      body: [['{{title}}'], ['Department: {{department}}'], ['{{content}}']],
      footer: [['{{classification}}']]
    });
    const folder = await writeTemplate(baseDir, 'corporate', OLD_TEMPLATE, {
      'logo.png': 'png',
      'letterhead.pdf': 'pdf',
      'letterhead-following.pdf': 'pdf',
      'font-brand-serif-normal.ttf': 'ttf',
      'font-brand-serif-bold.ttf': 'ttf',
      'word-template.dotx': word,
      'powerpoint-template.potx': 'pptx'
    });
    const ctx = makeCtx(baseDir);
    assert.equal(await precondition(ctx), true);
    await up(ctx);

    const migrated = JSON.parse(await fs.readFile(path.join(folder, 'template.json'), 'utf8'));
    assert.deepEqual(migrated.brand, { primaryColor: '#e30613', companyName: 'Example AG' });
    assert.deepEqual(migrated.pdf, { margins: [57, 71, 57, 71] });
    assert.deepEqual(migrated.fields, { department: {}, classification: {} });
    assert.equal(migrated.fonts, undefined);
    assert.equal(migrated.document, undefined);
    for (const gone of [
      'logo.png',
      'letterhead.pdf',
      'letterhead-following.pdf',
      'font-brand-serif-normal.ttf',
      'font-brand-serif-bold.ttf'
    ]) {
      assert.equal(await exists(path.join(folder, gone)), false, gone);
    }
    for (const kept of ['word-template.dotx', 'powerpoint-template.potx']) {
      assert.equal(await exists(path.join(folder, kept)), true, kept);
    }
    assert.match(ctx.logs.join(), /Moved 1 document template/);
  });

  it('writes nothing the second time', async () => {
    const file = path.join(baseDir, 'document-templates', 'corporate', 'template.json');
    const before = await fs.stat(file);
    const ctx = makeCtx(baseDir);
    await up(ctx);
    const after = await fs.stat(file);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.match(ctx.logs.join(), /No document template needed changes/);
  });

  it('keeps the fields an admin already declared', async () => {
    const word = await wordTemplate({ body: [['{{department}} {{note}}']] });
    const declared = { label: { en: 'Department' }, required: true };
    await writeTemplate(
      baseDir,
      'legal',
      {
        id: 'legal',
        name: { en: 'Legal' },
        docx: { template: 'word-template.dotx' },
        fields: { department: declared }
      },
      { 'word-template.dotx': word }
    );
    await up(makeCtx(baseDir));
    const migrated = JSON.parse(
      await fs.readFile(path.join(baseDir, 'document-templates', 'legal', 'template.json'), 'utf8')
    );
    assert.deepEqual(migrated.fields, { department: declared, note: {} });
  });

  it('declares at most 50 fields and names the placeholders left over', async () => {
    const names = Array.from({ length: 53 }, (_, i) => `field${i}`);
    const word = await wordTemplate({ body: [names.map(name => `{{${name}}}`).join(' ')] });
    await writeTemplate(
      baseDir,
      'many',
      { id: 'many', name: { en: 'Many' }, docx: { template: 'word-template.dotx' } },
      { 'word-template.dotx': word }
    );
    const ctx = makeCtx(baseDir);
    await up(ctx);
    const migrated = JSON.parse(
      await fs.readFile(path.join(baseDir, 'document-templates', 'many', 'template.json'), 'utf8')
    );
    assert.equal(Object.keys(migrated.fields).length, 50);
    assert.match(ctx.warnings.join(), /field50, field51, field52/);
  });

  it('goes on when the Word template is gone, and says so', async () => {
    await writeTemplate(baseDir, 'lost', {
      id: 'lost',
      name: { en: 'Lost' },
      docx: { template: 'word-template.dotx' },
      brand: { logo: 'logo.png' }
    });
    const ctx = makeCtx(baseDir);
    await up(ctx);
    const migrated = JSON.parse(
      await fs.readFile(path.join(baseDir, 'document-templates', 'lost', 'template.json'), 'utf8')
    );
    assert.equal(migrated.brand.logo, undefined);
    assert.match(
      ctx.warnings.join(),
      /lost: the Word template word-template.dotx could not be read/
    );
  });
});

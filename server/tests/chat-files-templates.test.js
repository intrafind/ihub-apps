// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Slice 2 (#3158): uploaded files as templates / source files in the document
 * system skills (`templateFileId`, `sourceFileId`, `fillFormFields`).
 *
 * Run: node --test server/tests/chat-files-templates.test.js
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import configCache from '../configCache.js';
import { getChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import { buildDocx } from '../services/documents/docx/buildDocx.js';
import { runCreateDocx } from '../services/documents/docx/docxTools.js';
import { buildBaseTemplate } from '../services/documents/pptx/baseTemplate.js';
import { buildPptx } from '../services/documents/pptx/buildPptx.js';
import { runCreatePptx } from '../services/documents/pptx/pptxTools.js';
import { buildXlsx } from '../services/documents/xlsx/buildXlsx.js';
import { mergeIntoWorkbook } from '../services/documents/xlsx/mergeWorkbook.js';
import { runCreateXlsx } from '../services/documents/xlsx/xlsxTools.js';
import { runCreatePdf } from '../services/documents/pdf/pdfTools.js';
import { fillPdfFormFields, listPdfFormFields } from '../services/documents/pdf/fillForm.js';
import {
  loadUploadedFileOriginal,
  userTemplateUploadsAllowed
} from '../services/documents/templateFiles.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile
} from '../services/documents/generatedFiles.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let scratch;
let repo;
const user = { id: 'tpl-user' };
const chatId = 'chat-tpl-1';

async function store(name, mimeType, bytes, scope = { type: 'chat', id: chatId }) {
  // Written straight into the repository: the extracted text is irrelevant
  // here, the tools only read the original binary.
  const descriptor = await repo.put(scope, {
    ownerId: user.id,
    name,
    mimeType,
    text: `text of ${name}`,
    originalBuffer: bytes,
    storageMode: 'original_and_text'
  });
  assert.ok(descriptor?.hasOriginal, `${name} is stored with its original`);
  return descriptor;
}

async function pdfWithForm() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Application form', { x: 20, y: 270, size: 14, font });
  const form = doc.getForm();
  const name = form.createTextField('FullName');
  name.addToPage(page, { x: 20, y: 220, width: 200, height: 20 });
  const agree = form.createCheckBox('Newsletter');
  agree.addToPage(page, { x: 20, y: 190, width: 15, height: 15 });
  const country = form.createDropdown('Country');
  country.addOptions(['Germany', 'France']);
  country.addToPage(page, { x: 20, y: 150, width: 120, height: 20 });
  return Buffer.from(await doc.save());
}

async function plainPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([400, 300]);
  return Buffer.from(await doc.save());
}

async function bodyText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(' ');
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-files-templates-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir: scratch, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
  repo = getChatFileRepository();
  assert.ok(repo.isAvailable());
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('loadUploadedFileOriginal', () => {
  it('reads an original of the chat scope and refuses other types and unknown ids', async () => {
    const { buffer } = await buildDocx({ title: 'T', markdown: '# Hi\n\nBody' });
    const file = await store('letter.docx', DOCX, buffer);

    const loaded = await loadUploadedFileOriginal({
      fileId: file.id,
      mimeTypes: [DOCX],
      user,
      chatId
    });
    assert.equal(loaded.name, 'letter.docx');
    assert.ok(loaded.buffer.equals(buffer));

    await assert.rejects(
      loadUploadedFileOriginal({ fileId: file.id, mimeTypes: [XLSX], user, chatId }),
      /not a Excel/
    );
    await assert.rejects(
      loadUploadedFileOriginal({ fileId: 'file_unknown', mimeTypes: [DOCX], user, chatId }),
      /No uploaded file/
    );
    // Another chat cannot reach it.
    await assert.rejects(
      loadUploadedFileOriginal({ fileId: file.id, mimeTypes: [DOCX], user, chatId: 'chat-other' }),
      /No uploaded file/
    );
  });

  it('finds files attached to the scheduled task of the current run', async () => {
    const { buffer } = await buildDocx({ title: 'T', markdown: 'Task template' });
    const file = await store('task.docx', DOCX, buffer, { type: 'task', id: 'task_abc123' });
    const loaded = await loadUploadedFileOriginal({
      fileId: file.id,
      mimeTypes: [DOCX],
      user: { ...user, scheduledRun: { taskId: 'task_abc123', runId: 'run_1' } },
      chatId: 'run-chat'
    });
    assert.equal(loaded.name, 'task.docx');
  });

  it('reports a discarded original instead of using it', async () => {
    const { buffer } = await buildDocx({ title: 'T', markdown: 'Old' });
    const file = await store('old.docx', DOCX, buffer);
    await repo.discardOriginal({ type: 'chat', id: chatId }, file.id, { reason: 'ttl_expired' });
    await assert.rejects(
      loadUploadedFileOriginal({ fileId: file.id, mimeTypes: [DOCX], user, chatId }),
      /no longer stored/
    );
  });

  it('lets an app with a pinned corporate template opt in to user templates', () => {
    assert.equal(userTemplateUploadsAllowed({}), true);
    assert.equal(userTemplateUploadsAllowed({ documentTemplate: 'corp' }), false);
    assert.equal(
      userTemplateUploadsAllowed({ documentTemplate: 'corp', allowUserTemplateUploads: true }),
      true
    );
    assert.equal(userTemplateUploadsAllowed({ allowUserTemplateUploads: false }), false);
  });
});

describe('create_docx with templateFileId', () => {
  it('defaults to styles_only: the old body goes, headers, footers and styles stay', async () => {
    clearHeldGeneratedFiles();
    // An uploaded report with text, a header and a footer, and no {{content}} marker.
    const { buffer: uploaded } = await buildDocx({
      title: 'Old report',
      markdown: '# Old heading\n\nOLD-BODY-TEXT that must not survive.',
      header: 'Acme Corp confidential',
      footer: 'Acme footer',
      pageNumbers: true
    });
    const file = await store('old-report.docx', DOCX, uploaded);

    const result = await runCreateDocx({
      filename: 'new-report',
      title: 'New report',
      markdown: '# New heading\n\nNEW-BODY-TEXT',
      templateFileId: file.id,
      user,
      chatId
    });
    assert.equal(result.success, true, result.error);
    const out = heldGeneratedFile(user, result.file.id, { chatId });
    const text = await bodyText(out.data);
    assert.match(text, /NEW-BODY-TEXT/);
    assert.doesNotMatch(text, /OLD-BODY-TEXT/);

    const zip = await JSZip.loadAsync(out.data);
    const parts = Object.keys(zip.files).filter(name =>
      /word\/(header|footer)\d*\.xml$/.test(name)
    );
    assert.ok(parts.length >= 2, 'headers/footers of the upload are kept');
    const headerText = (await Promise.all(parts.map(part => zip.file(part).async('string')))).join(
      ' '
    );
    assert.match(headerText, /Acme Corp confidential/);
  });

  it('append keeps the old body and adds the content after it', async () => {
    clearHeldGeneratedFiles();
    const { buffer: uploaded } = await buildDocx({
      title: 'Old',
      markdown: 'KEEP-ME paragraph.'
    });
    const file = await store('keep.docx', DOCX, uploaded);
    const result = await runCreateDocx({
      filename: 'appended',
      title: 'Appended',
      markdown: 'ADDED-PARAGRAPH',
      templateFileId: file.id,
      templateMode: 'append',
      user,
      chatId
    });
    assert.equal(result.success, true, result.error);
    const text = await bodyText(heldGeneratedFile(user, result.file.id, { chatId }).data);
    assert.ok(
      text.indexOf('KEEP-ME') >= 0 && text.indexOf('ADDED-PARAGRAPH') > text.indexOf('KEEP-ME')
    );
  });

  it('rejects unknown modes, wrong file types and unknown ids with a readable error', async () => {
    const { buffer } = await buildDocx({ title: 'x', markdown: 'x' });
    const file = await store('m.docx', DOCX, buffer);
    const base = { filename: 'f', title: 't', markdown: 'm', user, chatId };
    const badMode = await runCreateDocx({ ...base, templateFileId: file.id, templateMode: 'wipe' });
    assert.equal(badMode.success, false);
    assert.match(badMode.error, /templateMode/);
    const missing = await runCreateDocx({ ...base, templateFileId: 'file_nope' });
    assert.equal(missing.success, false);
    assert.match(missing.error, /No uploaded file/);
  });

  it('keeps the corporate template when the app pins one and does not opt in', async () => {
    clearHeldGeneratedFiles();
    const { buffer } = await buildDocx({ title: 'x', markdown: 'UPLOADED-ONLY' });
    const file = await store('pinned.docx', DOCX, buffer);
    const result = await runCreateDocx({
      filename: 'pinned',
      title: 'Pinned',
      markdown: 'NEW',
      templateFileId: file.id,
      appConfig: { documentTemplate: 'does-not-exist', allowUserTemplateUploads: false },
      user,
      chatId
    });
    assert.equal(result.success, true, result.error);
    assert.match((result.warnings || []).join(' '), /corporate document template/);
    assert.equal(result.templateFile, undefined);
  });
});

describe('create_pptx with templateFileId', () => {
  async function deck(slideCount) {
    const template = await buildBaseTemplate({ primaryColor: '#0f766e' });
    const slides = Array.from({ length: slideCount }, (_, i) => ({
      layout: 'content',
      title: `Existing ${i + 1}`,
      text: `- existing point ${i + 1}`
    }));
    return (await buildPptx({ title: 'Deck', slides }, { template })).buffer;
  }

  async function slideTitles(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort();
    const titles = [];
    for (const name of names) {
      const xml = await zip.file(name).async('string');
      titles.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join(' '));
    }
    return titles;
  }

  it('styles_only (default) builds on the uploaded master and drops its slides', async () => {
    clearHeldGeneratedFiles();
    const file = await store('corp.pptx', PPTX, await deck(3));
    const result = await runCreatePptx({
      filename: 'new-deck',
      title: 'New deck',
      slides: JSON.stringify([{ layout: 'content', title: 'Fresh slide', text: '- fresh' }]),
      templateFileId: file.id,
      user,
      chatId
    });
    assert.equal(result.success, true, result.error);
    const titles = await slideTitles(heldGeneratedFile(user, result.file.id, { chatId }).data);
    assert.equal(titles.length, 1);
    assert.match(titles[0], /Fresh slide/);
  });

  it('append keeps the existing slides and adds the new ones after them', async () => {
    clearHeldGeneratedFiles();
    const file = await store('corp2.pptx', PPTX, await deck(2));
    const result = await runCreatePptx({
      filename: 'appended-deck',
      title: 'Appended deck',
      slides: JSON.stringify([{ layout: 'content', title: 'Late slide', text: '- late' }]),
      templateFileId: file.id,
      templateMode: 'append',
      user,
      chatId
    });
    assert.equal(result.success, true, result.error);
    const out = heldGeneratedFile(user, result.file.id, { chatId }).data;
    const titles = await slideTitles(out);
    assert.equal(titles.length, 3);
    assert.match(titles[0], /Existing 1/);
    assert.match(titles[2], /Late slide/);
    // Slide ids stay unique so PowerPoint opens the file.
    const zip = await JSZip.loadAsync(out);
    const presentation = await zip.file('ppt/presentation.xml').async('string');
    const ids = [...presentation.matchAll(/<p:sldId [^>]*\bid="(\d+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 3);
  });
});

describe('PDF forms and letterhead', () => {
  it('lists and fills interactive form fields in place', async () => {
    const bytes = await pdfWithForm();
    const fields = await listPdfFormFields(bytes);
    assert.deepEqual(fields.map(f => `${f.name}:${f.type}`).sort(), [
      'Country:dropdown',
      'FullName:text',
      'Newsletter:checkbox'
    ]);

    const result = await fillPdfFormFields(bytes, {
      FullName: 'Jane Doe',
      Newsletter: 'yes',
      country: 'germany',
      Nope: 'x'
    });
    assert.deepEqual(result.filled.sort(), ['Country', 'FullName', 'Newsletter']);
    assert.deepEqual(result.unknown, ['Nope']);

    const filled = await PDFDocument.load(result.buffer);
    const form = filled.getForm();
    assert.equal(form.getTextField('FullName').getText(), 'Jane Doe');
    assert.equal(form.getCheckBox('Newsletter').isChecked(), true);
    assert.deepEqual(form.getDropdown('Country').getSelected(), ['Germany']);
  });

  it('refuses a PDF without a form, an empty value map and unknown-only fields', async () => {
    await assert.rejects(
      fillPdfFormFields(await plainPdf(), { A: 'b' }),
      /no fillable form fields/
    );
    await assert.rejects(fillPdfFormFields(await pdfWithForm(), {}), /no fields to fill/);
    await assert.rejects(
      fillPdfFormFields(await pdfWithForm(), { Missing: 'x' }),
      /None of the named fields.*FullName/
    );
  });

  it('flattens the form on request', async () => {
    const result = await fillPdfFormFields(
      await pdfWithForm(),
      { FullName: 'Flat' },
      { flatten: true }
    );
    const doc = await PDFDocument.load(result.buffer);
    assert.equal(doc.getForm().getFields().length, 0);
  });

  it('create_pdf fills the uploaded form when fillFormFields is given', async () => {
    clearHeldGeneratedFiles();
    const file = await store('form.pdf', 'application/pdf', await pdfWithForm());
    const result = await runCreatePdf({
      filename: 'form-filled',
      title: 'Form',
      templateFileId: file.id,
      fillFormFields: JSON.stringify({ FullName: 'Max Mustermann', Newsletter: true }),
      user,
      chatId
    });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.filledFields.sort(), ['FullName', 'Newsletter']);
    const out = heldGeneratedFile(user, result.file.id, { chatId });
    const doc = await PDFDocument.load(out.data);
    assert.equal(doc.getForm().getTextField('FullName').getText(), 'Max Mustermann');
  });

  it('create_pdf prints the new document on an uploaded PDF as letterhead', async () => {
    clearHeldGeneratedFiles();
    const stationery = await PDFDocument.create();
    const page = stationery.addPage([595.28, 841.89]);
    const font = await stationery.embedFont(StandardFonts.HelveticaBold);
    page.drawText('LETTERHEAD-MARK', { x: 50, y: 800, size: 12, font });
    const file = await store(
      'stationery.pdf',
      'application/pdf',
      Buffer.from(await stationery.save())
    );
    const result = await runCreatePdf({
      filename: 'letter',
      title: 'Letter',
      markdown: 'Dear reader,\n\nHello.',
      templateFileId: file.id,
      user,
      chatId
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.templateFile, 'stationery.pdf');
    const out = heldGeneratedFile(user, result.file.id, { chatId });
    const doc = await PDFDocument.load(out.data);
    const resources = doc.getPage(0).node.Resources();
    assert.ok(resources.get(resources.context.obj('XObject')), 'letterhead is an embedded page');
  });
});

describe('create_xlsx with sourceFileId', () => {
  async function uploadedWorkbook() {
    const { buffer } = await buildXlsx({
      title: 'Budget',
      brand: { primaryColor: '#7c3aed' },
      sheets: [
        {
          name: 'Budget',
          columns: ['Item', { header: 'Cost', format: 'currency' }],
          rows: [['Hosting', 1200]]
        },
        { name: 'Notes', columns: ['Note'], rows: [['keep this']] }
      ]
    });
    return buffer;
  }

  it('appends new sheets, replaces same-named ones and keeps the rest', async () => {
    const merged = await mergeIntoWorkbook(await uploadedWorkbook(), {
      brand: { primaryColor: '#0f766e' },
      sheets: [
        {
          name: 'budget',
          columns: ['Item', { header: 'Cost', format: 'currency' }],
          rows: [
            ['Licenses', 800],
            ['Total', '=SUM(B2:B2)']
          ]
        },
        {
          name: 'Forecast',
          columns: ['Month', { header: 'Value', format: 'percent' }],
          rows: [['Jan', 0.1]]
        }
      ]
    });
    assert.deepEqual(merged.added, ['Forecast']);
    assert.deepEqual(merged.replaced, ['Budget']);
    assert.equal(merged.sheets, 3);

    const zip = await JSZip.loadAsync(merged.buffer);
    const workbook = await zip.file('xl/workbook.xml').async('string');
    assert.deepEqual(
      [...workbook.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map(m => m[1]),
      ['Budget', 'Notes', 'Forecast']
    );
    assert.match(workbook, /fullCalcOnLoad="1"/);

    const sheetFiles = Object.keys(zip.files).filter(n =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
    );
    assert.equal(sheetFiles.length, 3);
    const all = (await Promise.all(sheetFiles.map(n => zip.file(n).async('string')))).join('\n');
    assert.match(all, /keep this/);
    assert.match(all, /Licenses/);
    assert.doesNotMatch(all, /Hosting/, 'the replaced sheet no longer has its old rows');

    // Every cell style index exists in the merged style sheet.
    const styles = await zip.file('xl/styles.xml').async('string');
    const xfCount = Number(/<cellXfs count="(\d+)"/.exec(styles)[1]);
    for (const m of all.matchAll(/<c [^>]*\bs="(\d+)"/g)) {
      assert.ok(Number(m[1]) < xfCount, `style ${m[1]} < ${xfCount}`);
    }
    // The upload's own styles come first and are untouched.
    const uploadedStyles = await (
      await JSZip.loadAsync(await uploadedWorkbook())
    )
      .file('xl/styles.xml')
      .async('string');
    const uploadedXfs = Number(/<cellXfs count="(\d+)"/.exec(uploadedStyles)[1]);
    assert.ok(xfCount > uploadedXfs);
  });

  it('drops a calculation chain that no longer matches the sheets', async () => {
    const source = await JSZip.loadAsync(await uploadedWorkbook());
    source.file(
      'xl/calcChain.xml',
      '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B2" i="1"/></calcChain>'
    );
    const rels = await source.file('xl/_rels/workbook.xml.rels').async('string');
    source.file(
      'xl/_rels/workbook.xml.rels',
      rels.replace(
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'
      )
    );
    const types = await source.file('[Content_Types].xml').async('string');
    source.file(
      '[Content_Types].xml',
      types.replace(
        '</Types>',
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'
      )
    );
    const buffer = await source.generateAsync({ type: 'nodebuffer' });
    const merged = await mergeIntoWorkbook(buffer, {
      sheets: [{ name: 'New', columns: ['A'], rows: [[1]] }]
    });
    const zip = await JSZip.loadAsync(merged.buffer);
    assert.equal(zip.file('xl/calcChain.xml'), null);
    assert.doesNotMatch(await zip.file('xl/_rels/workbook.xml.rels').async('string'), /calcChain/);
    assert.doesNotMatch(await zip.file('[Content_Types].xml').async('string'), /calcChain/);
  });

  it('runs through create_xlsx and reports what changed', async () => {
    clearHeldGeneratedFiles();
    const file = await store('budget.xlsx', XLSX, await uploadedWorkbook());
    const result = await runCreateXlsx({
      filename: 'budget-updated',
      title: 'Budget',
      sheets: JSON.stringify([{ name: 'Summary', columns: ['A'], rows: [[1]] }]),
      sourceFileId: file.id,
      user,
      chatId
    });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.addedSheets, ['Summary']);
    assert.deepEqual(result.replacedSheets, []);
    assert.match(result.message, /Updated the uploaded workbook "budget.xlsx"/);
    const out = heldGeneratedFile(user, result.file.id, { chatId });
    const zip = await JSZip.loadAsync(out.data);
    assert.match(await zip.file('xl/workbook.xml').async('string'), /name="Summary"/);
  });

  it('refuses a source file that is not a workbook', async () => {
    const { buffer } = await buildDocx({ title: 'x', markdown: 'x' });
    const file = await store('not-a-workbook.docx', DOCX, buffer);
    const result = await runCreateXlsx({
      filename: 'f',
      title: 't',
      sheets: JSON.stringify([{ name: 'S', columns: ['A'], rows: [[1]] }]),
      sourceFileId: file.id,
      user,
      chatId
    });
    assert.equal(result.success, false);
    assert.match(result.error, /not a Excel/);
  });
});

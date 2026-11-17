// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `edit_docx`, `edit_pptx`, `edit_xlsx`: a generated Word, PowerPoint or Excel
 * file carries the arguments it was made from, so a change is an edit of
 * those and a new render, not the whole document written again.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  SOURCE_PART,
  applySettings,
  applyTextEditsToStrings,
  embedSource,
  readSource,
  sourceViewOf
} from '../services/documents/editableSource.js';
import {
  DOCX_MIME,
  createDocx,
  docxSpecFromToolArgs,
  runCreateDocx,
  runEditDocx
} from '../services/documents/docx/docxTools.js';
import { runCreatePptx, runEditPptx } from '../services/documents/pptx/pptxTools.js';
import { runCreateXlsx, runEditXlsx } from '../services/documents/xlsx/xlsxTools.js';
import { applySlideChanges } from '../services/documents/pptx/pptxEdit.js';
import { applySheetChanges, columnIndexOf } from '../services/documents/xlsx/xlsxEdit.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile,
  holdGeneratedFile
} from '../services/documents/generatedFiles.js';
import { read as readChatArtifact } from '../tools/chatArtifacts.js';

const user = { id: 'u-office-edit' };
// Not a stored chat: the edits find the files held for this turn.
const chatId = 'agent:office-edit-test';
const ctx = { user, chatId };

function bytesOf(res) {
  return heldGeneratedFile(user, res.file.id, { chatId }).data;
}

async function sourceOf(res) {
  return readSource(bytesOf(res));
}

afterEach(() => clearHeldGeneratedFiles());

describe('the embedded source', () => {
  it('round-trips through a package as a custom XML part related to the main part', async () => {
    const { buffer } = await createDocx(docxSpecFromToolArgs({ markdown: 'Hello' }));
    const embedded = await embedSource(buffer, 'docx', {
      tool: 'create_docx',
      args: { markdown: 'Hello ü €', title: 'T' }
    });
    assert.deepEqual(await readSource(embedded), {
      tool: 'create_docx',
      args: { markdown: 'Hello ü €', title: 'T' }
    });
    const zip = await JSZip.loadAsync(embedded);
    assert.ok(zip.file(SOURCE_PART));
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    assert.match(rels, /relationships\/customXml" Target="\.\.\/customXml\/ihubSource\.xml"/);
    // Embedding twice keeps one relationship.
    const twice = await embedSource(embedded, 'docx', { tool: 'create_docx', args: {} });
    const rels2 = await (
      await JSZip.loadAsync(twice)
    )
      .file('word/_rels/document.xml.rels')
      .async('string');
    assert.equal(rels2.match(/rIdIhubSource/g).length, 1);
  });

  it('is absent from a file without it, and a broken buffer is left alone', async () => {
    const { buffer } = await createDocx(docxSpecFromToolArgs({ markdown: 'Hello' }));
    assert.equal(await readSource(buffer), null);
    assert.equal(await readSource(Buffer.from('not a zip')), null);
    const junk = Buffer.from('not a zip');
    assert.equal(await embedSource(junk, 'docx', { tool: 'x', args: {} }), junk);
  });

  it('is shown as Markdown or indented JSON', () => {
    assert.deepEqual(sourceViewOf({ tool: 'create_docx', args: { markdown: '# A' } }), {
      text: '# A',
      format: 'markdown',
      editTool: 'edit_docx'
    });
    const view = sourceViewOf({ tool: 'create_pptx', args: { slides: '[{"title":"A"}]' } });
    assert.equal(view.format, 'json');
    assert.match(view.text, /\n {4}"title": "A"/);
    assert.equal(sourceViewOf({ tool: 'create_pdf', args: {} }), null);
  });
});

describe('edit helpers', () => {
  it('replace a unique text inside the strings of a structure', () => {
    const slides = [{ title: 'Revenue 2025' }, { text: '- Revenue grew\n- Costs fell' }];
    assert.deepEqual(
      applyTextEditsToStrings(slides, [{ oldText: 'Costs fell', newText: 'Costs fell 4 %' }]),
      [{ title: 'Revenue 2025' }, { text: '- Revenue grew\n- Costs fell 4 %' }]
    );
    assert.equal(slides[1].text, '- Revenue grew\n- Costs fell', 'the input is not changed');
    assert.throws(
      () => applyTextEditsToStrings(slides, [{ oldText: 'Revenue', newText: 'Sales' }]),
      /occurs 2 times/
    );
    assert.throws(
      () => applyTextEditsToStrings(slides, [{ oldText: 'Profit', newText: 'x' }]),
      /does not occur/
    );
  });

  it('change only the settings a tool allows', () => {
    assert.deepEqual(
      applySettings({ title: 'A', toc: true }, { title: 'B', toc: null }, ['title', 'toc']),
      {
        title: 'B'
      }
    );
    assert.throws(
      () => applySettings({}, { markdown: 'x' }, ['title']),
      /cannot change "markdown"/
    );
    assert.throws(() => applySettings({}, '[1]', ['title']), /must be an object/);
  });

  it('apply slide operations in order, all or none', () => {
    const deck = [{ title: '1' }, { title: '2' }, { title: '3' }];
    const result = applySlideChanges(deck, [
      { op: 'update', slide: 2, set: { title: '2b', notes: 'n' } },
      { op: 'insert', after: 0, slide: { title: '0' } },
      { op: 'delete', slide: 4 },
      { op: 'move', slide: 3, to: 1 },
      { op: 'replace', slide: 2, with: { title: 'new' } }
    ]);
    assert.deepEqual(
      result.map(s => s.title),
      ['2b', 'new', '1']
    );
    assert.equal(result[0].notes, 'n');
    assert.deepEqual(
      deck.map(s => s.title),
      ['1', '2', '3']
    );
    assert.throws(() => applySlideChanges(deck, [{ op: 'delete', slide: 9 }]), /from 1 to 3/);
    assert.throws(
      () => applySlideChanges([{}], [{ op: 'delete', slide: 1 }]),
      /at least one slide/
    );
    assert.throws(() => applySlideChanges(deck, [{ op: 'swap' }]), /op must be one of/);
  });

  it('address cells as in Excel and keep row objects', () => {
    assert.equal(columnIndexOf('A'), 0);
    assert.equal(columnIndexOf('AA'), 26);
    const sheets = [
      {
        name: 'Summary',
        columns: [{ header: 'Region' }, { header: 'Q1', format: 'currency' }],
        rows: [['EMEA', 100], { cells: ['Total', '=SUM(B2:B2)'], total: true }]
      }
    ];
    const result = applySheetChanges(sheets, [
      { op: 'setCells', sheet: 'summary', cell: 'B1', values: [['Q1 (€)']] },
      { op: 'setCells', sheet: 1, cell: 'B2', values: [[120], ['=SUM(B2:B2)*1']] },
      { op: 'insertRows', sheet: 'Summary', before: 3, rows: [['APAC', 80]] },
      { op: 'setCells', sheet: 'Summary', cell: 'C5', values: [['new']] },
      { op: 'renameSheet', sheet: 'Summary', to: 'Overview' }
    ]);
    const [sheet] = result;
    assert.equal(sheet.name, 'Overview');
    assert.deepEqual(sheet.columns[1], { header: 'Q1 (€)', format: 'currency' });
    assert.deepEqual(sheet.rows[0], ['EMEA', 120]);
    assert.deepEqual(sheet.rows[1], ['APAC', 80]);
    // The total row stays an object; its cells are updated in place.
    assert.deepEqual(sheet.rows[2], { cells: ['Total', '=SUM(B2:B2)*1'], total: true });
    assert.deepEqual(sheet.rows[3], [null, null, 'new']);
    assert.equal(sheets[0].rows.length, 2, 'the input is not changed');
    assert.throws(
      () => applySheetChanges(sheets, [{ op: 'deleteRows', sheet: 'Summary', row: 1 }]),
      /row 1 is the header/
    );
    assert.throws(
      () =>
        applySheetChanges(sheets, [{ op: 'setCells', sheet: 'Nope', cell: 'A1', values: [[1]] }]),
      /no sheet "Nope"\. The workbook has: "Summary"/
    );
    assert.throws(
      () => applySheetChanges(sheets, [{ op: 'deleteSheet', sheet: 'Summary' }]),
      /at least one sheet/
    );
  });
});

describe('edit_docx', () => {
  it('changes the Markdown and the settings, keeps the name, the date and the earlier version', async () => {
    const created = await runCreateDocx({
      filename: 'report',
      title: 'Report',
      markdown: '# Summary\n\nRevenue grew 8 %.\n\n# Outlook\n\nStable.',
      ...ctx
    });
    assert.equal(created.success, true, created.error);
    const before = await sourceOf(created);
    assert.equal(before.tool, 'create_docx');
    assert.match(before.args.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(before.args.user, undefined, 'the trusted context is not stored');

    const edited = await runEditDocx({
      filename: 'report.docx',
      edits: [{ oldText: 'Revenue grew 8 %.', newText: 'Revenue grew 9 %.' }],
      set: { toc: true },
      ...ctx
    });
    assert.equal(edited.success, true, edited.error);
    assert.equal(edited.file.name, 'report.docx');
    assert.match(edited.message, /^Updated the Word document "report\.docx"/);
    const after = await sourceOf(edited);
    assert.match(after.args.markdown, /Revenue grew 9 %\./);
    assert.equal(after.args.toc, true);
    assert.equal(after.args.date, before.args.date);
    const xml = await (
      await JSZip.loadAsync(bytesOf(edited))
    )
      .file('word/document.xml')
      .async('string');
    assert.match(xml, /Revenue grew 9 %\./);
    assert.match((await sourceOf(created)).args.markdown, /8 %/, 'the earlier version stays');
  });

  it('is read back as its Markdown by chat_artifacts_read', async () => {
    await runCreateDocx({ filename: 'memo', title: 'Memo', markdown: 'Line one.', ...ctx });
    const res = await readChatArtifact({ artifact: 'memo.docx', ...ctx });
    assert.equal(res.text, 'Line one.');
    assert.equal(res.source, 'markdown');
    assert.match(res.note, /edit_docx/);
  });

  it('refuses a document without a source, and an edit that changes nothing', async () => {
    const { buffer } = await createDocx(docxSpecFromToolArgs({ markdown: 'Old' }));
    holdGeneratedFile({ user, chatId, data: buffer, mimeType: DOCX_MIME, name: 'old' });
    const res = await runEditDocx({
      filename: 'old.docx',
      edits: [{ oldText: 'Old', newText: 'New' }],
      ...ctx
    });
    assert.equal(res.success, false);
    assert.equal(res.code, 'not-editable');
    assert.match(res.error, /Create it again with create_docx/);

    await runCreateDocx({ filename: 'same', title: 'Same', markdown: 'Text.', ...ctx });
    const none = await runEditDocx({ filename: 'same.docx', set: { title: 'Same' }, ...ctx });
    assert.match(none.error, /change nothing/);
    const empty = await runEditDocx({ filename: 'same.docx', ...ctx });
    assert.match(empty.error, /Give "edits"/);
  });
});

describe('edit_pptx', () => {
  it('updates, inserts and deletes slides and replaces slide text', async () => {
    const created = await runCreatePptx({
      filename: 'deck',
      title: 'Deck',
      slides: JSON.stringify([
        { layout: 'title', title: 'Strategy 2027' },
        { layout: 'content', title: 'Revenue', text: '- Grew 8 %' },
        { layout: 'content', title: 'Costs', text: '- Fell' }
      ]),
      ...ctx
    });
    assert.equal(created.success, true, created.error);
    const edited = await runEditPptx({
      filename: 'deck.pptx',
      changes: [
        { op: 'update', slide: 2, set: { title: 'Revenue grew' } },
        {
          op: 'insert',
          after: 3,
          slide: { layout: 'content', title: 'Next steps', text: '- Hire' }
        },
        { op: 'delete', slide: 3 }
      ],
      edits: [{ oldText: 'Grew 8 %', newText: 'Grew 9 %' }],
      ...ctx
    });
    assert.equal(edited.success, true, edited.error);
    assert.equal(edited.file.name, 'deck.pptx');
    assert.equal(edited.file.slides, 3);
    assert.match(edited.message, /^Updated the presentation/);
    const { args } = await sourceOf(edited);
    assert.deepEqual(
      args.slides.map(s => s.title),
      ['Strategy 2027', 'Revenue grew', 'Next steps']
    );
    assert.equal(args.slides[1].text, '- Grew 9 %');
  });
});

describe('edit_xlsx', () => {
  it('sets cells and appends rows, keeping the other sheets as they were', async () => {
    const created = await runCreateXlsx({
      filename: 'budget',
      title: 'Budget',
      sheets: JSON.stringify([
        {
          name: 'Summary',
          columns: [{ header: 'Region' }, { header: 'Q1', format: 'currency' }],
          rows: [
            ['EMEA', 100],
            ['APAC', 80]
          ]
        },
        { name: 'Notes', columns: [{ header: 'Note' }], rows: [['Draft']] }
      ]),
      ...ctx
    });
    assert.equal(created.success, true, created.error);
    const edited = await runEditXlsx({
      filename: 'budget.xlsx',
      changes: [
        { op: 'setCells', sheet: 'Summary', cell: 'B3', values: [[95]] },
        {
          op: 'appendRows',
          sheet: 'Summary',
          rows: [{ cells: ['Total', '=SUM(B2:B3)'], total: true }]
        }
      ],
      edits: [{ oldText: 'Draft', newText: 'Final' }],
      ...ctx
    });
    assert.equal(edited.success, true, edited.error);
    assert.equal(edited.file.name, 'budget.xlsx');
    assert.match(edited.message, /^Updated the Excel workbook/);
    const { args } = await sourceOf(edited);
    assert.deepEqual(args.sheets[0].rows, [
      ['EMEA', 100],
      ['APAC', 95],
      { cells: ['Total', '=SUM(B2:B3)'], total: true }
    ]);
    assert.deepEqual(args.sheets[1].rows, [['Final']]);
    const sheetXml = await (
      await JSZip.loadAsync(bytesOf(edited))
    )
      .file('xl/worksheets/sheet1.xml')
      .async('string');
    assert.match(sheetXml, /SUM\(B2:B3\)/);
  });

  it('says which sheets exist when one is misnamed, and changes nothing', async () => {
    await runCreateXlsx({
      filename: 'book',
      sheets: JSON.stringify([{ name: 'Data', columns: [{ header: 'A' }], rows: [[1]] }]),
      ...ctx
    });
    const res = await runEditXlsx({
      filename: 'book.xlsx',
      changes: [{ op: 'appendRows', sheet: 'Summary', rows: [[2]] }],
      ...ctx
    });
    assert.equal(res.success, false);
    assert.match(res.error, /no sheet "Summary"\. The workbook has: "Data"/);
  });
});

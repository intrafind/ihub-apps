// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Excel workbook engine (`services/documents/xlsx`) and PPTX KPI metric cards:
 * SpreadsheetML generation, corporate template styling, live formulas and
 * `_xlfn.` prefixing, worker rendering, and PPTX `metricCards`.
 *
 * Run: node --test server/tests/xlsx-engine.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import JSZip from 'jszip';

import { documentTemplateSchema } from '../validators/documentTemplateSchema.js';
import { applyTemplateToXlsxSpec } from '../services/documents/templates/applyTemplate.js';
import {
  buildXlsx,
  columnLetter,
  normalizeFormula,
  sanitizeSheets
} from '../services/documents/xlsx/buildXlsx.js';
import { renderXlsx } from '../services/documents/xlsx/renderXlsx.js';
import { runCreateXlsx, xlsxSpecFromToolArgs } from '../services/documents/xlsx/xlsxTools.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile
} from '../services/documents/generatedFiles.js';
import { EMU_PER_INCH, metricCards } from '../services/documents/pptx/pptxXml.js';
import {
  injectBrandTokens,
  inspectWebArtifact,
  runCreateWebArtifact
} from '../services/documents/webArtifacts/webArtifactTools.js';
import { assemblePdfText, formatFormAnnotations } from '../../shared/documentExtraction/pdfText.js';

async function assertPackageIntegrity(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const types = await zip.file('[Content_Types].xml').async('string');
  const defaults = new Set(
    [...types.matchAll(/Extension="([^"]+)"/g)].map(m => m[1].toLowerCase())
  );
  const overrides = new Set([...types.matchAll(/PartName="([^"]+)"/g)].map(m => m[1]));
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir || name === '[Content_Types].xml') continue;
    const ext = name.split('.').pop().toLowerCase();
    assert.ok(overrides.has(`/${name}`) || defaults.has(ext), `part ${name} has no content type`);
    if (!name.endsWith('.rels')) continue;
    const owner = name === '_rels/.rels' ? '' : name.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2');
    const dir = owner.includes('/') ? owner.slice(0, owner.lastIndexOf('/')) : '';
    const xml = await entry.async('string');
    for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = match[0];
      if (/TargetMode="External"/.test(tag)) continue;
      const target = /Target="([^"]+)"/.exec(tag)[1];
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(dir, target));
      assert.ok(zip.file(resolved), `${name} points at missing ${resolved}`);
    }
  }
  return zip;
}

const VALID_TEMPLATE = {
  id: 'acme',
  name: { en: 'ACME' },
  brand: { primaryColor: '#E30613', bodyFont: 'Brand Serif', companyName: 'ACME GmbH' },
  document: { header: '{title}', footer: '{company} · Internal' }
};

describe('Excel workbook engine (xlsx)', () => {
  it('converts column indices and normalizes modern Excel formulas with _xlfn.', () => {
    assert.equal(columnLetter(0), 'A');
    assert.equal(columnLetter(25), 'Z');
    assert.equal(columnLetter(26), 'AA');
    assert.equal(
      normalizeFormula('=XLOOKUP(A2, B2:B10, C2:C10)'),
      '_xlfn.XLOOKUP(A2, B2:B10, C2:C10)'
    );
    assert.equal(
      normalizeFormula('=ifs(D2>0.15,"High",TRUE,"Core")'),
      '_xlfn.IFS(D2>0.15,"High",TRUE,"Core")'
    );
    // Already prefixed or classic functions stay untouched.
    assert.equal(normalizeFormula('=_xlfn.XLOOKUP(A2,B:B,C:C)'), '_xlfn.XLOOKUP(A2,B:B,C:C)');
    assert.equal(normalizeFormula('=SUMIFS(C2:C10,A2:A10,"EMEA")'), 'SUMIFS(C2:C10,A2:A10,"EMEA")');
  });

  it('sanitizes sheet names, deduplicates case-insensitively and enforces limits', () => {
    const warnings = [];
    const sheets = sanitizeSheets(
      [
        { name: 'Summary: 2026/2027?*[Draft]', columns: ['A'], rows: [[1]] },
        { name: 'summary  2026 2027   draft', columns: ['A'], rows: [[2]] }
      ],
      warnings
    );
    assert.equal(sheets[0].name, 'Summary 2026 2027 Draft');
    assert.equal(sheets[1].name, 'summary 2026 2027 draft (2)');
    assert.throws(() => xlsxSpecFromToolArgs({ title: 'T', sheets: '[]' }), /non-empty/);
  });

  it('builds multi-sheet workbooks with corporate brand styles, live formulas and _xlfn prefixes', async () => {
    const { spec } = applyTemplateToXlsxSpec(
      {
        title: 'Financial Model',
        language: 'en-US',
        sheets: [
          {
            name: 'Summary: 2026/2027?',
            columns: [
              { header: 'Region', align: 'left' },
              { header: '2025 (€)', format: 'currency' },
              { header: '2026 (€)', format: 'currency' },
              { header: 'Growth', format: 'percent' },
              { header: 'Tier', format: 'text' },
              { header: 'Updated', format: 'date' }
            ],
            rows: [
              [
                'EMEA',
                120000,
                144000,
                '=(C2-B2)/B2',
                '=IFS(D2>0.15,"High",TRUE,"Core")',
                '2026-10-15'
              ],
              [
                'APAC',
                80000,
                96000,
                '=(C3-B3)/B3',
                '=IFS(D3>0.15,"High",TRUE,"Core")',
                '2026-10-15'
              ],
              {
                cells: ['Total', '=SUM(B2:B3)', '=SUM(C2:C3)', '=(C4-B4)/B4', '', ''],
                total: true
              }
            ]
          },
          {
            name: 'Assumptions',
            columns: ['Driver', { header: 'Value', format: 'percent' }],
            rows: [{ cells: ['Target Growth', 0.15], assumption: true }]
          }
        ]
      },
      { template: documentTemplateSchema.parse(VALID_TEMPLATE), assets: {} }
    );
    const { buffer, meta, warnings } = await renderXlsx(spec);
    assert.equal(meta.sheets, 2);
    assert.deepEqual(warnings, []);
    const zip = await assertPackageIntegrity(buffer);
    const workbook = await zip.file('xl/workbook.xml').async('string');
    assert.match(workbook, /name="Summary 2026 2027"/);
    assert.match(workbook, /name="Assumptions"/);
    assert.match(workbook, /fullCalcOnLoad="1"/);
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(sheet, /<f>\(C2-B2\)\/B2<\/f>/);
    assert.match(sheet, /<f>_xlfn\.IFS\(D2&gt;0\.15,&quot;High&quot;,TRUE,&quot;Core&quot;\)<\/f>/);
    assert.match(sheet, /<f>SUM\(B2:B3\)<\/f>/);
    // AutoFilter covers header + data rows (A1:F3), excluding the trailing Total row on row 4.
    assert.match(sheet, /<autoFilter ref="A1:F3"\/>/);
    const styles = await zip.file('xl/styles.xml').async('string');
    assert.match(styles, /FFE30613/);
    assert.match(styles, /FF0000FF/);
  });

  it('runs create_xlsx in the worker and holds the .xlsx file for the chat', async () => {
    clearHeldGeneratedFiles();
    const user = { id: 'u-xlsx' };
    const res = await runCreateXlsx({
      filename: 'q3-budget',
      title: 'Q3 Budget',
      sheets: JSON.stringify([
        {
          name: 'Budget',
          columns: ['Item', { header: 'Cost', format: 'currency' }],
          rows: [
            ['Hosting', 1200],
            ['Licenses', 800],
            ['Total', '=SUM(B2:B3)']
          ]
        }
      ]),
      user,
      chatId: 'chat-xlsx'
    });
    assert.equal(res.success, true, res.error);
    assert.equal(res.file.name, 'q3-budget.xlsx');
    assert.equal(res.file.sheets, 1);
    const held = heldGeneratedFile(user, res.file.id, { chatId: 'chat-xlsx' });
    assert.equal(
      held.mimeType,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    await assertPackageIntegrity(held.data);
  });
});

describe('PPTX KPI metric cards', () => {
  it('renders 1–4 side-by-side DrawingML KPI callout cards with accent1 scheme colors', () => {
    let id = 10;
    const shapes = metricCards({
      nextId: () => (id += 1),
      rect: { x: 0, y: 0, cx: 10 * EMU_PER_INCH, cy: 2 * EMU_PER_INCH },
      metrics: [
        { value: '€3.05M', label: 'Q3 Revenue', note: '+12 % YoY' },
        { value: '98.4 %', label: 'Net Retention', note: '+1.2 pp' }
      ],
      lang: 'en-US'
    });
    assert.equal(shapes.length, 2);
    assert.match(shapes[0], /€3\.05M/);
    assert.match(shapes[0], /Q3 Revenue/);
    assert.match(shapes[0], /\+12 % YoY/);
    assert.match(shapes[0], /<a:schemeClr val="accent1"\/>/);
  });
});

describe('Web artifacts skill tool (create_web_artifact) & PDF AcroForm extraction', () => {
  it('injects corporate brand CSS custom properties and flags sandbox hazards', async () => {
    const rawHtml =
      '<!DOCTYPE html><html><head><title>Dashboard</title></head><body><h1>KPIs</h1></body></html>';
    const themed = injectBrandTokens(rawHtml, {
      primaryColor: '#E30613',
      accentColor: '#0F766E',
      font: 'Inter'
    });
    assert.match(themed, /--brand-primary:\s*#E30613/);
    assert.match(themed, /--brand-accent:\s*#0F766E/);
    assert.match(themed, /--brand-font:\s*Inter/);

    const warnings = inspectWebArtifact(
      '<!DOCTYPE html><html><body><script src="./app.js"></script><script>localStorage.setItem("k","v")</script></body></html>',
      'html'
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /Relative <script src=/);
    assert.match(warnings[1], /localStorage/);

    clearHeldGeneratedFiles();
    const user = { id: 'u-web' };
    const res = await runCreateWebArtifact({
      filename: 'roi-simulator.html',
      title: 'ROI Simulator',
      content: rawHtml,
      primaryColor: '#1d4ed8',
      user,
      chatId: 'chat-web'
    });
    assert.equal(res.success, true);
    assert.equal(res.file.name, 'roi-simulator.html');
    assert.equal(res.file.mimeType, 'text/plain');
    const held = heldGeneratedFile(user, res.file.id, { chatId: 'chat-web' });
    assert.match(held.data.toString('utf8'), /--brand-primary:\s*#1d4ed8/);
  });

  it('extracts AcroForm widget fields (text, checkbox, radio, choice) from uploaded PDF pages', () => {
    const blocks = formatFormAnnotations([
      { subtype: 'Widget', fieldName: 'FullName', fieldType: 'Tx', fieldValue: 'Jane Doe' },
      { subtype: 'Widget', fieldName: 'ApproveTerms', checkBox: true, fieldValue: 'Yes' },
      { subtype: 'Widget', fieldName: 'Newsletter', checkBox: true, fieldValue: 'Off' },
      {
        subtype: 'Widget',
        fieldName: 'Department',
        fieldType: 'Ch',
        fieldValue: 'Engineering',
        options: [{ displayValue: 'Engineering' }, { displayValue: 'Finance' }]
      }
    ]);
    assert.equal(blocks[0].text, '[Form fields]');
    assert.equal(blocks[1].text, '- FullName [text]: Jane Doe');
    assert.equal(blocks[2].text, '- ApproveTerms [checkbox]: checked');
    assert.equal(blocks[3].text, '- Newsletter [checkbox]: unchecked');
    assert.equal(
      blocks[4].text,
      '- Department [choice]: Engineering (options: Engineering, Finance)'
    );

    const text = assemblePdfText([
      {
        items: [{ str: 'Onboarding Form', hasEOL: true }],
        annotations: [
          { subtype: 'Widget', fieldName: 'FullName', fieldType: 'Tx', fieldValue: 'Jane Doe' }
        ]
      }
    ]);
    assert.match(text, /\[Form fields\]/);
    assert.match(text, /- FullName \[text\]: Jane Doe/);
  });
});

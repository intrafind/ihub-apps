// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import JSZip from 'jszip';
import { officeFontName } from '../officeFonts.js';
import {
  ContentTypes,
  INVALID_XML_CHARS,
  parseXml,
  REL_TYPES,
  setCoreProperties,
  writePackage,
  writeRels,
  xmlEscape
} from '../ooxml/opcPackage.js';
import { luminance } from '../pptx/pptxXml.js';

/**
 * Pure OOXML SpreadsheetML (.xlsx) builder.
 *
 * Writes multi-sheet Excel workbooks with corporate brand styling, frozen
 * headers, auto-filters, auto-fitted column widths, typed cells (numbers,
 * booleans, ISO dates, inline strings) and live formulas (`=SUM(...)`, etc.)
 * with `fullCalcOnLoad="1"` so Excel, LibreOffice Calc and Numbers calculate
 * every formula on open.
 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const SML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const WORKSHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';
const EXTENDED_PROPS_TYPE = 'application/vnd.openxmlformats-officedocument.extended-properties+xml';
const EXTENDED_PROPS_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties';

export const WORKBOOK_LIMITS = Object.freeze({
  maxSheets: 20,
  maxColumns: 60,
  maxRowsPerSheet: 5000,
  maxCellChars: 4000,
  maxHeaderChars: 200,
  maxFormulaChars: 1000
});

/**
 * Functions added after the original OOXML (Excel 2007) specification require
 * an `_xlfn.` prefix in SpreadsheetML `<f>` elements so Excel does not flag
 * them as `#NAME?` on open.
 */
const XLFN_FUNCTIONS =
  /\b(?<!_xlfn\.)(IFS|SWITCH|TEXTJOIN|CONCAT|MAXIFS|MINIFS|XLOOKUP|XMATCH|UNIQUE|SORT|SORTBY|FILTER)\s*\(/gi;

const BUILTIN_FORMATS = Object.freeze({
  general: 0,
  text: 49,
  integer: 164,
  decimal: 165,
  currency: 166,
  percent: 167,
  date: 168
});

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TOTAL_LABEL_RE = /^(total|gesamt|summe|subtotal|zwischensumme)\b/i;

function cleanText(value, max) {
  return String(value ?? '')
    .replace(INVALID_XML_CHARS, '')
    .trim()
    .slice(0, max);
}

function normalizeHex(hex, fallback) {
  const clean = String(hex || '')
    .trim()
    .replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : fallback;
}

/** Mix a 6-digit hex colour with white (`weight` 0..1 of the colour). */
function tintHex(hex, weight) {
  const base = normalizeHex(hex, '1E3A8A');
  const mix = offset => {
    const channel = Number.parseInt(base.slice(offset, offset + 2), 16);
    const blended = Math.round(255 * (1 - weight) + channel * weight);
    return Math.max(0, Math.min(255, blended)).toString(16).padStart(2, '0').toUpperCase();
  };
  return `${mix(0)}${mix(2)}${mix(4)}`;
}

/** 0-based column index → Excel column letters (`0` → `A`, `26` → `AA`). */
export function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Convert `YYYY-MM-DD` to an Excel 1900-system serial date number.
 * Returns `null` if the date is out of range or invalid.
 */
function isoToExcelSerial(value) {
  const match = ISO_DATE_RE.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  // Excel's 1900 epoch is 1899-12-30 UTC because of the Lotus 1-2-3 leap-year bug.
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((utc - epoch) / 86400000);
}

/**
 * Normalize an Excel formula: strip leading `=`, strip invalid XML chars, and
 * prefix modern Excel functions (`XLOOKUP`, `IFS`, `MAXIFS`, …) with `_xlfn.`.
 */
export function normalizeFormula(raw) {
  const body = String(raw || '')
    .replace(INVALID_XML_CHARS, '')
    .trim()
    .replace(/^=+/, '')
    .slice(0, WORKBOOK_LIMITS.maxFormulaChars);
  return body.replace(XLFN_FUNCTIONS, (_, fn) => `_xlfn.${fn.toUpperCase()}(`);
}

function sanitizeSheetName(raw, index, usedLower) {
  const cleaned = String(raw ?? '')
    .replace(INVALID_XML_CHARS, '')
    .replaceAll(/[:\\/?*[\]]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31);
  const base = cleaned || `Sheet ${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (usedLower.has(candidate.toLowerCase())) {
    const tag = ` (${suffix})`;
    candidate = `${base.slice(0, 31 - tag.length)}${tag}`;
    suffix += 1;
  }
  usedLower.add(candidate.toLowerCase());
  return candidate;
}

function sanitizeColumn(col, index) {
  if (typeof col === 'string' || typeof col === 'number') {
    return {
      header: cleanText(col, WORKBOOK_LIMITS.maxHeaderChars) || `Column ${index + 1}`,
      format: 'general',
      align: null,
      width: null
    };
  }
  const obj = col && typeof col === 'object' ? col : {};
  const header =
    cleanText(obj.header ?? obj.name ?? obj.title ?? obj.label, WORKBOOK_LIMITS.maxHeaderChars) ||
    `Column ${index + 1}`;
  const rawFormat = typeof obj.format === 'string' ? obj.format.trim() : 'general';
  const align = ['left', 'right', 'center'].includes(obj.align) ? obj.align : null;
  const width = Number(obj.width);
  return {
    header,
    format: rawFormat || 'general',
    align,
    width: Number.isFinite(width) && width >= 4 && width <= 80 ? width : null
  };
}

/**
 * Sanitize and normalize the `sheets` array from the model.
 *
 * @param {unknown} sheets
 * @param {string[]} warnings
 */
export function sanitizeSheets(sheets, warnings) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('The workbook has no sheets. Provide "sheets".');
  }
  if (sheets.length > WORKBOOK_LIMITS.maxSheets) {
    warnings.push(`Only the first ${WORKBOOK_LIMITS.maxSheets} sheets were kept.`);
  }
  const usedNames = new Set();
  return sheets.slice(0, WORKBOOK_LIMITS.maxSheets).map((rawSheet, sheetIndex) => {
    const source = rawSheet && typeof rawSheet === 'object' ? rawSheet : {};
    const name = sanitizeSheetName(source.name ?? source.title, sheetIndex, usedNames);
    const rawCols = Array.isArray(source.columns)
      ? source.columns
      : Array.isArray(source.headers)
        ? source.headers
        : [];
    const rawRows = Array.isArray(source.rows) ? source.rows : [];
    if (rawRows.length > WORKBOOK_LIMITS.maxRowsPerSheet) {
      warnings.push(`Sheet "${name}": truncated to ${WORKBOOK_LIMITS.maxRowsPerSheet} rows.`);
    }
    const cappedRows = rawRows.slice(0, WORKBOOK_LIMITS.maxRowsPerSheet);
    const maxRowWidth = cappedRows.reduce((max, row) => {
      const cells = Array.isArray(row) ? row : Array.isArray(row?.cells) ? row.cells : [];
      return Math.max(max, cells.length);
    }, 0);
    const colCount = Math.min(WORKBOOK_LIMITS.maxColumns, Math.max(rawCols.length, maxRowWidth, 1));
    const hasHeader = rawCols.length > 0;
    const columns = Array.from({ length: colCount }, (_, c) =>
      sanitizeColumn(rawCols[c] ?? `Column ${c + 1}`, c)
    );

    const rows = cappedRows.map((rawRow, rIdx) => {
      const isObj = rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow);
      const rawCells = Array.isArray(rawRow)
        ? rawRow
        : Array.isArray(rawRow?.cells)
          ? rawRow.cells
          : [];
      const firstCellStr = String(rawCells[0]?.value ?? rawCells[0] ?? '').trim();
      const isLastRow = rIdx === cappedRows.length - 1;
      const isTotal =
        Boolean(
          isObj && (rawRow.total || rawRow.style === 'total' || rawRow.style === 'subtotal')
        ) ||
        (source.totalRow === true && isLastRow) ||
        TOTAL_LABEL_RE.test(firstCellStr);
      const isAssumption = Boolean(
        isObj && (rawRow.assumption || rawRow.input || rawRow.style === 'assumption')
      );
      const cells = Array.from({ length: colCount }, (_, c) => rawCells[c] ?? null);
      return { cells, isTotal, isAssumption };
    });

    return {
      name,
      hasHeader,
      columns,
      rows,
      freezeHeader: source.freezeHeader !== false && hasHeader,
      autoFilter: source.autoFilter !== false && hasHeader && rows.length >= 2,
      showGridLines: source.showGridLines !== false
    };
  });
}

/**
 * Style table registry: assigns deterministic `xf` indices for combinations of
 * row role (`header`, `even`, `odd`, `total`, `assumption`), horizontal
 * alignment (`l`, `r`, `ctr`) and number format id (`numFmtId`).
 */
class StyleRegistry {
  constructor({ primaryColor, textColor, font }) {
    this.primaryColor = normalizeHex(primaryColor, '1E3A8A');
    this.textColor = normalizeHex(textColor, '0F172A');
    this.font = officeFontName(font, 'Calibri');
    this.customFormats = new Map([
      [BUILTIN_FORMATS.integer, '#,##0'],
      [BUILTIN_FORMATS.decimal, '#,##0.00'],
      [BUILTIN_FORMATS.currency, '#,##0.00'],
      [BUILTIN_FORMATS.percent, '0.0%'],
      [BUILTIN_FORMATS.date, 'yyyy-mm-dd']
    ]);
    this.customFormatByCode = new Map();
    for (const [id, code] of this.customFormats) {
      this.customFormatByCode.set(code, id);
    }
    this.nextNumFmtId = 169;
    // xf 0 is always the default unstyled cell required by SpreadsheetML.
    this.xfs = [{ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, align: null }];
    this.xfIndexByKey = new Map();
  }

  numFmtIdFor(format) {
    const key = String(format || 'general')
      .trim()
      .toLowerCase();
    if (Object.hasOwn(BUILTIN_FORMATS, key)) return BUILTIN_FORMATS[key];
    const code = String(format || '')
      .trim()
      .slice(0, 60);
    if (!code) return 0;
    if (this.customFormatByCode.has(code)) return this.customFormatByCode.get(code);
    const id = this.nextNumFmtId;
    this.nextNumFmtId += 1;
    this.customFormats.set(id, code);
    this.customFormatByCode.set(code, id);
    return id;
  }

  styleIndex({ role, numFmtId = 0, align = null }) {
    const key = `${role}|${numFmtId}|${align || ''}`;
    if (this.xfIndexByKey.has(key)) return this.xfIndexByKey.get(key);
    let fontId = 0;
    let fillId = 0;
    let borderId = 1;
    if (role === 'header') {
      fontId = 1;
      fillId = 2;
      borderId = 3;
    } else if (role === 'total') {
      fontId = 2;
      fillId = 4;
      borderId = 2;
    } else if (role === 'assumption') {
      fontId = 3;
      fillId = 0;
      borderId = 1;
    } else if (role === 'band') {
      fontId = 0;
      fillId = 3;
      borderId = 1;
    }
    const index = this.xfs.length;
    this.xfs.push({ numFmtId, fontId, fillId, borderId, align });
    this.xfIndexByKey.set(key, index);
    return index;
  }

  toXml() {
    const headerText = luminance(this.primaryColor) > 0.55 ? '0F172A' : 'FFFFFF';
    const bandFill = tintHex(this.primaryColor, 0.06);
    const totalFill = tintHex(this.primaryColor, 0.14);
    const fontName = xmlEscape(this.font);

    const numFmtsXml = [...this.customFormats.entries()]
      .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`)
      .join('');

    const fontsXml = [
      `<font><sz val="11"/><color rgb="FF${this.textColor}"/><name val="${fontName}"/></font>`,
      `<font><b/><sz val="11"/><color rgb="FF${headerText}"/><name val="${fontName}"/></font>`,
      `<font><b/><sz val="11"/><color rgb="FF${this.textColor}"/><name val="${fontName}"/></font>`,
      `<font><sz val="11"/><color rgb="FF0000FF"/><name val="${fontName}"/></font>`
    ].join('');

    const fillsXml = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${this.primaryColor}"/><bgColor indexed="64"/></patternFill></fill>`,
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${bandFill}"/><bgColor indexed="64"/></patternFill></fill>`,
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${totalFill}"/><bgColor indexed="64"/></patternFill></fill>`
    ].join('');

    const bordersXml = [
      '<border><left/><right/><top/><bottom/><diagonal/></border>',
      '<border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>',
      `<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FF${this.primaryColor}"/></top><bottom style="double"><color rgb="FF${this.primaryColor}"/></bottom><diagonal/></border>`,
      `<border><left style="thin"><color rgb="FF${this.primaryColor}"/></left><right style="thin"><color rgb="FF${this.primaryColor}"/></right><top style="thin"><color rgb="FF${this.primaryColor}"/></top><bottom style="medium"><color rgb="FF${this.primaryColor}"/></bottom><diagonal/></border>`
    ].join('');

    const cellXfsXml = this.xfs
      .map(xf => {
        const attrs = [
          `numFmtId="${xf.numFmtId}"`,
          `fontId="${xf.fontId}"`,
          `fillId="${xf.fillId}"`,
          `borderId="${xf.borderId}"`,
          'xfId="0"'
        ];
        if (xf.numFmtId > 0) attrs.push('applyNumberFormat="1"');
        if (xf.fontId > 0) attrs.push('applyFont="1"');
        if (xf.fillId > 0) attrs.push('applyFill="1"');
        if (xf.borderId > 0) attrs.push('applyBorder="1"');
        if (xf.align) {
          attrs.push('applyAlignment="1"');
          return `<xf ${attrs.join(' ')}><alignment horizontal="${xf.align}" vertical="center"/></xf>`;
        }
        return `<xf ${attrs.join(' ')}><alignment vertical="center"/></xf>`;
      })
      .join('');

    return (
      `${XML_HEAD}<styleSheet xmlns="${SML_NS}">` +
      `<numFmts count="${this.customFormats.size}">${numFmtsXml}</numFmts>` +
      `<fonts count="4">${fontsXml}</fonts>` +
      `<fills count="5">${fillsXml}</fills>` +
      `<borders count="4">${bordersXml}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${cellXfsXml}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

function classifyCell(rawCell, colFormat) {
  if (rawCell === null || rawCell === undefined || rawCell === '') {
    return { kind: 'empty', displayLength: 0 };
  }
  const isObj = rawCell && typeof rawCell === 'object' && !Array.isArray(rawCell);
  const rawFormula = isObj && typeof rawCell.formula === 'string' ? rawCell.formula : null;
  const val = isObj ? rawCell.value : rawCell;
  const cellFormat = isObj && typeof rawCell.format === 'string' ? rawCell.format : colFormat;
  const isInput = Boolean(isObj && (rawCell.input || rawCell.assumption));

  if (rawFormula || (typeof val === 'string' && val.trim().startsWith('='))) {
    const formula = normalizeFormula(rawFormula || val);
    if (formula) {
      return {
        kind: 'formula',
        formula,
        format: cellFormat,
        isInput: false,
        displayLength: 12
      };
    }
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    const fmt =
      cellFormat === 'general' ? (Number.isInteger(val) ? 'integer' : 'decimal') : cellFormat;
    return {
      kind: 'number',
      value: val,
      format: fmt,
      isInput,
      displayLength: String(val).length + 3
    };
  }
  if (typeof val === 'boolean') {
    return {
      kind: 'boolean',
      value: val ? 1 : 0,
      format: 'general',
      isInput,
      displayLength: 5
    };
  }
  const str = cleanText(val, WORKBOOK_LIMITS.maxCellChars);
  if (!str) return { kind: 'empty', displayLength: 0 };

  if (cellFormat === 'date' || ISO_DATE_RE.test(str)) {
    const serial = isoToExcelSerial(str);
    if (serial !== null) {
      return {
        kind: 'number',
        value: serial,
        format: 'date',
        isInput,
        displayLength: 10
      };
    }
  }
  return {
    kind: 'string',
    value: str,
    format: 'text',
    isInput,
    displayLength: Math.min(str.length, 44)
  };
}

function buildWorksheetXml(sheet, styles) {
  const { columns, rows, hasHeader } = sheet;
  const colCount = columns.length;
  const colMaxLengths = columns.map(col => (hasHeader ? col.header.length + 4 : 8));
  const rowXmlList = [];
  let currentRowNumber = 1;

  if (hasHeader) {
    const headerCells = columns
      .map((col, cIdx) => {
        const ref = `${columnLetter(cIdx)}1`;
        const align =
          col.align ||
          (['currency', 'integer', 'decimal', 'percent'].includes(col.format) ? 'right' : 'left');
        const styleIdx = styles.styleIndex({ role: 'header', numFmtId: 0, align });
        return `<c r="${ref}" t="inlineStr" s="${styleIdx}"><is><t xml:space="preserve">${xmlEscape(col.header)}</t></is></c>`;
      })
      .join('');
    rowXmlList.push(`<row r="1" ht="24" customHeight="1">${headerCells}</row>`);
    currentRowNumber = 2;
  }

  rows.forEach((row, rIdx) => {
    const rowNumber = currentRowNumber + rIdx;
    const baseRole = row.isTotal
      ? 'total'
      : row.isAssumption
        ? 'assumption'
        : rIdx % 2 === 1
          ? 'band'
          : 'body';
    const cellsXml = row.cells
      .map((rawCell, cIdx) => {
        const col = columns[cIdx];
        const cell = classifyCell(rawCell, col.format);
        colMaxLengths[cIdx] = Math.max(colMaxLengths[cIdx], cell.displayLength);
        const ref = `${columnLetter(cIdx)}${rowNumber}`;
        const fmtName =
          cell.kind === 'formula' && col.format === 'general' && cIdx > 0
            ? 'decimal'
            : cell.format || col.format;
        const numFmtId = styles.numFmtIdFor(fmtName);
        const align =
          col.align ||
          (cell.kind === 'number' ||
          cell.kind === 'formula' ||
          ['currency', 'integer', 'decimal', 'percent'].includes(col.format)
            ? 'right'
            : cell.kind === 'boolean'
              ? 'center'
              : 'left');
        const role = cell.isInput && baseRole !== 'total' ? 'assumption' : baseRole;
        const styleIdx = styles.styleIndex({ role, numFmtId, align });

        if (cell.kind === 'empty') {
          return `<c r="${ref}" s="${styleIdx}"/>`;
        }
        if (cell.kind === 'number') {
          return `<c r="${ref}" s="${styleIdx}"><v>${cell.value}</v></c>`;
        }
        if (cell.kind === 'boolean') {
          return `<c r="${ref}" t="b" s="${styleIdx}"><v>${cell.value}</v></c>`;
        }
        if (cell.kind === 'formula') {
          return `<c r="${ref}" s="${styleIdx}"><f>${xmlEscape(cell.formula)}</f></c>`;
        }
        return `<c r="${ref}" t="inlineStr" s="${styleIdx}"><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`;
      })
      .join('');
    const ht = row.isTotal ? ' ht="21" customHeight="1"' : ' ht="19" customHeight="1"';
    rowXmlList.push(`<row r="${rowNumber}"${ht}>${cellsXml}</row>`);
  });

  const lastRowNumber = Math.max(1, (hasHeader ? 1 : 0) + rows.length);
  const dimensionRef = `A1:${columnLetter(colCount - 1)}${lastRowNumber}`;

  const colsXml = columns
    .map((col, cIdx) => {
      const computedWidth = col.width || Math.min(46, Math.max(11, colMaxLengths[cIdx] + 3));
      const idx = cIdx + 1;
      return `<col min="${idx}" max="${idx}" width="${computedWidth}" customWidth="1"/>`;
    })
    .join('');

  const paneXml = sheet.freezeHeader
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    : '';
  const showGrid = sheet.showGridLines ? '1' : '0';
  const sheetViewsXml = `<sheetViews><sheetView workbookViewId="0" showGridLines="${showGrid}">${paneXml}</sheetView></sheetViews>`;

  // AutoFilter covers the header and data rows (excluding a trailing total row so sorting never moves the total row).
  const trailingTotalRows = rows.length > 0 && rows.at(-1).isTotal ? 1 : 0;
  const filterLastRow = lastRowNumber - trailingTotalRows;
  const autoFilterXml =
    sheet.autoFilter && filterLastRow >= 2
      ? `<autoFilter ref="A1:${columnLetter(colCount - 1)}${filterLastRow}"/>`
      : '';

  return (
    `${XML_HEAD}<worksheet xmlns="${SML_NS}" xmlns:r="${REL_NS}">` +
    `<dimension ref="${dimensionRef}"/>` +
    sheetViewsXml +
    '<sheetFormatPr defaultRowHeight="19"/>' +
    `<cols>${colsXml}</cols>` +
    `<sheetData>${rowXmlList.join('')}</sheetData>` +
    autoFilterXml +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  );
}

/**
 * Build an `.xlsx` workbook buffer.
 *
 * @param {Object} spec
 * @returns {Promise<{ buffer: Buffer, sheets: number, warnings: string[] }>}
 */
export async function buildXlsx(spec) {
  const warnings = [];
  const sheets = sanitizeSheets(spec?.sheets, warnings);
  const styles = new StyleRegistry({
    primaryColor: spec?.brand?.primaryColor,
    textColor: spec?.brand?.textColor,
    font: spec?.brand?.font
  });

  const zip = new JSZip();
  const typesDoc = parseXml(
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '</Types>',
    '[Content_Types].xml'
  );
  const types = new ContentTypes(typesDoc);

  const workbookRels = [{ id: 'rId1', type: REL_TYPES.styles, target: 'styles.xml' }];

  const sheetEntriesXml = sheets
    .map((sheet, idx) => {
      const sheetNum = idx + 1;
      const relId = `rId${sheetNum + 1}`;
      const partPath = `xl/worksheets/sheet${sheetNum}.xml`;
      zip.file(partPath, buildWorksheetXml(sheet, styles));
      types.setOverride(partPath, WORKSHEET_TYPE);
      workbookRels.push({
        id: relId,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
        target: `worksheets/sheet${sheetNum}.xml`
      });
      return `<sheet name="${xmlEscape(sheet.name)}" sheetId="${sheetNum}" r:id="${relId}"/>`;
    })
    .join('');

  zip.file(
    'xl/workbook.xml',
    `${XML_HEAD}<workbook xmlns="${SML_NS}" xmlns:r="${REL_NS}">` +
      '<workbookPr/>' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="15000"/></bookViews>' +
      `<sheets>${sheetEntriesXml}</sheets>` +
      '<calcPr calcId="191029" fullCalcOnLoad="1"/>' +
      '</workbook>'
  );
  types.setOverride('xl/workbook.xml', WORKBOOK_TYPE);
  writeRels(zip, 'xl/workbook.xml', workbookRels);

  zip.file('xl/styles.xml', styles.toXml());
  types.setOverride('xl/styles.xml', STYLES_TYPE);

  zip.file(
    'docProps/app.xml',
    `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      '<Application>iHub Apps</Application>' +
      `<Company>${xmlEscape(spec?.company || '')}</Company>` +
      '</Properties>'
  );
  types.setOverride('docProps/app.xml', EXTENDED_PROPS_TYPE);

  writeRels(zip, '', [
    { id: 'rId1', type: REL_TYPES.officeDocument, target: 'xl/workbook.xml' },
    { id: 'rId2', type: EXTENDED_PROPS_REL, target: 'docProps/app.xml' }
  ]);

  await setCoreProperties(zip, types, {
    title: spec?.title,
    author: spec?.author,
    language: spec?.language
  });

  types.write(zip);
  return {
    buffer: await writePackage(zip),
    sheets: sheets.length,
    warnings
  };
}

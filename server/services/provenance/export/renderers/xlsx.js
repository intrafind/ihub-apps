/**
 * XLSX export renderer (`write-excel-file/node`).
 *
 * Follows the former browser export (`exportToXLSX` in
 * `client/src/utils/exportFormats.js`): title, app and date rows, a message
 * table and the settings at the bottom. The AI label is the first row (with
 * an "AI" badge cell when the EU icon is on), the table has the columns
 * Role, Content, Timestamp, Model and Verification. Every cell is a typed
 * string, so formula-like text is never evaluated and stays as written.
 *
 * Excel cells hold at most 32,767 characters, so longer messages continue
 * in extra rows ("Assistant (continued)") instead of being cut off.
 *
 * @module services/provenance/export/renderers/xlsx
 */
import writeXlsxFile from 'write-excel-file/node';
import {
  AI_BADGE_LETTERS,
  formatDateTime,
  prepareCommon,
  roleLabel,
  stripXmlInvalidChars,
  verificationLabel
} from './common.js';

/** Characters per cell; Excel's hard limit is 32,767. */
export const MAX_CELL_CHARS = 32000;

const COLUMN_COUNT = 5;
const HEADER_STYLE = Object.freeze({ fontWeight: 'bold', backgroundColor: '#E0E0E0' });

/**
 * A typed string cell. Excel never evaluates a stored string as a formula
 * (that needs an `<f>` element), so no guard apostrophe: it would show as a
 * literal character. The guard belongs to CSV, which the target re-parses.
 * @param {*} value
 * @param {Object} [style] - write-excel-file cell options
 * @returns {Object}
 */
function cell(value, style = {}) {
  return {
    type: String,
    value: stripXmlInvalidChars(value ?? ''),
    ...style
  };
}

/**
 * A row whose first cell spans `span` columns (covered cells must be null).
 * @param {Array<Object>} leading - cells before the spanning one
 * @param {Object} spanning - the spanning cell
 * @returns {Array<Object|null>}
 */
function spanRow(leading, spanning) {
  const span = COLUMN_COUNT - leading.length;
  return [...leading, { ...spanning, columnSpan: span }, ...Array(span - 1).fill(null)];
}

const emptyRow = () => Array(COLUMN_COUNT).fill(null);

/**
 * Split text into chunks that fit an Excel cell, preferring line breaks.
 * @param {string} text
 * @returns {string[]}
 */
export function splitForCells(text) {
  const chars = Array.from(text || '');
  if (chars.length <= MAX_CELL_CHARS) return [text || ''];
  const chunks = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + MAX_CELL_CHARS, chars.length);
    if (end < chars.length) {
      const window = chars.slice(start, end).join('');
      const newline = window.lastIndexOf('\n');
      if (newline > MAX_CELL_CHARS / 2)
        end = start + Array.from(window.slice(0, newline + 1)).length;
    }
    chunks.push(chars.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}

/**
 * Render the export as XLSX.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} the XLSX bytes
 */
export async function renderXlsx(doc) {
  const { t, label, settingsRows } = prepareCommon(doc);
  const data = [];

  if (label.show) {
    const labelStyle = { fontWeight: 'bold', backgroundColor: '#EEF2FF', textColor: '#1E1B4B' };
    data.push(
      label.euIcon
        ? spanRow(
            [
              cell(AI_BADGE_LETTERS, {
                fontWeight: 'bold',
                textColor: '#FFFFFF',
                backgroundColor: '#1E3A8A',
                align: 'center'
              })
            ],
            cell(label.text, labelStyle)
          )
        : spanRow([], cell(label.text, labelStyle))
    );
    for (const detail of label.details) {
      data.push(spanRow([], cell(detail, { textColor: '#3730A3', backgroundColor: '#EEF2FF' })));
    }
  }
  data.push(spanRow([], cell(doc.title, { fontWeight: 'bold', fontSize: 14 })));
  data.push(spanRow([cell(t('export.header.app'), { fontWeight: 'bold' })], cell(doc.appName)));
  data.push(
    spanRow(
      [cell(t('export.header.exportedOnLabel'), { fontWeight: 'bold' })],
      cell(formatDateTime(doc.exportedAt, doc.language))
    )
  );
  data.push(emptyRow());
  data.push([
    cell(t('export.table.role'), HEADER_STYLE),
    cell(t('export.table.content'), HEADER_STYLE),
    cell(t('export.table.timestamp'), HEADER_STYLE),
    cell(t('export.table.model'), HEADER_STYLE),
    cell(t('export.table.verification'), HEADER_STYLE)
  ]);

  const top = { alignVertical: 'top' };
  for (const message of doc.messages) {
    const role = roleLabel(message.role, t);
    splitForCells(message.content).forEach((chunk, index) => {
      data.push([
        cell(index === 0 ? role : t('export.role.continued', { label: role }), top),
        cell(chunk, { ...top, wrap: true }),
        cell(formatDateTime(message.timestamp, doc.language), top),
        cell(message.model || '', top),
        cell(verificationLabel(message.verification, t), top)
      ]);
    });
  }

  if (settingsRows.length > 0) {
    data.push(emptyRow());
    data.push(spanRow([], cell(t('export.settings.title'), HEADER_STYLE)));
    for (const [name, value] of settingsRows) {
      data.push(spanRow([cell(name)], cell(value)));
    }
  }

  return writeXlsxFile(data, {
    sheet: t('export.table.sheetMessages'),
    columns: [{ width: 16 }, { width: 80 }, { width: 24 }, { width: 22 }, { width: 28 }]
  }).toBuffer();
}

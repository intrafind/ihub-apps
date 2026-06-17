/**
 * Shared CSV helpers for admin export endpoints.
 */

/**
 * Escape a single CSV field. Wraps the value in double quotes and doubles any
 * embedded quotes when it contains a comma, quote, CR, or newline. Also guards
 * against spreadsheet formula injection: a value starting with =, +, -, @, or a
 * tab is prefixed with a single quote so Excel/Sheets/LibreOffice treat it as
 * text rather than executing it as a formula.
 *
 * @param {*} value - Value to render as a CSV field
 * @returns {string}
 */
export function escapeCsvField(value) {
  let str = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV document from a header row and an array of row arrays.
 *
 * @param {string[]} headers - Column headers
 * @param {Array<Array<*>>} rows - Row values (each inner array is one row)
 * @returns {string}
 */
export function buildCsv(headers, rows) {
  const headerLine = headers.map(escapeCsvField).join(',');
  const body = rows.map(row => row.map(escapeCsvField).join(',')).join('\n');
  return body ? `${headerLine}\n${body}\n` : `${headerLine}\n`;
}

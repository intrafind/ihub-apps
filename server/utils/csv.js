/**
 * Shared CSV helpers for admin export endpoints.
 */

/**
 * Escape a single CSV field. Wraps the value in double quotes and doubles any
 * embedded quotes when it contains a comma, quote, or newline.
 *
 * @param {*} value - Value to render as a CSV field
 * @returns {string}
 */
export function escapeCsvField(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
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

import writeXlsxFile from 'write-excel-file';
import { extractMarkdownTables } from './markdownUtils';

/**
 * Export a single markdown table to CSV format
 * @param {Object} table - Table object with headers and rows
 * @param {string} filename - Optional filename
 * @returns {Object} Result object with success status and filename
 */
export const exportTableToCSV = (table, filename) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const finalFilename = filename || `table-${timestamp}.csv`;

  // Helper function to escape CSV values
  const escapeCSV = value => {
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    // Escape quotes and wrap in quotes if contains comma, quote, or newline
    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  // Build CSV content
  const rows = [];

  // Add header row
  rows.push(table.headers.map(escapeCSV).join(','));

  // Add data rows
  table.rows.forEach(row => {
    rows.push(row.map(escapeCSV).join(','));
  });

  // Create CSV content
  const csvContent = rows.join('\n');

  // Download file
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = finalFilename;
  link.click();
  URL.revokeObjectURL(link.href);

  return { success: true, filename: finalFilename };
};

/**
 * Export a single markdown table to XLSX format
 * @param {Object} table - Table object with headers and rows
 * @param {string} filename - Optional filename
 * @returns {Promise<Object>} Result object with success status and filename
 */
export const exportTableToXLSX = async (table, filename) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const finalFilename = filename || `table-${timestamp}.xlsx`;

  // Define header style
  const headerStyle = {
    fontWeight: 'bold',
    backgroundColor: '#E0E0E0'
  };

  // Prepare data rows for write-excel-file
  const data = [
    // Column headers
    table.headers.map(header => ({ value: header, ...headerStyle }))
  ];

  // Add data rows
  table.rows.forEach(row => {
    data.push(row.map(cell => ({ value: cell })));
  });

  // Define column widths based on header length
  const columns = table.headers.map(header => ({
    width: Math.max(15, header.length + 5)
  }));

  // Write XLSX file
  await writeXlsxFile(data, {
    columns,
    fileName: finalFilename
  });

  return { success: true, filename: finalFilename };
};

/**
 * Export a single markdown table to HTML format
 * @param {Object} table - Table object with headers and rows
 * @param {string} filename - Optional filename
 * @returns {Object} Result object with success status and filename
 */
export const exportTableToHTML = (table, filename) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const finalFilename = filename || `table-${timestamp}.html`;

  // Build HTML table
  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Table Export</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 20px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 12px;
      text-align: left;
    }
    th {
      background-color: #4F46E5;
      color: white;
      font-weight: bold;
    }
    tr:nth-child(even) {
      background-color: #f9fafb;
    }
    tr:hover {
      background-color: #f3f4f6;
    }
  </style>
</head>
<body>
  <table>
    <thead>
      <tr>
`;

  // Add header cells
  table.headers.forEach(header => {
    html += `        <th>${escapeHtml(header)}</th>\n`;
  });

  html += `      </tr>
    </thead>
    <tbody>
`;

  // Add data rows
  table.rows.forEach(row => {
    html += `      <tr>\n`;
    row.forEach(cell => {
      html += `        <td>${escapeHtml(cell)}</td>\n`;
    });
    html += `      </tr>\n`;
  });

  html += `    </tbody>
  </table>
</body>
</html>`;

  // Download file
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = finalFilename;
  link.click();
  URL.revokeObjectURL(link.href);

  return { success: true, filename: finalFilename };
};

/**
 * Helper function to escape HTML entities
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
 */
const escapeHtml = text => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

/**
 * Export all tables from markdown content
 * @param {string} content - Markdown content containing tables
 * @param {string} format - Export format (csv, xlsx, html)
 * @param {string} filename - Optional base filename
 * @returns {Promise<Object>} Result object
 */
export const exportTablesFromContent = async (content, format, filename) => {
  const tables = extractMarkdownTables(content);

  if (tables.length === 0) {
    throw new Error('No tables found in content');
  }

  // If multiple tables, export each one with an index
  if (tables.length > 1) {
    for (let i = 0; i < tables.length; i++) {
      const baseFilename = filename || 'table';
      const indexedFilename = baseFilename.replace(
        /(\.[^.]+)?$/,
        `-${i + 1}${format === 'xlsx' ? '.xlsx' : format === 'html' ? '.html' : '.csv'}`
      );

      switch (format) {
        case 'csv':
          exportTableToCSV(tables[i], indexedFilename);
          break;
        case 'xlsx':
          await exportTableToXLSX(tables[i], indexedFilename);
          break;
        case 'html':
          exportTableToHTML(tables[i], indexedFilename);
          break;
        default:
          throw new Error(`Unsupported format: ${format}`);
      }
    }
    return { success: true, count: tables.length };
  }

  // Single table export
  switch (format) {
    case 'csv':
      return exportTableToCSV(tables[0], filename);
    case 'xlsx':
      return await exportTableToXLSX(tables[0], filename);
    case 'html':
      return exportTableToHTML(tables[0], filename);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
};

import { useEffect } from 'react';
import * as XLSX from 'xlsx';

// Helper to provide temporary feedback on a button
const showButtonFeedback = (button, message, isSuccess = true) => {
  const originalHTML = button.innerHTML;
  const successIcon = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`;
  const errorIcon = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>`;

  button.innerHTML = `
    ${isSuccess ? successIcon : errorIcon}
    <span class="hidden sm:inline">${message}</span>
  `;
  button.classList.toggle('text-green-600', isSuccess);
  button.classList.toggle('text-red-600', !isSuccess);
  button.classList.remove('text-gray-600');
  button.disabled = true;

  setTimeout(() => {
    button.innerHTML = originalHTML;
    button.classList.remove('text-green-600', 'text-red-600');
    button.classList.add('text-gray-600');
    button.disabled = false;
  }, 2000);
};

// Extract table data from HTML table element
const extractTableData = tableElement => {
  const data = [];
  const rows = tableElement.querySelectorAll('tr');

  rows.forEach(row => {
    const rowData = [];
    const cells = row.querySelectorAll('th, td');
    cells.forEach(cell => {
      rowData.push(cell.textContent.trim());
    });
    if (rowData.length > 0) {
      data.push(rowData);
    }
  });

  return data;
};

// Convert table data to CSV format
const tableToCSV = data => {
  return data
    .map(row =>
      row
        .map(cell => {
          // Escape cells that contain commas, quotes, or newlines
          const cellStr = String(cell);
          if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
            return `"${cellStr.replace(/"/g, '""')}"`;
          }
          return cellStr;
        })
        .join(',')
    )
    .join('\n');
};

// Convert table data to Excel format using xlsx library
const tableToExcel = data => {
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Table');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
};

// Convert table data to JSON format
const tableToJSON = data => {
  if (data.length === 0) return '[]';

  // Use first row as headers
  const headers = data[0];
  const rows = data.slice(1);

  const jsonData = rows.map(row => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index] || '';
    });
    return obj;
  });

  return JSON.stringify(jsonData, null, 2);
};

// Convert table data to Markdown format
const tableToMarkdown = data => {
  if (data.length === 0) return '';

  const lines = [];

  // Add header row
  if (data.length > 0) {
    lines.push('| ' + data[0].join(' | ') + ' |');
    // Add separator row
    lines.push('| ' + data[0].map(() => '---').join(' | ') + ' |');
  }

  // Add data rows
  for (let i = 1; i < data.length; i++) {
    lines.push('| ' + data[i].join(' | ') + ' |');
  }

  return lines.join('\n');
};

// Convert table data to HTML format
const tableToHTML = data => {
  if (data.length === 0) return '<table></table>';

  let html = '<table border="1" cellpadding="5" cellspacing="0">\n';

  // Add header row
  if (data.length > 0) {
    html += '  <thead>\n    <tr>\n';
    data[0].forEach(cell => {
      html += `      <th>${escapeHTML(cell)}</th>\n`;
    });
    html += '    </tr>\n  </thead>\n';
  }

  // Add body rows
  if (data.length > 1) {
    html += '  <tbody>\n';
    for (let i = 1; i < data.length; i++) {
      html += '    <tr>\n';
      data[i].forEach(cell => {
        html += `      <td>${escapeHTML(cell)}</td>\n`;
      });
      html += '    </tr>\n';
    }
    html += '  </tbody>\n';
  }

  html += '</table>';
  return html;
};

// Helper to escape HTML special characters
const escapeHTML = str => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

// Download file with given content and filename
const downloadFile = (content, filename, mimeType) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const useTableInteractions = () => {
  useEffect(() => {
    const handleInteraction = e => {
      const button = e.target.closest('button');
      if (!button) return;

      const isTableDownloadBtn = button.classList.contains('table-download-btn');
      if (!isTableDownloadBtn) return;

      const format = button.dataset.format;
      const tableContainer = button.closest('.table-container');
      if (!tableContainer) return;

      const table = tableContainer.querySelector('table');
      if (!table) return;

      try {
        const tableData = extractTableData(table);
        if (tableData.length === 0) {
          throw new Error('No table data found');
        }

        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        let content;
        let filename;
        let mimeType;

        switch (format) {
          case 'excel':
            content = tableToExcel(tableData);
            filename = `table-${timestamp}.xlsx`;
            mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            break;
          case 'csv':
            content = tableToCSV(tableData);
            filename = `table-${timestamp}.csv`;
            mimeType = 'text/csv';
            break;
          case 'json':
            content = tableToJSON(tableData);
            filename = `table-${timestamp}.json`;
            mimeType = 'application/json';
            break;
          case 'markdown':
            content = tableToMarkdown(tableData);
            filename = `table-${timestamp}.md`;
            mimeType = 'text/markdown';
            break;
          case 'html':
            content = tableToHTML(tableData);
            filename = `table-${timestamp}.html`;
            mimeType = 'text/html';
            break;
          default:
            throw new Error('Unknown format');
        }

        downloadFile(content, filename, mimeType);
        showButtonFeedback(button, 'Downloaded!', true);
      } catch (err) {
        console.error('Table download failed:', err);
        showButtonFeedback(button, 'Error', false);
      }
    };

    document.addEventListener('click', handleInteraction);
    return () => document.removeEventListener('click', handleInteraction);
  }, []);
};

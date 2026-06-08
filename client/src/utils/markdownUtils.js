import { marked } from 'marked';
import TurndownService from 'turndown';

/**
 * Configure marked options for better HTML output
 */
marked.setOptions({
  breaks: true, // Convert line breaks to <br>
  gfm: true, // Enable GitHub Flavored Markdown
  sanitize: false // Allow HTML (ReactQuill will handle sanitization)
});

const turndownService = new TurndownService();

/**
 * Convert markdown text to HTML suitable for ReactQuill
 * @param {string} markdown - The markdown text to convert
 * @returns {string} HTML string
 */
export const markdownToHtml = markdown => {
  if (!markdown || typeof markdown !== 'string') {
    return '';
  }

  try {
    return marked(markdown);
  } catch (error) {
    console.error('Error converting markdown to HTML:', error);
    return markdown; // Return original text if conversion fails
  }
};

/**
 * Convert HTML text to Markdown using turndown
 * @param {string} html - The HTML text to convert
 * @returns {string} Markdown string
 */
export const htmlToMarkdown = html => {
  if (!html || typeof html !== 'string') {
    return '';
  }

  return turndownService.turndown(html);
};

export const isMarkdown = text => {
  if (!text || typeof text !== 'string') {
    return false;
  }

  // Simple heuristics to detect markdown
  const markdownPatterns = [
    /^#{1,6}\s+/, // Headers
    /\*\*.*?\*\*/, // Bold
    /\*.*?\*/, // Italic
    /`.*?`/, // Inline code
    /```[\s\S]*?```/, // Code blocks
    /^\s*[-*+]\s+/, // Unordered lists
    /^\s*\d+\.\s+/, // Ordered lists
    /^\s*>\s+/, // Blockquotes
    /\[.*?\]\(.*?\)/ // Links
  ];

  return markdownPatterns.some(pattern => pattern.test(text));
};

/**
 * Clean HTML by removing code block toolbars and interactive elements
 * This is useful for copying/downloading content without UI elements
 * @param {string} html - The HTML string to clean
 * @returns {string} Cleaned HTML string
 */
export const cleanHtmlForExport = html => {
  if (!html || typeof html !== 'string') {
    return '';
  }

  // Create a temporary DOM element to parse HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  // Remove code block toolbars (contains buttons and language labels)
  const toolbars = tempDiv.querySelectorAll('.code-block-toolbar');
  toolbars.forEach(toolbar => toolbar.remove());

  // Remove mermaid diagram controls if any
  const diagramControls = tempDiv.querySelectorAll('.mermaid-diagram-controls');
  diagramControls.forEach(control => control.remove());

  // Remove any button elements that might be left
  const buttons = tempDiv.querySelectorAll('button');
  buttons.forEach(button => button.remove());

  // Return the cleaned HTML
  return tempDiv.innerHTML;
};

/**
 * Detect if content contains markdown tables
 * @param {string} content - The content to check
 * @returns {boolean} True if content contains markdown tables
 */
export const hasMarkdownTable = content => {
  if (!content || typeof content !== 'string') {
    return false;
  }

  const lines = content.split('\n');
  let foundTable = false;

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    const nextLine = lines[i + 1].trim();

    // Check if current line looks like a table header and next line is a separator
    if (line.includes('|') && nextLine.match(/^[\|\s\-:]+$/)) {
      foundTable = true;
      break;
    }
  }

  return foundTable;
};

/**
 * Extract all markdown tables from content
 * @param {string} content - The markdown content
 * @returns {Array} Array of table objects with headers and rows
 */
export const extractMarkdownTables = content => {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const tables = [];
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Check if this line starts a table (contains pipes)
    if (line.includes('|')) {
      const tableLines = [];
      let tableStart = i;

      // Collect consecutive lines that look like table rows
      while (i < lines.length) {
        const tableLine = lines[i].trim();
        if (!tableLine || !tableLine.includes('|')) {
          break;
        }
        tableLines.push(tableLine);
        i++;
      }

      // Check if we have at least header + separator (minimum 2 lines)
      if (tableLines.length >= 2) {
        // Parse table header (first line)
        const headerCells = tableLines[0]
          .split('|')
          .map(cell => cell.trim())
          .filter(cell => cell);

        // Check if second line is separator (contains dashes and pipes)
        const separatorLine = tableLines[1];
        const isSeparator = /^[\|\s\-:]+$/.test(separatorLine);

        if (isSeparator && headerCells.length > 0) {
          // Parse table body rows (skip header and separator)
          const bodyRows = [];
          for (let j = 2; j < tableLines.length; j++) {
            const rowCells = tableLines[j]
              .split('|')
              .map(cell => cell.trim())
              .filter(cell => cell);

            if (rowCells.length > 0) {
              bodyRows.push(rowCells);
            }
          }

          // Add table to results
          tables.push({
            headers: headerCells,
            rows: bodyRows,
            startLine: tableStart,
            endLine: i - 1
          });
          continue;
        }
      }

      // If not a valid table, reset and continue
      i = tableStart + 1;
    } else {
      i++;
    }
  }

  return tables;
};

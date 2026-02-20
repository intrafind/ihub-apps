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

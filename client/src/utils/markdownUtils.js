import { marked } from 'marked';
import TurndownService from 'turndown';

/**
 * Configure marked options for better HTML output
 */
marked.setOptions({
  breaks: true, // Convert line breaks to <br>
  gfm: true, // Enable GitHub Flavored Markdown
  sanitize: false, // Allow HTML (ReactQuill will handle sanitization)
});

const turndownService = new TurndownService();

/**
 * Convert markdown text to HTML suitable for ReactQuill
 * @param {string} markdown - The markdown text to convert
 * @returns {string} HTML string
 */
export const markdownToHtml = (markdown) => {
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
export const htmlToMarkdown = (html) => {
  if (!html || typeof html !== 'string') {
    return '';
  }

  return turndownService.turndown(html);
};

/**
 * Detect if text is primarily markdown
 * @param {string} text - The text to analyze
 * @returns {boolean} True if text appears to be markdown
 */
export const isMarkdown = (text) => {
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
    /\[.*?\]\(.*?\)/, // Links
  ];

  return markdownPatterns.some(pattern => pattern.test(text));
};

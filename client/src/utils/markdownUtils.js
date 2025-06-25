import { marked } from 'marked';

/**
 * Configure marked options for better HTML output
 */
marked.setOptions({
  breaks: true, // Convert line breaks to <br>
  gfm: true, // Enable GitHub Flavored Markdown
  sanitize: false, // Allow HTML (ReactQuill will handle sanitization)
});

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
 * Simple HTML to markdown conversion (basic implementation)
 * @param {string} html - The HTML text to convert
 * @returns {string} Markdown string
 */
export const htmlToMarkdown = (html) => {
  if (!html || typeof html !== 'string') {
    return '';
  }

  // Basic HTML to markdown conversion
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n')
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n')
    .replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<ul[^>]*>(.*?)<\/ul>/gis, '$1\n')
    .replace(/<ol[^>]*>(.*?)<\/ol>/gis, '$1\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, '> $1\n\n')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```\n\n')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gis, '$1\n\n')
    .replace(/<[^>]*>/g, '') // Remove any remaining HTML tags
    .replace(/\n{3,}/g, '\n\n') // Clean up excessive line breaks
    .trim();
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

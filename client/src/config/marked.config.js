import { marked } from 'marked';
import {
  getLanguageDisplayName,
  isMermaidLanguage,
  generateId,
  detectDiagramType
} from '../utils/markdownHelpers';

const renderMermaidPlaceholder = (code, language) => {
  const diagramId = `mermaid-${generateId()}`;
  const detectedType = detectDiagramType(code);

  return `
    <div class="mermaid-diagram-container" id="${diagramId}" data-code="${encodeURIComponent(code)}" data-language="${language || 'mermaid'}" data-diagram-type="${detectedType}">
      <div class="mermaid-diagram-placeholder">
        <div class="flex items-center justify-center p-8 bg-gray-50 border border-gray-200 rounded-lg">
          <div class="flex items-center gap-2 text-gray-600">
            <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span class="text-sm">Loading diagram...</span>
          </div>
        </div>
      </div>
    </div>
  `;
};

export const configureMarked = t => {
  const renderer = new marked.Renderer();

  // --- Code Renderer ---
  renderer.code = (code, language) => {
    // Extract actual code string and language from the parameters
    let actualCode = code;
    let actualLanguage = language;

    // Handle different parameter structures (marked.js versions may vary)
    if (typeof code === 'object' && code !== null) {
      actualCode = code.text || code.raw || code.code || code;
      actualLanguage = language || code.lang || code.language;
    }

    // Ensure we have strings
    if (typeof actualCode !== 'string') {
      actualCode = String(actualCode);
    }

    const lang = (actualLanguage || 'text').toLowerCase();

    if (isMermaidLanguage(lang)) {
      return renderMermaidPlaceholder(actualCode, lang);
    }

    // Fallback for regular code blocks
    const displayLanguage = getLanguageDisplayName(lang);

    // Use the original highlighted code from marked
    const highlightedCode = marked.defaults.highlight
      ? marked.defaults.highlight(actualCode, lang)
      : actualCode.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `
      <div class="code-block-container relative group my-4 border border-gray-200 rounded-lg shadow-sm">
        <pre class="bg-gray-900 text-gray-100 rounded-t-lg p-4 overflow-x-auto"><code class="language-${lang}">${highlightedCode}</code></pre>
        <div class="flex items-center justify-between bg-gray-50 border-t border-gray-200 px-3 py-2 rounded-b-lg">
          <span class="text-xs font-medium text-gray-600">${displayLanguage}</span>
          <div class="flex items-center gap-2">
            <button
              class="code-copy-btn p-1.5 rounded text-xs text-gray-600 hover:bg-gray-200 flex items-center gap-1"
              data-code-content="${encodeURIComponent(actualCode)}"
              type="button"
              title="${t ? t('common.copyCode', 'Copy code') : 'Copy code'}"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
              <span class="hidden sm:inline">${t ? t('common.copy', 'Copy') : 'Copy'}</span>
            </button>
            <button
              class="code-download-btn p-1.5 rounded text-xs text-gray-600 hover:bg-gray-200 flex items-center gap-1"
              data-code-content="${encodeURIComponent(actualCode)}"
              data-code-language="${lang}"
              type="button"
              title="${t ? t('common.downloadCode', 'Download code') : 'Download code'}"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
              <span class="hidden sm:inline">${t ? t('common.download', 'Download') : 'Download'}</span>
            </button>
          </div>
        </div>
      </div>
    `;
  };

  // --- Link Renderer ---
  renderer.link = token => {
    // In marked v5+, the renderer receives a token object instead of separate parameters
    // Extract href, title, and text from the token
    let actualHref = token.href;
    let actualTitle = token.title;
    let text = token.text;

    // Handle legacy case where individual parameters might be passed (for backward compatibility)
    if (typeof token === 'string') {
      actualHref = token;
      actualTitle = arguments[1];
      text = arguments[2];
    }

    // Handle cases where href might be a stringified JSON object
    if (typeof actualHref === 'string' && actualHref.startsWith('{') && actualHref.endsWith('}')) {
      try {
        const parsed = JSON.parse(actualHref);
        actualHref = parsed.href || parsed.url || actualHref;
        if (!actualTitle) {
          actualTitle = parsed.title || null;
        }
      } catch {
        console.warn('Failed to parse href JSON');
      }
    }

    // Ensure we have valid values
    actualHref = actualHref || '';
    text = text || actualHref; // Fallback to href if text is missing

    const currentDomain = typeof window !== 'undefined' ? window.location.hostname : '';
    let isExternal = false;
    try {
      const url = new URL(actualHref, window.location.href);
      if (url.hostname !== currentDomain) {
        isExternal = true;
      }
    } catch {
      // If URL parsing fails, assume it's a relative path or invalid
    }
    const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    const titleAttr = actualTitle ? ` title="${actualTitle}"` : '';
    return `<a href="${actualHref}"${titleAttr}${targetAttr}>${text}</a>`;
  };

  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: true,
    mangle: false,
    pedantic: false,
    sanitize: false, // IMPORTANT: Ensure your markdown source is trusted
    smartLists: true,
    smartypants: false,
    xhtml: false,
    renderer: renderer,
    highlight: (code, lang) => {
      // Use a global hljs instance if available
      if (lang && window.hljs && window.hljs.getLanguage(lang)) {
        try {
          return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch (e) {
          console.error('Highlight.js error:', e);
        }
      }
      // Fallback to no highlighting
      return code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  });
};

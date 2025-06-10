import { useEffect } from 'react';
import { marked } from 'marked';

export const configureMarked = () => {
  const renderer = new marked.Renderer();
  const originalCodeRenderer = renderer.code;
  renderer.code = function(code, language, isEscaped) {
    const codeBlockId = `code-block-${Math.random().toString(36).substring(2, 15)}`;
    const originalHtml = originalCodeRenderer.call(this, code, language, isEscaped);
    const enhancedHtml = originalHtml.replace(
      '<pre>',
      '<pre class="bg-gray-800 text-gray-100 rounded-md p-4">'
    );
    return `
      <div class="code-block-container relative group">
        ${enhancedHtml}
        <button
          class="code-copy-btn absolute top-2 right-2 p-1 rounded text-xs bg-gray-700 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-200"
          data-code-id="${codeBlockId}"
          data-code-content="${encodeURIComponent(code)}"
          type="button"
          aria-label="Copy code"
        >
          <span class="icon-copy-code"></span>
        </button>
      </div>
    `;
  };

  // Customize link rendering to open external links in a new tab
  const currentDomain =
    typeof window !== 'undefined' ? window.location.hostname : '';
  renderer.link = function(href, title, text) {
    let html = `<a href="${href}"`;
    if (title) {
      html += ` title="${title}"`;
    }
    try {
      const url = new URL(href, window.location.href);
      if (url.hostname !== currentDomain) {
        html += ' target="_blank" rel="noopener noreferrer"';
      }
    } catch (e) {
      // If URL parsing fails, fall back to default behaviour
    }
    html += `>${text}</a>`;
    return html;
  };

  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: true,
    mangle: false,
    pedantic: false,
    sanitize: false,
    smartLists: true,
    smartypants: false,
    xhtml: false,
    highlight: function(code, lang) {
      if (lang && window.hljs && window.hljs.getLanguage(lang)) {
        try {
          return window.hljs.highlight(code, { language: lang }).value;
        } catch (e) {
          console.error('Highlighting error:', e);
        }
      }
      return code;
    },
    renderer: renderer
  });
};

const MarkdownRenderer = () => {
  useEffect(() => {
    configureMarked();

    const handleCodeCopyClick = (e) => {
      const button = e.target.closest('.code-copy-btn');
      if (!button) return;

      const codeContent = decodeURIComponent(button.dataset.codeContent);

      navigator.clipboard.writeText(codeContent)
        .then(() => {
          button.classList.add('bg-green-600');
          button.classList.remove('bg-gray-700');
          setTimeout(() => {
            button.classList.add('bg-gray-700');
            button.classList.remove('bg-green-600');
          }, 2000);
        })
        .catch(err => {
          console.error('Failed to copy code block: ', err);
        });
    };

    document.addEventListener('click', handleCodeCopyClick);
    return () => {
      document.removeEventListener('click', handleCodeCopyClick);
    };
  }, []);

  return null;
};

export default MarkdownRenderer;

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
    console.log('Link renderer called:', { href: JSON.stringify(href), title, text });
    
    // Extract the actual URL and title from href - handle both string and object cases
    let actualHref;
    let actualTitle = title;
    
    if (typeof href === 'string') {
      // Check if the href is a stringified JSON object
      if (href.startsWith('{') && href.endsWith('}')) {
        try {
          const parsed = JSON.parse(href);
          actualHref = parsed.href || parsed.url || href;
          if (!actualTitle) {
            actualTitle = parsed.title || null;
          }
        } catch (e) {
          console.warn('Failed to parse href JSON:', e);
          actualHref = href;
        }
      } else {
        actualHref = href;
      }
    } else if (typeof href === 'object' && href !== null) {
      // If href is an object (like from marked's token system), extract the href property
      actualHref = href.href || href.url || String(href);
      
      // Also try to extract title from the object if not provided separately
      if (!actualTitle) {
        actualTitle = href.title || href.text;
      }
    } else {
      actualHref = String(href);
    }
    
    let html = `<a href="${actualHref}"`;
    if (actualTitle) {
      html += ` title="${actualTitle}"`;
    }
    try {
      const url = new URL(actualHref, window.location.href);
      if (url.hostname !== currentDomain) {
        html += ' target="_blank" rel="noopener noreferrer"';
      }
    } catch (e) {
      // If URL parsing fails, fall back to default behaviour
      console.warn('Failed to parse URL:', actualHref, e);
    }

    if (actualTitle && (text !== undefined || text !== null)) {
      text = actualTitle;
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

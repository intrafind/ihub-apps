import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';

// Helper function to get user-friendly language names
const getLanguageDisplayName = language => {
  const languageMap = {
    js: 'JavaScript',
    javascript: 'JavaScript',
    jsx: 'JSX',
    ts: 'TypeScript',
    tsx: 'TSX',
    py: 'Python',
    python: 'Python',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    cs: 'C#',
    php: 'PHP',
    rb: 'Ruby',
    ruby: 'Ruby',
    go: 'Go',
    rust: 'Rust',
    swift: 'Swift',
    kotlin: 'Kotlin',
    scala: 'Scala',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    sass: 'Sass',
    less: 'Less',
    xml: 'XML',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    toml: 'TOML',
    ini: 'INI',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    fish: 'Fish',
    powershell: 'PowerShell',
    ps1: 'PowerShell',
    sql: 'SQL',
    mysql: 'MySQL',
    postgresql: 'PostgreSQL',
    sqlite: 'SQLite',
    r: 'R',
    matlab: 'MATLAB',
    perl: 'Perl',
    lua: 'Lua',
    dart: 'Dart',
    elm: 'Elm',
    clojure: 'Clojure',
    erlang: 'Erlang',
    elixir: 'Elixir',
    haskell: 'Haskell',
    ocaml: 'OCaml',
    fsharp: 'F#',
    fs: 'F#',
    vb: 'Visual Basic',
    vba: 'VBA',
    text: 'Text',
    txt: 'Text',
    md: 'Markdown',
    markdown: 'Markdown',
    tex: 'LaTeX',
    latex: 'LaTeX',
    diff: 'Diff',
    patch: 'Patch'
  };

  return languageMap[language.toLowerCase()] || language.toUpperCase();
};

// Helper function to get file extension for download
const getFileExtension = language => {
  const extensionMap = {
    javascript: 'js',
    js: 'js',
    jsx: 'jsx',
    typescript: 'ts',
    ts: 'ts',
    tsx: 'tsx',
    python: 'py',
    py: 'py',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    csharp: 'cs',
    cs: 'cs',
    php: 'php',
    ruby: 'rb',
    rb: 'rb',
    go: 'go',
    rust: 'rs',
    swift: 'swift',
    kotlin: 'kt',
    scala: 'scala',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yml',
    toml: 'toml',
    ini: 'ini',
    sh: 'sh',
    bash: 'sh',
    zsh: 'zsh',
    fish: 'fish',
    powershell: 'ps1',
    ps1: 'ps1',
    sql: 'sql',
    mysql: 'sql',
    postgresql: 'sql',
    sqlite: 'sql',
    r: 'r',
    matlab: 'm',
    perl: 'pl',
    lua: 'lua',
    dart: 'dart',
    elm: 'elm',
    clojure: 'clj',
    erlang: 'erl',
    elixir: 'ex',
    haskell: 'hs',
    ocaml: 'ml',
    fsharp: 'fs',
    fs: 'fs',
    vb: 'vb',
    vba: 'vba',
    markdown: 'md',
    md: 'md',
    tex: 'tex',
    latex: 'tex',
    diff: 'diff',
    patch: 'patch',
    text: 'txt'
  };

  return extensionMap[language.toLowerCase()] || 'txt';
};

export const configureMarked = () => {
  const renderer = new marked.Renderer();
  const originalCodeRenderer = renderer.code;
  renderer.code = function (code, language, isEscaped) {
    const codeBlockId = `code-block-${Math.random().toString(36).substring(2, 15)}`;
    const originalHtml = originalCodeRenderer.call(this, code, language, isEscaped);
    const enhancedHtml = originalHtml.replace(
      '<pre>',
      '<pre class="bg-gray-900 text-gray-100 rounded-t-lg p-4 overflow-x-auto">'
    );

    // Display language name, fallback to 'text' if not specified
    const displayLanguage = language || code.lang || 'text';
    const languageDisplayName = getLanguageDisplayName(displayLanguage);

    // Ensure code is a string - handle both string and object cases
    let codeString;
    if (typeof code === 'string') {
      codeString = code;
    } else if (code && typeof code === 'object') {
      // If code is an object, try to extract the text property or convert to string
      codeString = code.text || code.raw || JSON.stringify(code);
    } else {
      codeString = String(code);
    }

    return `
      <div class="code-block-container relative group border border-gray-200 rounded-lg overflow-hidden bg-white shadow-sm">
        ${enhancedHtml}
        <div class="code-block-toolbar flex flex-row items-center justify-between bg-gray-50 border-t border-gray-200 px-3 py-2 rounded-b-lg">
          <div class="flex flex-row items-center gap-2">
            <span class="text-xs font-medium text-gray-600">${languageDisplayName}</span>
          </div>
          <div class="flex flex-row items-center gap-2">
            <button
              class="code-copy-btn p-1.5 rounded text-xs bg-transparent text-gray-600 hover:bg-gray-200 hover:text-gray-800 transition-colors duration-200 flex items-center gap-1"
              data-code-id="${codeBlockId}"
              data-code-content="${encodeURIComponent(codeString)}"
              type="button"
              title={t('common.copyCode', 'Copy code')}
              aria-label={t('common.copyCode', 'Copy code')}
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
              </svg>
              <span class="hidden sm:inline">Copy</span>
            </button>
            <button
              class="code-download-btn p-1.5 rounded text-xs bg-transparent text-gray-600 hover:bg-gray-200 hover:text-gray-800 transition-colors duration-200 flex items-center gap-1"
              data-code-id="${codeBlockId}"
              data-code-content="${encodeURIComponent(codeString)}"
              data-code-language="${displayLanguage}"
              type="button"
              title={t('common.downloadCode', 'Download code')}
              aria-label={t('common.downloadCode', 'Download code')}
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
              </svg>
              <span class="hidden sm:inline">Download</span>
            </button>
          </div>
        </div>
      </div>
    `;
  };

  // Customize link rendering to open external links in a new tab
  const currentDomain = typeof window !== 'undefined' ? window.location.hostname : '';
  renderer.link = function (href, title, text) {
    // console.log('Link renderer called:', { href: JSON.stringify(href), title, text });

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
    highlight: function (code, lang) {
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
  const { t } = useTranslation();

  // Note: Translation of hardcoded strings in HTML templates (lines ~193, 207, 321, 340, 391, 409)
  // requires architectural changes to inject translation function into template generation.
  // Currently, translation is only available for aria-labels and titles.
  useEffect(() => {
    const handleCodeCopyClick = e => {
      const button = e.target.closest('.code-copy-btn');
      if (!button) return;

      let codeContent = button.dataset.codeContent;
      if (!codeContent || codeContent === '[object Object]') {
        const codeEl = button.closest('.code-block-container')?.querySelector('pre code');
        codeContent = codeEl ? codeEl.textContent : '';
      } else {
        codeContent = decodeURIComponent(codeContent);
      }

      navigator.clipboard
        .writeText(codeContent)
        .then(() => {
          // Show success state
          const originalHTML = button.innerHTML;
          button.innerHTML = `
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
            </svg>
            <span class="hidden sm:inline">Copied!</span>
          `;
          button.classList.add('text-green-600');
          button.classList.remove('text-gray-600');

          setTimeout(() => {
            button.innerHTML = originalHTML;
            button.classList.add('text-gray-600');
            button.classList.remove('text-green-600');
          }, 2000);
        })
        .catch(err => {
          console.error('Failed to copy code block: ', err);
          // Show error state
          const originalHTML = button.innerHTML;
          button.innerHTML = `
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
            <span class="hidden sm:inline">Error</span>
          `;
          button.classList.add('text-red-600');
          button.classList.remove('text-gray-600');

          setTimeout(() => {
            button.innerHTML = originalHTML;
            button.classList.add('text-gray-600');
            button.classList.remove('text-red-600');
          }, 2000);
        });
    };

    const handleCodeDownloadClick = e => {
      const button = e.target.closest('.code-download-btn');
      if (!button) return;

      let codeContent = button.dataset.codeContent;
      if (!codeContent || codeContent === '[object Object]') {
        const codeEl = button.closest('.code-block-container')?.querySelector('pre code');
        codeContent = codeEl ? codeEl.textContent : '';
      } else {
        codeContent = decodeURIComponent(codeContent);
      }
      const language = button.dataset.codeLanguage || 'text';
      const fileExtension = getFileExtension(language);
      const filename = `code.${fileExtension}`;

      try {
        // Create a blob with the code content
        const blob = new Blob([codeContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        // Create a temporary anchor element to trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Clean up the URL object
        URL.revokeObjectURL(url);

        // Show success state
        const originalHTML = button.innerHTML;
        button.innerHTML = `
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
          </svg>
          <span class="hidden sm:inline">Downloaded!</span>
        `;
        button.classList.add('text-green-600');
        button.classList.remove('text-gray-600');

        setTimeout(() => {
          button.innerHTML = originalHTML;
          button.classList.add('text-gray-600');
          button.classList.remove('text-green-600');
        }, 2000);
      } catch (err) {
        console.error('Failed to download code block: ', err);
        // Show error state
        const originalHTML = button.innerHTML;
        button.innerHTML = `
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
          <span class="hidden sm:inline">Error</span>
        `;
        button.classList.add('text-red-600');
        button.classList.remove('text-gray-600');

        setTimeout(() => {
          button.innerHTML = originalHTML;
          button.classList.add('text-gray-600');
          button.classList.remove('text-red-600');
        }, 2000);
      }
    };

    // Add event listeners for both copy and download buttons
    document.addEventListener('click', handleCodeCopyClick);
    document.addEventListener('click', handleCodeDownloadClick);

    return () => {
      document.removeEventListener('click', handleCodeCopyClick);
      document.removeEventListener('click', handleCodeDownloadClick);
    };
  }, []);

  return null;
};

export default MarkdownRenderer;

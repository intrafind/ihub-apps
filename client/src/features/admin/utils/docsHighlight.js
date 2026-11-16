// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Syntax highlighting for the code blocks of the admin documentation. highlight.js is loaded on
 * first use with only the languages the docs are written in, so it stays out of the main bundle.
 */

const LANGUAGES = {
  bash: () => import('highlight.js/lib/languages/bash'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  http: () => import('highlight.js/lib/languages/http'),
  ini: () => import('highlight.js/lib/languages/ini'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  sql: () => import('highlight.js/lib/languages/sql'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml')
};

/** Names the docs use for a language highlight.js knows under another one. */
const ALIASES = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  env: 'bash',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  html: 'xml',
  svg: 'xml',
  toml: 'ini',
  conf: 'nginx',
  ps1: 'powershell',
  py: 'python',
  docker: 'dockerfile'
};

let corePromise = null;
const registered = new Set();

const loadCore = () => {
  corePromise ??= import('highlight.js/lib/core').then(module => module.default);
  return corePromise;
};

/**
 * The highlight.js language for a fenced block's language name, or `null` when the docs viewer
 * does not highlight it.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function docsHighlightLanguage(name) {
  const key = String(name || '').toLowerCase();
  const language = ALIASES[key] || key;
  return Object.hasOwn(LANGUAGES, language) ? language : null;
}

/**
 * Highlight every `pre > code.language-*` block inside `container`. Blocks in a language the
 * viewer does not know stay as they are.
 *
 * @param {ParentNode} container
 * @returns {Promise<void>}
 */
export async function highlightDocsCode(container) {
  const blocks = [...container.querySelectorAll('pre > code[class*="language-"]')].filter(
    block => !block.classList.contains('hljs')
  );
  if (blocks.length === 0) return;
  const hljs = await loadCore();
  for (const block of blocks) {
    const name = /language-([\w+-]+)/.exec(block.className)?.[1];
    const language = docsHighlightLanguage(name);
    if (!language) continue;
    if (!registered.has(language)) {
      const module = await LANGUAGES[language]();
      hljs.registerLanguage(language, module.default);
      registered.add(language);
    }
    if (!block.isConnected) continue;
    const { value } = hljs.highlight(block.textContent, { language, ignoreIllegals: true });
    // highlight.js escapes the source; the result is markup of its own spans only.
    block.innerHTML = value;
    block.classList.add('hljs');
  }
}

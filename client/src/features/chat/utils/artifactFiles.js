// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { generatedFileKind, TEXT_FILE_MEDIA_TYPES } from '../../../../../shared/generatedFiles.js';

/**
 * Helpers for the files a chat produced (its artifacts): how they are named,
 * shown and previewed. Shared by the download cards (`GeneratedFiles`) and the
 * Artifacts panel.
 */

/** Largest text a preview reads, in bytes; longer files are cut. */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/**
 * A size for people: `512 B`, `12 KB`, `3.4 MB`. Empty for nothing.
 *
 * @param {unknown} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'text/markdown': 'md',
  'text/plain': 'txt'
};

/**
 * The name an artifact is listed under: its own, or one made from its kind
 * and id (a generated picture has none).
 *
 * @param {{ id?: string, name?: string, kind?: string, mimeType?: string }} artifact
 * @returns {string}
 */
export function artifactDisplayName(artifact) {
  const name = typeof artifact?.name === 'string' ? artifact.name.trim() : '';
  if (name) return name;
  const extension = EXTENSIONS[artifact?.mimeType] || 'bin';
  return `${artifact?.kind || 'artifact'}-${String(artifact?.id || '').slice(0, 8)}.${extension}`;
}

/**
 * The name a file is saved under: its last path segment (`src/index.js` →
 * `index.js`).
 *
 * @param {unknown} name
 * @returns {string}
 */
export function saveName(name) {
  const base = String(name || '')
    .split('/')
    .pop();
  return base || 'file';
}

/**
 * How an artifact is previewed.
 *
 * @param {{ kind?: string, mimeType?: string, name?: string }} artifact
 * @returns {'image'|'markdown'|'json'|'code'|'none'}
 */
export function previewTypeOf(artifact) {
  const mimeType = artifact?.mimeType || '';
  if (artifact?.kind === 'image' || mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'text/markdown') return 'markdown';
  if (mimeType === 'application/json') return 'json';
  if (TEXT_FILE_MEDIA_TYPES.includes(mimeType)) return 'code';
  return 'none';
}

/** Whether an artifact is text the user can copy. */
export function isTextArtifact(artifact) {
  return ['markdown', 'json', 'code'].includes(previewTypeOf(artifact));
}

/** highlight.js language by file extension, where the two differ or matter. */
const LANGUAGES = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  cpp: 'cpp',
  hpp: 'cpp',
  c: 'c',
  h: 'c',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  json: 'json',
  jsonl: 'json',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  html: 'xml',
  svg: 'xml',
  java: 'java',
  go: 'go',
  php: 'php',
  swift: 'swift',
  toml: 'ini',
  ini: 'ini',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile'
};

/**
 * The highlight.js language of a file, from its name.
 *
 * @param {unknown} name
 * @returns {string} A language name, or `''` for plain text.
 */
export function codeLanguageOf(name) {
  const base = saveName(name).toLowerCase();
  if (LANGUAGES[base]) return LANGUAGES[base];
  const match = /\.([a-z0-9]+)$/.exec(base);
  return (match && LANGUAGES[match[1]]) || '';
}

/** Icon and colours of a file, by office type or by artifact kind. */
const LOOKS = {
  'application/pdf': {
    icon: 'document-text',
    className: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400'
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    icon: 'document-text',
    className: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    icon: 'presentation-chart-bar',
    className: 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
  },
  code: {
    icon: 'code-bracket',
    className: 'bg-slate-100 dark:bg-slate-700/50 text-slate-700 dark:text-slate-200'
  },
  archive: {
    icon: 'archive-box',
    className: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
  },
  image: {
    icon: 'photograph',
    className: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
  }
};

/**
 * Icon and colours of a file.
 *
 * @param {{ kind?: string, mimeType?: string }} artifact
 * @returns {{ icon: string, className: string }}
 */
export function fileLookOf(artifact) {
  const mimeType = artifact?.mimeType || '';
  if (LOOKS[mimeType]) return LOOKS[mimeType];
  if (artifact?.kind === 'image' || mimeType.startsWith('image/')) return LOOKS.image;
  return LOOKS[generatedFileKind(mimeType)] || LOOKS['application/pdf'];
}

/**
 * The `code` of a refused ZIP download (`too-many-files`, `too-large`), read
 * from the JSON body axios hands back as a Blob for a blob request.
 *
 * @param {unknown} error
 * @returns {Promise<string|null>}
 */
export async function zipErrorCode(error) {
  const data = error?.response?.data;
  try {
    const body = data instanceof Blob ? JSON.parse(await data.text()) : data;
    return typeof body?.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

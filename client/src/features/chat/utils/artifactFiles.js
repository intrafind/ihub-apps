// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { generatedFileKind, TEXT_FILE_MEDIA_TYPES } from '../../../../../shared/generatedFiles.js';
import { prepareHtmlPreview } from '../../../../../shared/artifactPreview.js';

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
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
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
 * @returns {'image'|'pdf'|'html'|'svg'|'csv'|'ipynb'|'markdown'|'json'|'code'|'none'}
 */
export function previewTypeOf(artifact) {
  const mimeType = artifact?.mimeType || '';
  const name = typeof artifact?.name === 'string' ? artifact.name.trim() : '';
  if (artifact?.kind === 'image' || mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/markdown') return 'markdown';
  if (
    mimeType === 'text/csv' ||
    mimeType === 'text/tab-separated-values' ||
    /\.(csv|tsv)$/i.test(name)
  ) {
    return 'csv';
  }
  if (mimeType === 'application/x-ipynb+json' || /\.ipynb$/i.test(name)) return 'ipynb';
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.svg$/i.test(name)) return 'svg';
  if (mimeType === 'application/json') return 'json';
  if (TEXT_FILE_MEDIA_TYPES.includes(mimeType)) return 'code';
  return 'none';
}

/** Badge in the header per preview type. */
const BADGES = {
  markdown: 'MD',
  html: 'HTML',
  svg: 'SVG',
  csv: 'CSV',
  json: 'JSON',
  ipynb: 'IPYNB',
  pdf: 'PDF',
  image: 'IMG'
};

/** The type badge of an artifact: a short label from its type, else its extension. */
export function artifactBadge(artifact) {
  const type = previewTypeOf(artifact);
  if (BADGES[type]) return BADGES[type];
  const match = /\.([a-z0-9]{1,5})$/i.exec(artifactDisplayName(artifact));
  return match ? match[1].toUpperCase() : null;
}

/** Whether an artifact is text the user can copy. */
export function isTextArtifact(artifact) {
  return ['markdown', 'json', 'code', 'html', 'svg', 'csv', 'ipynb'].includes(
    previewTypeOf(artifact)
  );
}

/**
 * Put the preview CSP (and the viewer's theme) in front of an HTML artifact's
 * markup. The policy itself — inline code, the admin's CDN hosts, no other
 * network — lives in `shared/artifactPreview.js`, shared with the share embed
 * page and the server's `create_web_artifact` checks.
 *
 * @param {unknown} html
 * @param {{scriptHosts?: string[], theme?: 'light'|'dark'}} [options]
 * @returns {string}
 */
export function withPreviewCsp(html, options) {
  return prepareHtmlPreview(html, options);
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
  htm: 'xml',
  svg: 'xml',
  drawio: 'xml',
  ipynb: 'json',
  excalidraw: 'json',
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
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    icon: 'table-cells',
    className: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300'
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
 * The look of a PDF, which `fileLookOf` also returns for a type it does not know. Callers that must
 * tell the two apart compare against this object, not against its class names.
 */
export const PDF_LOOK = LOOKS['application/pdf'];

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

/**
 * A Blob from base64 text: the bytes of a file or picture a live turn carries
 * inline (`data`) before it is stored.
 *
 * @param {string} data - Base64 payload.
 * @param {string} [mimeType]
 * @returns {Blob}
 */
export function blobOfBase64(data, mimeType) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** Whether an artifact descriptor can be opened in the viewer. */
export function isOpenable(artifact) {
  if (!artifact || artifact.unavailable) return false;
  if (!artifact.id && !artifact.data) return false;
  return previewTypeOf(artifact) !== 'none';
}

/**
 * Whether the bytes of an artifact exist only in this browser tab (a live turn
 * that is not stored yet): it has no URL and cannot be opened in a new tab.
 */
export function isLiveArtifact(artifact) {
  return !artifact?.id || String(artifact.id).startsWith('live:') || Boolean(artifact.data);
}

/**
 * The artifacts a conversation produced that the viewer can open, in order:
 * generated files and pictures of each answer. A live picture has no id yet;
 * it gets a stable `live:` key so the viewer can step to it. An entry keeps
 * the answer's `runId` (and a picture its position, `imageIndex`) so that the
 * stored copy of a live item can be found once the answer is stored.
 *
 * @param {Object[]} messages
 * @returns {Object[]} Descriptors (as the cards carry them; `data` kept inline).
 */
export function collectOpenableArtifacts(messages) {
  const out = [];
  const seen = new Set();
  (messages || []).forEach((message, messageIndex) => {
    if (message?.role !== 'assistant') return;
    const files = Array.isArray(message.generatedFiles) ? message.generatedFiles : [];
    const images = Array.isArray(message.images) ? message.images : [];
    const items = [
      ...files.map(item => ({ item, imageIndex: null })),
      ...images.map((item, imageIndex) => ({ item, imageIndex }))
    ];
    items.forEach(({ item, imageIndex }, index) => {
      if (!isOpenable(item)) return;
      const id = item.id || `live:${messageIndex}:${index}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({
        ...item,
        id,
        kind: item.kind || (item.mimeType?.startsWith('image/') ? 'image' : undefined),
        ...(message.runId ? { runId: message.runId } : {}),
        ...(imageIndex !== null ? { imageIndex } : {})
      });
    });
  });
  return out;
}

/**
 * The stored copy of an artifact, which is what can be shared.
 *
 * A stored artifact is its own copy. A live one (bytes only in this tab, or a
 * held file whose stored copy has another id) is looked up in what the chat
 * has stored for its answer: a picture by its position among the answer's
 * pictures, a file by name and type.
 *
 * @param {Object|null} artifact - A descriptor as the viewer shows it.
 * @param {Object[]} storedItems - The chat's stored artifacts (`runId`, `kind`, `name`, …).
 * @returns {Object|null} `null` while the answer is not stored (or listed) yet.
 */
export function storedCounterpart(artifact, storedItems) {
  if (!artifact) return null;
  if (!isLiveArtifact(artifact)) return artifact;
  const ofRun = artifact.runId
    ? (Array.isArray(storedItems) ? storedItems : []).filter(item => item.runId === artifact.runId)
    : [];
  if (artifact.kind === 'image' || artifact.mimeType?.startsWith('image/')) {
    const images = ofRun.filter(item => item.kind === 'image');
    return images[artifact.imageIndex] || (images.length === 1 ? images[0] : null);
  }
  return (
    ofRun.find(item => item.name === artifact.name && item.mimeType === artifact.mimeType) || null
  );
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files a tool generated for the user (a PDF, Word document or presentation
 * from the `pdf`, `docx` and `pptx` system skills; a source file, JSON, CSV,
 * Markdown or text file, or a ZIP archive from the `files` system skill), as
 * the chat's download cards carry them.
 *
 * A file takes the path a generated picture takes:
 *
 * - **Live** — `{ id, name, mimeType, bytes, pages?, slides?, data }` on the
 *   `tool/completed` event, the bytes base64 in `data`.
 * - **Stored** — with the answer, as an artifact of the chat
 *   (`message.artifacts`, kind {@link generatedFileKind}); {@link generatedFilesFromArtifacts} turns those
 *   into cards that fetch the bytes from the chat's (or the share's) artifact
 *   route by `id`. One the server declined to keep has `unavailable` instead.
 *
 * Shared by the server (which emits and stores them) and the client (which
 * renders the cards), so both accept exactly the same shape.
 */

/** Most generated files one message keeps. */
export const MAX_GENERATED_FILES = 20;

/** Media type of a ZIP archive (`create_zip`). */
export const ZIP_MEDIA_TYPE = 'application/zip';

/** Office documents the document skills render. */
const OFFICE_MEDIA_TYPES = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

/**
 * Text files `create_file` writes, by extension, with the media type they are
 * recorded under. An extension that is not here is recorded as `text/plain`
 * (see {@link textFileMediaType}) — and so is `.html` or `.svg`: a file is
 * recorded as what it is to download, never as something a browser would run.
 *
 * The types are what the artifact's metadata says. On the wire every one of
 * them is served as `text/plain` (see `artifactPolicy.servedMediaType`).
 */
export const TEXT_FILE_TYPES = Object.freeze({
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  ini: 'text/x-ini',
  env: 'text/plain',
  properties: 'text/x-java-properties',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'application/typescript',
  tsx: 'application/typescript',
  py: 'text/x-python',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  scala: 'text/x-scala',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  go: 'text/x-go',
  rs: 'text/x-rust',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  swift: 'text/x-swift',
  sql: 'application/sql',
  sh: 'text/x-sh',
  bash: 'text/x-sh',
  ps1: 'text/x-powershell',
  bat: 'text/plain',
  css: 'text/css',
  scss: 'text/x-scss',
  less: 'text/x-less',
  r: 'text/x-r',
  lua: 'text/x-lua',
  pl: 'text/x-perl',
  dart: 'text/x-dart',
  vue: 'text/plain',
  svelte: 'text/plain',
  tex: 'text/x-tex',
  diff: 'text/x-diff',
  patch: 'text/x-diff'
});

/** Every media type a text file may be recorded under. */
export const TEXT_FILE_MEDIA_TYPES = Object.freeze([...new Set(Object.values(TEXT_FILE_TYPES))]);

/** Media types a generated file may have. */
export const GENERATED_FILE_MEDIA_TYPES = Object.freeze([
  ...OFFICE_MEDIA_TYPES,
  ...TEXT_FILE_MEDIA_TYPES,
  ZIP_MEDIA_TYPE
]);

/**
 * The media type a text file of this name is recorded under.
 *
 * @param {unknown} name - File name or path, e.g. `src/index.ts`.
 * @returns {string}
 */
export function textFileMediaType(name) {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(typeof name === 'string' ? name : '');
  const extension = match ? match[1].toLowerCase() : '';
  return Object.hasOwn(TEXT_FILE_TYPES, extension) ? TEXT_FILE_TYPES[extension] : 'text/plain';
}

/**
 * The artifact kind a generated file is stored as: `archive` for a ZIP,
 * `code` for a text file, `document` for an office document.
 *
 * @param {unknown} mimeType
 * @returns {'archive'|'code'|'document'}
 */
export function generatedFileKind(mimeType) {
  if (mimeType === ZIP_MEDIA_TYPE) return 'archive';
  if (TEXT_FILE_MEDIA_TYPES.includes(mimeType)) return 'code';
  return 'document';
}

/** Artifact kinds a download card is drawn for. */
const GENERATED_FILE_KINDS = new Set(['document', 'code', 'archive']);

const FILE_ID = /^[a-f0-9]{32}$/;

/**
 * Normalize one descriptor, or return null when it is not one.
 *
 * @param {unknown} entry
 * @returns {{ id?: string, name: string, mimeType: string, bytes: number, pages?: number,
 *   slides?: number, data?: string, stored?: true, unavailable?: string } | null}
 */
export function generatedFileOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (!GENERATED_FILE_MEDIA_TYPES.includes(entry.mimeType)) return null;
  const unavailable =
    typeof entry.unavailable === 'string' && entry.unavailable
      ? entry.unavailable.slice(0, 40)
      : null;
  const id = typeof entry.id === 'string' && FILE_ID.test(entry.id) ? entry.id : null;
  if (!id && !unavailable) return null;
  const name =
    typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 200) : 'file';
  const bytes = Number(entry.bytes);
  const pages = Number(entry.pages);
  const slides = Number(entry.slides);
  return {
    ...(id ? { id } : {}),
    name,
    mimeType: entry.mimeType,
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
    ...(Number.isInteger(pages) && pages > 0 ? { pages } : {}),
    ...(Number.isInteger(slides) && slides > 0 ? { slides } : {}),
    ...(typeof entry.data === 'string' && entry.data ? { data: entry.data } : {}),
    ...(entry.stored === true ? { stored: true } : {}),
    ...(unavailable ? { unavailable } : {})
  };
}

/**
 * Normalize a list of descriptors: valid ones only, no duplicates, bounded.
 *
 * @param {unknown} list
 * @returns {Array<Object>}
 */
export function generatedFilesOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const file = generatedFileOf(entry);
    if (!file || (file.id && out.some(f => f.id === file.id))) continue;
    out.push(file);
    if (out.length >= MAX_GENERATED_FILES) break;
  }
  return out;
}

/**
 * The download cards of a stored message: its `document`, `code` and
 * `archive` artifacts of a generated file type.
 *
 * @param {unknown} artifacts - `message.artifacts` as stored.
 * @returns {Array<Object>}
 */
export function generatedFilesFromArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return generatedFilesOf(
    artifacts
      .filter(artifact => GENERATED_FILE_KINDS.has(artifact?.kind))
      .map(artifact => ({ ...artifact, data: undefined, stored: !artifact.unavailable }))
  );
}

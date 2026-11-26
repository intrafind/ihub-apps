// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an app's upload settings (`app.upload`) accept, without a model in view.
 *
 * The composer decides its attach button and the accepted types with
 * `useFileUploadHandler().createUploadConfig(app, model)`. The defaults it falls
 * back on when an app lists no `supportedFormats` live here, so the composer and
 * the "Use in app" picker (which lists apps before any model is chosen) agree on
 * them.
 *
 * The picker cannot know the model the chat will pick, so a vision or audio
 * model is assumed: the target app's chat still says when its model cannot take
 * the file, exactly as for a picked cloud file.
 *
 * @module features/upload/utils/uploadFormats
 */

/** Image types an image upload accepts when the app lists none. */
export const DEFAULT_IMAGE_FORMATS = Object.freeze([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp'
]);

/** Audio types an audio upload accepts when the app lists none. */
export const DEFAULT_AUDIO_FORMATS = Object.freeze([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/flac',
  'audio/ogg',
  'audio/mp4'
]);

/** Video types a video upload accepts when the app lists none. */
export const DEFAULT_VIDEO_FORMATS = Object.freeze(['video/mp4', 'video/webm', 'video/quicktime']);

/** Document types a file upload accepts when the app lists none. */
export const DEFAULT_FILE_FORMATS = Object.freeze([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/vtt',
  'application/json',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/pdf'
]);

/**
 * The wildcard an admin can list in `fileUpload.supportedFormats` to accept any
 * plain-text file (mirrors `GENERIC_TEXT_MIME_TYPE` of `fileProcessing.js`,
 * which is not imported here to keep this module free of the PDF and Office
 * readers).
 */
const GENERIC_TEXT = 'text/*';

/** Types that are text although their name does not start with `text/`. */
const TEXT_LIKE_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/xml',
  'application/x-yaml',
  'application/x-ipynb+json',
  'image/svg+xml'
]);

/** Types a browser or a server reports under another name. */
const MIME_ALIASES = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'application/x-javascript': 'application/javascript'
};

/** The type of a file whose type is missing or generic, by its extension. */
const TYPE_BY_EXTENSION = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  ipynb: 'application/x-ipynb+json',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm'
};

/**
 * The type a file is judged by: its reported type without parameters, an alias
 * resolved, or — when it reports none or `application/octet-stream` — the type
 * its extension stands for.
 *
 * @param {string} [mimeType] - e.g. `text/markdown; charset=utf-8`
 * @param {string} [name] - The file name, for the extension.
 * @returns {string} Lower case; empty when nothing is known.
 *
 * @example
 * fileTypeOf('', 'report.md'); // 'text/markdown'
 * fileTypeOf('image/jpg'); // 'image/jpeg'
 */
export function fileTypeOf(mimeType, name) {
  const reported = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (reported && reported !== 'application/octet-stream') {
    return MIME_ALIASES[reported] || reported;
  }
  const match = /\.([a-z0-9]{1,10})$/i.exec(String(name || ''));
  return (match && TYPE_BY_EXTENSION[match[1].toLowerCase()]) || reported;
}

/** Whether a type is plain text for the `text/*` wildcard. */
function isTextType(type) {
  return type.startsWith('text/') || TEXT_LIKE_TYPES.has(type);
}

/**
 * Whether a list of formats (with the app's defaults) holds a type. Aliases on
 * either side are compared by their canonical name.
 */
function listAccepts(formats, type, { allowTextWildcard = false } = {}) {
  return formats.some(format => {
    const entry = fileTypeOf(format);
    if (allowTextWildcard && entry === GENERIC_TEXT) return isTextType(type);
    return entry === type;
  });
}

/** The formats of one upload category, or its defaults. */
function formatsOf(category, defaults) {
  return Array.isArray(category?.supportedFormats) && category.supportedFormats.length > 0
    ? category.supportedFormats
    : defaults;
}

/**
 * Whether an app's upload settings take a file of this type, the way the
 * composer's local upload does: uploads not switched off for the app, the
 * matching category (`imageUpload`, `audioUpload`, `videoUpload`, `fileUpload`)
 * switched on explicitly, and the type in its `supportedFormats` (or the
 * defaults above). `fileUpload.supportedFormats` may hold `text/*`.
 *
 * @param {Object|null|undefined} app - An app as `GET /api/apps` lists it (with `upload`).
 * @param {{mimeType?: string, name?: string}} file
 * @returns {boolean}
 *
 * @example
 * appUploadAccepts({ upload: { fileUpload: { enabled: true } } }, { mimeType: 'text/markdown' }); // true
 */
export function appUploadAccepts(app, file) {
  const upload = app?.upload;
  if (!upload || upload.enabled === false) return false;
  const type = fileTypeOf(file?.mimeType, file?.name);
  if (!type) return false;
  if (type.startsWith('image/') && type !== 'image/svg+xml') {
    return (
      upload.imageUpload?.enabled === true &&
      listAccepts(formatsOf(upload.imageUpload, DEFAULT_IMAGE_FORMATS), type)
    );
  }
  if (type.startsWith('audio/')) {
    return (
      upload.audioUpload?.enabled === true &&
      listAccepts(formatsOf(upload.audioUpload, DEFAULT_AUDIO_FORMATS), type)
    );
  }
  if (type.startsWith('video/')) {
    return (
      upload.videoUpload?.enabled === true &&
      listAccepts(formatsOf(upload.videoUpload, DEFAULT_VIDEO_FORMATS), type)
    );
  }
  return (
    upload.fileUpload?.enabled === true &&
    listAccepts(formatsOf(upload.fileUpload, DEFAULT_FILE_FORMATS), type, {
      allowTextWildcard: true
    })
  );
}

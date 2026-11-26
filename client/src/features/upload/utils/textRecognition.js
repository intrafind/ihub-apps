// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text recognition at upload (#3986), as the client sees it.
 *
 * An installation-wide vision model (Admin → Chat history → Uploaded files →
 * Text recognition) reads the text of an image (PNG, JPEG, GIF, WebP), or of the
 * PDF pages without a text layer, once when the file is uploaded; the server
 * stores that text as the document's text.
 *
 * - **Projects** use the model whenever one is set
 *   (`GET /api/projects/_config` → `textRecognition.enabled`).
 * - **Chats** use it only when switched on: installation-wide
 *   (`platform.uploads.recognizeText`), overridden per app
 *   (`app.uploads.recognizeText`). The client platform config says both:
 *   `uploads.textRecognition = { available, chats }`, where `available` means a
 *   model is set and `chats` is the installation's opt-in (already false while no
 *   model is set).
 *
 * The rules live here so the composer, the "Use in app…" picker and the cards
 * agree; components only render.
 *
 * @module features/upload/utils/textRecognition
 */

import { fileTypeOf } from './uploadFormats';
import { ORIGINAL_FILE } from '../../chat/utils/chatFileUpload';

/**
 * The image types text recognition can read at most (server:
 * `services/ocr/textRecognition.js` → `OCR_IMAGE_TYPES`); the engine in use may
 * read fewer (see {@link recognizableImageTypes}). `image/jpg` is listed beside
 * `image/jpeg` because apps and browsers use both names.
 */
export const RECOGNIZABLE_IMAGE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp'
]);

/**
 * The image types the installation's engine reads, from the `imageTypes` the
 * server sends with `textRecognition` (`platformConfig.uploads` or the
 * projects configuration): an OCR integration may read fewer than a model
 * (the iFinder OCR service reads no WebP). All of
 * {@link RECOGNIZABLE_IMAGE_TYPES} when the server names none.
 *
 * @param {{imageTypes?: string[]}|null|undefined} textRecognition
 * @returns {string[]}
 *
 * @example
 * recognizableImageTypes({ imageTypes: ['image/png', 'image/jpeg'] });
 * // → ['image/png', 'image/jpeg', 'image/jpg']
 */
export function recognizableImageTypes(textRecognition) {
  const declared = textRecognition?.imageTypes;
  if (!Array.isArray(declared)) return [...RECOGNIZABLE_IMAGE_TYPES];
  return RECOGNIZABLE_IMAGE_TYPES.filter(
    type => declared.includes(type) || (type === 'image/jpg' && declared.includes('image/jpeg'))
  );
}

/**
 * Whether a file is an image text recognition reads, by its type or, when the
 * type is missing or generic, by its extension.
 *
 * @param {string} [mimeType]
 * @param {string} [name]
 * @param {string[]} [types] - The engine's types ({@link recognizableImageTypes}); all by default.
 * @returns {boolean}
 *
 * @example
 * isRecognizableImage('image/png'); // true
 * isRecognizableImage('', 'scan.JPG'); // true
 * isRecognizableImage('image/svg+xml'); // false
 * isRecognizableImage('image/webp', 'a.webp', ['image/png']); // false
 */
export function isRecognizableImage(mimeType, name, types = RECOGNIZABLE_IMAGE_TYPES) {
  const type = fileTypeOf(mimeType, name);
  return Boolean(type) && types.includes(type);
}

/**
 * Whether a text recognition model is set for the installation.
 *
 * @param {Object|null|undefined} uploads - `platformConfig.uploads`.
 * @returns {boolean}
 */
export function textRecognitionAvailable(uploads) {
  return uploads?.textRecognition?.available === true;
}

/**
 * Whether the chats of an app read images and scanned PDFs as text: a model is
 * set, and the app's `uploads.recognizeText` (when it sets one) or else the
 * installation's opt-in says so. Mirrors the server's `chatRecognizesText`.
 *
 * @param {Object|null|undefined} uploads - `platformConfig.uploads`.
 * @param {Object|null|undefined} app - The app; `app.uploads.recognizeText` overrides.
 * @returns {boolean}
 *
 * @example
 * const uploads = { textRecognition: { available: true, chats: false } };
 * chatRecognizesText(uploads, { uploads: { recognizeText: true } }); // true
 * chatRecognizesText(uploads, {}); // false
 */
export function chatRecognizesText(uploads, app) {
  if (!textRecognitionAvailable(uploads)) return false;
  const override = app?.uploads?.recognizeText;
  if (typeof override === 'boolean') return override;
  return uploads?.textRecognition?.chats === true;
}

/**
 * Whether an app's upload settings let the composer take an image as a document
 * to be recognized: uploads not switched off, the composer offers a local upload
 * (one category switched on explicitly, as in `createUploadConfig`), and either
 * documents (on unless switched off) or images are taken. The app's
 * `imageUpload` formats and the model's vision do not matter: the chat model
 * reads the recognized text, not the picture.
 *
 * @param {Object|null|undefined} upload - `app.upload`.
 * @returns {boolean}
 */
export function recognizedImageUploadAllowed(upload) {
  if (!upload || upload.enabled === false) return false;
  const localUpload = ['imageUpload', 'audioUpload', 'videoUpload', 'fileUpload'].some(
    category => upload[category]?.enabled === true
  );
  return (
    localUpload && (upload.fileUpload?.enabled !== false || upload.imageUpload?.enabled === true)
  );
}

/**
 * Whether the composer of a chat sends an attached image to the chat's file
 * store to have its text recognized, instead of sending the picture to the
 * model (`imageData`).
 *
 * Only where the image can reach the server: the chat keeps files on the server
 * (`preUpload`) and the storage mode sends originals (`client_text_only` keeps
 * every original in the browser, so there is nothing to recognize). Everywhere
 * else the composer behaves as without text recognition.
 *
 * @param {Object} params
 * @param {Object|null|undefined} params.uploads - `platformConfig.uploads`.
 * @param {Object|null|undefined} params.app
 * @param {boolean} params.preUpload - `useChatFilePreUpload().enabled`.
 * @param {string} params.mode - The storage mode in force (`resolveUploadMode`).
 * @returns {boolean}
 */
export function composerRecognizesImages({ uploads, app, preUpload, mode }) {
  return Boolean(preUpload) && mode !== 'client_text_only' && chatRecognizesText(uploads, app);
}

/**
 * Whether an app offers to take an image whose text is recognized: a chat app
 * the caller has checked (`isChatApp`), whose uploads take images as documents
 * (`recognizedImageUploadAllowed`) and whose chats recognize text.
 *
 * @param {Object|null|undefined} app
 * @param {Object|null|undefined} uploads - `platformConfig.uploads`.
 * @returns {boolean}
 */
export function appRecognizesImages(app, uploads) {
  return recognizedImageUploadAllowed(app?.upload) && chatRecognizesText(uploads, app);
}

/**
 * The composer entry of an image whose text the server recognizes: a document
 * with no text of its own yet, carrying the file for the pre-upload
 * (`useChatFilePreUpload`). Until the server stored it (`fileId`) it is not
 * sent with a message (see `awaitsRecognition`).
 *
 * @param {File} file
 * @param {string} mimeType - Its canonical type.
 * @param {string} displayType - The label the chip shows (PNG, JPEG, …).
 * @returns {{preview: Object, data: Object}} What an uploader's `processFile` returns.
 */
export function recognizedImageAttachment(file, mimeType, displayType) {
  return {
    preview: {
      type: 'document',
      fileName: file.name,
      fileType: displayType,
      content: ''
    },
    data: {
      type: 'document',
      source: 'local',
      // The file itself: the server reads it
      [ORIGINAL_FILE]: file,
      content: '',
      fileName: file.name,
      fileSize: file.size,
      fileType: mimeType,
      displayType,
      recognizeOnUpload: true
    }
  };
}

/**
 * Whether a composer entry is an image waiting for the server to recognize its
 * text (or whose recognition failed): it holds nothing the model could read, so
 * it is not sent with a message.
 *
 * @param {Object|null|undefined} entry
 * @returns {boolean}
 */
export function awaitsRecognition(entry) {
  return (
    entry?.recognizeOnUpload === true &&
    !(entry.serverStored === true && typeof entry.fileId === 'string' && entry.fileId)
  );
}

/**
 * What the server recorded about a recognition, from wherever a descriptor
 * carries it: a stored chat file (`meta.recognized`), a composer entry or a
 * transcript descriptor (`recognized`), a project item's text (`text.recognized`).
 *
 * `engine` names who recognized it: the text recognition model, or the OCR
 * integration the installation uses instead.
 *
 * @param {Object|null|undefined} source
 * @returns {{modelId: string, integrationId: string, engine: string, pages: number, truncated: boolean, failedPages: number, at?: string}|null}
 */
export function recognitionOf(source) {
  const recognized = source?.recognized || source?.meta?.recognized || source?.text?.recognized;
  if (!recognized || typeof recognized !== 'object') return null;
  const pages = Number(recognized.pages);
  const modelId = typeof recognized.modelId === 'string' ? recognized.modelId : '';
  const integrationId =
    typeof recognized.integrationId === 'string' ? recognized.integrationId : '';
  return {
    modelId,
    integrationId,
    engine: modelId || integrationId,
    pages: Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : 0,
    truncated: recognized.truncated === true,
    failedPages:
      Number.isFinite(Number(recognized.failedPages)) && Number(recognized.failedPages) > 0
        ? Math.floor(Number(recognized.failedPages))
        : 0,
    ...(typeof recognized.at === 'string' ? { at: recognized.at } : {})
  };
}

/**
 * "Text recognized from 3 page(s)" (or "…from the first 50 page(s) only" when
 * the page limit cut it), for a chip, a card or a project row.
 *
 * @param {ReturnType<typeof recognitionOf>} recognized
 * @param {Function} t - i18next `t`.
 * @returns {string|null}
 */
export function recognitionLabel(recognized, t) {
  if (!recognized) return null;
  if (recognized.pages <= 0) {
    return t('textRecognition.recognized', 'Text recognized');
  }
  if (recognized.failedPages > 0) {
    return t(
      'textRecognition.recognizedPagesFailed',
      'Text recognized from {{count}} page(s); {{failed}} page(s) could not be read',
      { count: recognized.pages, failed: recognized.failedPages }
    );
  }
  return recognized.truncated
    ? t(
        'textRecognition.recognizedPagesTruncated',
        'Text recognized from the first {{count}} page(s) only',
        { count: recognized.pages }
      )
    : t('textRecognition.recognizedPages', 'Text recognized from {{count}} page(s)', {
        count: recognized.pages
      });
}

/**
 * The tooltip naming the engine (model or OCR integration) that recognized the text.
 *
 * @param {ReturnType<typeof recognitionOf>} recognized
 * @param {Function} t - i18next `t`.
 * @returns {string|undefined}
 */
export function recognitionTitle(recognized, t) {
  if (!recognized?.engine) return undefined;
  return t('textRecognition.recognizedBy', 'Recognized by {{model}}', {
    model: recognized.engine
  });
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text recognition at upload (#3986): the text of an image, or of the pages of
 * a PDF that have no text layer (scanned pages), recognized once by the
 * installation's OCR model and stored like any other extracted text. Every
 * model can then read the document, with or without vision, and no turn pays
 * for the recognition again.
 *
 * Settings (`platform.ocr`):
 *
 *  - `modelId`: the vision-capable model that recognizes text. Unset, nothing
 *    is recognized and uploads behave as without OCR (an image is refused, a
 *    scanned PDF fails with `NO_TEXT`).
 *  - `maxPages`: the most pages recognized per document. Pages past it keep
 *    their "no extractable text" marker; the result says it was cut.
 *
 * Projects use it whenever a model is set. Chat uploads use it only where it
 * is switched on (`platform.uploads.recognizeText`, overridable per app with
 * `app.uploads.recognizeText`); otherwise a chat still sends a scanned PDF as
 * page images.
 *
 * Only pages without text are sent to the model, never a page that has a text
 * layer: a logo on a text page costs nothing.
 *
 * @module services/ocr/textRecognition
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/**
 * The model call, PDF rendering, key lookup and audit, loaded on first use:
 * the ingest pipelines import this module for its settings and checks, and the
 * model client's imports reach back into the projects.
 */
let heavy = null;
async function heavyParts() {
  if (!heavy) {
    const [pages, utils, audit] = await Promise.all([
      import('./pageRecognition.js'),
      import('../../utils.js'),
      import('../AuditLogService.js')
    ]);
    heavy = {
      DEFAULT_OCR_PROMPT: pages.DEFAULT_OCR_PROMPT,
      extractTextFromPageImage: pages.extractTextFromPageImage,
      loadPdfDocument: pages.loadPdfDocument,
      pMap: pages.pMap,
      renderPageToImage: pages.renderPageToImage,
      resolveModelApiKey: utils.resolveModelApiKey,
      logAudit: audit.logAudit
    };
  }
  return heavy;
}

const COMPONENT = 'TextRecognition';

/** Image types a vision model reads. */
export const OCR_IMAGE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

/** File extensions of {@link OCR_IMAGE_TYPES}, for an upload's accept list. */
export const OCR_IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** Pages recognized per document when the admin set no limit. */
export const DEFAULT_OCR_MAX_PAGES = 50;

/** Pages sent to the model at the same time. */
const PAGE_CONCURRENCY = 3;

/** `[Page 3: no extractable text]`, as the PDF extraction writes it. */
const NO_TEXT_PAGE = /^\[Page (\d+): no extractable text\]$/;

/**
 * A recognition that cannot run or failed. Codes: `OCR_UNAVAILABLE` (no model
 * set, or the model cannot be used), `OCR_FAILED` (the model refused or every
 * page failed), `OCR_NO_TEXT` (the model found no text).
 */
export class TextRecognitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TextRecognitionError';
    this.code = code;
  }
}

/**
 * The OCR settings of the installation.
 *
 * @param {Object} [platform]
 * @returns {{modelId: string|null, maxPages: number, enabled: boolean}}
 */
export function ocrSettings(platform = configCache.getPlatform?.() || {}) {
  const ocr = platform?.ocr || {};
  const modelId = typeof ocr.modelId === 'string' && ocr.modelId.trim() ? ocr.modelId.trim() : null;
  const maxPages =
    Number.isFinite(Number(ocr.maxPages)) && Number(ocr.maxPages) > 0
      ? Math.floor(Number(ocr.maxPages))
      : DEFAULT_OCR_MAX_PAGES;
  return { modelId, maxPages, enabled: Boolean(modelId) };
}

/**
 * Whether chat uploads of this app recognize text: an OCR model is set and the
 * opt-in is on (`app.uploads.recognizeText` over `platform.uploads.recognizeText`).
 *
 * @param {Object} [platform]
 * @param {Object|null} [appConfig]
 * @returns {boolean}
 */
export function chatRecognizesText(platform = configCache.getPlatform?.() || {}, appConfig = null) {
  if (!ocrSettings(platform).enabled) return false;
  const override = appConfig?.uploads?.recognizeText;
  if (typeof override === 'boolean') return override;
  return platform?.uploads?.recognizeText === true;
}

/** Whether a media type is an image the OCR model reads. */
export function isRecognizableImage(mimeType) {
  return OCR_IMAGE_TYPES.includes(
    String(mimeType || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
  );
}

/**
 * The image type of these bytes, by their signature, when the OCR model reads
 * it: PNG, JPEG, GIF or WebP. The bytes decide, not the declared type.
 *
 * @param {Buffer|Uint8Array} bytes - The file, or at least its first 12 bytes.
 * @returns {string|null}
 */
export function recognizableImageTypeOf(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const head = Buffer.from(bytes.subarray(0, 12));
  const hex = head.toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (
    head.length >= 12 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Image file extensions the OCR model reads, for a type check by name. */
const OCR_IMAGE_TYPE_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
]);

/**
 * The image type a file declares, by its media type or its name, when it is
 * one the OCR model reads (a check before the bytes are there).
 *
 * @param {{contentType?: string, name?: string}} file
 * @returns {string|null}
 */
export function declaredRecognizableImageType({ contentType, name } = {}) {
  const declared = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (isRecognizableImage(declared)) return declared;
  const dot = String(name || '').lastIndexOf('.');
  return dot >= 0
    ? OCR_IMAGE_TYPE_BY_EXTENSION.get(String(name).slice(dot).toLowerCase()) || null
    : null;
}

/**
 * The OCR model and its API key, decided once per document.
 *
 * @param {{modelId: string|null}} settings
 * @returns {Promise<{model: Object, apiKey: string|null}>}
 * @throws {TextRecognitionError} `OCR_UNAVAILABLE`
 */
async function resolveOcrModel(settings) {
  if (!settings.modelId) {
    throw new TextRecognitionError('OCR_UNAVAILABLE', 'No model is set for text recognition');
  }
  const { data: models = [] } = configCache.getModels?.() || {};
  const model = models.find(entry => entry.id === settings.modelId);
  if (!model || model.enabled === false) {
    throw new TextRecognitionError(
      'OCR_UNAVAILABLE',
      `The text recognition model ${settings.modelId} is not available`
    );
  }
  if (!(model.supportsImages || model.supportsVision)) {
    throw new TextRecognitionError(
      'OCR_UNAVAILABLE',
      `The text recognition model ${settings.modelId} cannot read images`
    );
  }
  const { resolveModelApiKey } = await heavyParts();
  const resolution = await resolveModelApiKey(model.id);
  if (resolution.state !== 'ok' && resolution.state !== 'keyless') {
    throw new TextRecognitionError(
      'OCR_UNAVAILABLE',
      `The text recognition model ${settings.modelId} has no usable API key`
    );
  }
  // A keyless model is an explicit decision: '' sends no Authorization header.
  return { model, apiKey: resolution.state === 'keyless' ? '' : resolution.apiKey };
}

/** Recognize one page image; a refusal by the model (4xx) stops the document. */
async function recognizePage(base64, mimeType, { model, apiKey, pageNum }) {
  const { extractTextFromPageImage, DEFAULT_OCR_PROMPT } = await heavyParts();
  try {
    const text = await extractTextFromPageImage(
      base64,
      model,
      apiKey,
      pageNum,
      DEFAULT_OCR_PROMPT,
      mimeType
    );
    return { text: String(text || '').trim() };
  } catch (error) {
    const status = error?.status ?? error?.statusCode;
    if (status && status >= 400 && status < 500) {
      throw new TextRecognitionError(
        'OCR_FAILED',
        `The text recognition model refused the request (${status})`
      );
    }
    logger.warn('Text recognition failed for a page', {
      component: COMPONENT,
      page: pageNum,
      error: error?.message
    });
    return { text: '', failed: true };
  }
}

async function audit({ user, name, modelId, pages }) {
  const { logAudit } = await heavyParts();
  logAudit({
    actor: user || undefined,
    action: 'execute',
    resource: 'textRecognition',
    resourceId: modelId,
    summary: `Recognized the text of ${pages} page${pages === 1 ? '' : 's'} of "${String(
      name || 'a file'
    ).slice(0, 200)}" with model ${modelId}`
  });
}

/**
 * Recognize the text of an image.
 *
 * @param {Buffer} bytes
 * @param {string} mimeType - One of {@link OCR_IMAGE_TYPES}.
 * @param {Object} [options]
 * @param {Object} [options.platform]
 * @param {Object} [options.user] - Who uploaded it (audit).
 * @param {string} [options.name]
 * @returns {Promise<{text: string, recognition: {modelId: string, pages: number, at: string}}>}
 * @throws {TextRecognitionError}
 */
export async function recognizeImage(bytes, mimeType, { platform, user, name } = {}) {
  const settings = ocrSettings(platform);
  if (!isRecognizableImage(mimeType)) {
    throw new TextRecognitionError('OCR_UNAVAILABLE', `Images of type ${mimeType} cannot be read`);
  }
  const { model, apiKey } = await resolveOcrModel(settings);
  const { text, failed } = await recognizePage(bytes.toString('base64'), mimeType, {
    model,
    apiKey,
    pageNum: 1
  });
  if (failed)
    throw new TextRecognitionError('OCR_FAILED', 'The text of the image could not be recognized');
  if (!text) throw new TextRecognitionError('OCR_NO_TEXT', 'No text was found in the image');
  await audit({ user, name, modelId: model.id, pages: 1 });
  return { text, recognition: { modelId: model.id, pages: 1, at: new Date().toISOString() } };
}

/**
 * The pages an extracted PDF text marks as having no extractable text.
 *
 * @param {string} extractedText
 * @returns {number[]}
 */
export function pagesWithoutText(extractedText) {
  const pages = [];
  for (const line of String(extractedText || '').split('\n')) {
    const match = NO_TEXT_PAGE.exec(line.trim());
    if (match) pages.push(Number(match[1]));
  }
  return pages;
}

/**
 * Put recognized page texts in place of the "no extractable text" markers.
 *
 * @param {string} extractedText
 * @param {Map<number, string>} recognized - Page number → text.
 * @returns {string}
 */
export function mergeRecognizedPages(extractedText, recognized) {
  return String(extractedText || '')
    .split('\n')
    .map(line => {
      const match = NO_TEXT_PAGE.exec(line.trim());
      if (!match) return line;
      const text = recognized.get(Number(match[1]));
      return text ? `[Page ${match[1]}]\n${text}` : line;
    })
    .join('\n');
}

/** The text of recognized pages alone, for a PDF without any text layer. */
function recognizedPagesText(numPages, recognized) {
  const blocks = [];
  for (let page = 1; page <= numPages; page += 1) {
    const text = recognized.get(page);
    blocks.push(text ? `[Page ${page}]\n${text}` : `[Page ${page}: no extractable text]`);
  }
  return blocks.join('\n\n');
}

/**
 * Recognize the pages of a PDF that have no text.
 *
 * With `extractedText` (the PDF's text as extracted, with its page markers),
 * the pages it marks as having no extractable text are recognized and their
 * text is put in place of the markers; a PDF with no such page is returned as
 * `null` (nothing to do). Without it (the extraction found no text layer at
 * all), every page is recognized.
 *
 * @param {Buffer} bytes
 * @param {Object} [options]
 * @param {string|null} [options.extractedText]
 * @param {Object} [options.platform]
 * @param {Object} [options.user]
 * @param {string} [options.name]
 * @returns {Promise<{text: string, recognition: {modelId: string, pages: number, truncated?: boolean, at: string}}|null>}
 * @throws {TextRecognitionError}
 */
export async function recognizeScannedPdf(
  bytes,
  { extractedText = null, platform, user, name } = {}
) {
  const settings = ocrSettings(platform);
  const { loadPdfDocument, pMap, renderPageToImage } = await heavyParts();
  let wanted;
  let numPages = 0;
  if (typeof extractedText === 'string' && extractedText) {
    wanted = pagesWithoutText(extractedText);
    if (wanted.length === 0) return null;
  } else {
    const doc = await loadPdfDocument(bytes);
    try {
      numPages = doc.numPages;
    } finally {
      await doc.destroy?.();
    }
    wanted = Array.from({ length: numPages }, (_, i) => i + 1);
  }
  const { model, apiKey } = await resolveOcrModel(settings);
  const chosen = wanted.slice(0, settings.maxPages);
  const recognized = new Map();
  let failures = 0;
  await pMap(
    chosen,
    async pageNum => {
      const base64 = await renderPageToImage(bytes, pageNum - 1);
      const result = await recognizePage(base64, 'image/png', { model, apiKey, pageNum });
      if (result.failed) failures += 1;
      else if (result.text) recognized.set(pageNum, result.text);
    },
    PAGE_CONCURRENCY
  );
  if (recognized.size === 0) {
    throw new TextRecognitionError(
      failures > 0 ? 'OCR_FAILED' : 'OCR_NO_TEXT',
      failures > 0
        ? 'The text of the scanned pages could not be recognized'
        : 'No text was found on the scanned pages'
    );
  }
  await audit({ user, name, modelId: model.id, pages: recognized.size });
  const text =
    typeof extractedText === 'string' && extractedText
      ? mergeRecognizedPages(extractedText, recognized)
      : recognizedPagesText(numPages, recognized);
  return {
    text,
    recognition: {
      modelId: model.id,
      pages: recognized.size,
      ...(wanted.length > chosen.length || failures > 0 ? { truncated: true } : {}),
      at: new Date().toISOString()
    }
  };
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text recognition at upload (#3986): the text of an image, or of the pages of
 * a PDF that have no text layer (scanned pages), recognized once by the
 * installation's OCR engine and stored like any other extracted text. Every
 * model can then read the document, with or without vision, and no turn pays
 * for the recognition again.
 *
 * Settings (`platform.ocr`):
 *
 *  - `engine`: who recognizes the text. `model` (the default) is a
 *    vision-capable model of the installation (`modelId`); any other value is
 *    the id of an installed integration of type `ocr`, whose `recognize`
 *    action gets one image at a time (the **OCR engine contract**, see
 *    `docs/integration-development.md`). iHub ships one: the iFinder OCR
 *    service (`com.intrafind/ifinder-ocr`).
 *  - `modelId`: the vision-capable model of the `model` engine. Unset, the
 *    `model` engine recognizes nothing and uploads behave as without OCR (an
 *    image is refused, a scanned PDF fails with `NO_TEXT`).
 *  - `maxPages`: the most pages recognized per document. Pages past it keep
 *    their "no extractable text" marker; the result says it was cut.
 *
 * Projects use it whenever a model is set. Chat uploads use it only where it
 * is switched on (`platform.uploads.recognizeText`, overridable per app with
 * `app.uploads.recognizeText`); otherwise a chat still sends a scanned PDF as
 * page images.
 *
 * Only pages without text are sent to the engine, never a page that has a text
 * layer: a logo on a text page costs nothing. A PDF page goes to the engine as
 * a PNG image, whatever the engine, so an engine only ever reads images.
 *
 * @module services/ocr/textRecognition
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/**
 * The model call, PDF rendering, key lookup, integration runner and audit,
 * loaded on first use: the ingest pipelines import this module for its
 * settings and checks, and the model client's and the integrations' imports
 * reach back into the projects.
 */
let heavy = null;
async function heavyParts() {
  if (!heavy) {
    const [pages, utils, audit, installed, protocols, usage] = await Promise.all([
      import('./pageRecognition.js'),
      import('../../utils.js'),
      import('../AuditLogService.js'),
      import('../integrations/InstalledIntegrationService.js'),
      import('../integrations/protocols/index.js'),
      import('../integrations/actionUsage.js')
    ]);
    heavy = {
      DEFAULT_OCR_PROMPT: pages.DEFAULT_OCR_PROMPT,
      extractTextFromPageImage: pages.extractTextFromPageImage,
      loadPdfDocument: pages.loadPdfDocument,
      pMap: pages.pMap,
      renderPageToImage: pages.renderPageToImage,
      resolveModelApiKey: utils.resolveModelApiKey,
      logAudit: audit.logAudit,
      installedIntegrationService: installed.default,
      getProtocolAdapter: protocols.getProtocolAdapter,
      recordActionEvent: usage.recordActionEvent
    };
  }
  return heavy;
}

/** The `platform.ocr.engine` value of the vision-model engine (the default). */
export const MODEL_ENGINE = 'model';

/** The integration type of an OCR engine. */
export const OCR_INTEGRATION_TYPE = 'ocr';

/** The one action iHub calls on an OCR integration (the engine contract). */
export const OCR_RECOGNIZE_ACTION = 'recognize';

/** The installations file, as `InstalledIntegrationService` reads it from the config cache. */
const INTEGRATIONS_FILE = 'config/integrations.json';

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
 * A recognition that cannot run or failed. Codes: `OCR_UNAVAILABLE` (no
 * engine set, or it cannot be used), `OCR_FAILED` (the engine refused or every
 * page failed), `OCR_NO_TEXT` (the engine found no text).
 */
export class TextRecognitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TextRecognitionError';
    this.code = code;
  }
}

/**
 * Whether an installation exists and is switched on, as far as the config
 * cache knows (a sync check for the upload paths; the recognition itself
 * checks the definition too).
 * @param {string} instanceId
 * @returns {boolean}
 */
function integrationIsOn(instanceId) {
  const installed = configCache.get?.(INTEGRATIONS_FILE)?.data?.installed;
  if (!Array.isArray(installed)) return false;
  const instance = installed.find(entry => entry?.id === instanceId);
  return Boolean(instance) && instance.enabled !== false;
}

/**
 * The OCR settings of the installation.
 *
 * `engine` is `model` or the id of an OCR integration; `enabled` says whether
 * that engine can be asked at all: a model is set (`model`), or the
 * integration is installed and switched on.
 *
 * @param {Object} [platform]
 * @returns {{engine: string, modelId: string|null, integrationId: string|null, maxPages: number, enabled: boolean}}
 */
export function ocrSettings(platform = configCache.getPlatform?.() || {}) {
  const ocr = platform?.ocr || {};
  const modelId = typeof ocr.modelId === 'string' && ocr.modelId.trim() ? ocr.modelId.trim() : null;
  const named = typeof ocr.engine === 'string' ? ocr.engine.trim() : '';
  const engine = named && named !== MODEL_ENGINE ? named : MODEL_ENGINE;
  const integrationId = engine === MODEL_ENGINE ? null : engine;
  const maxPages =
    Number.isFinite(Number(ocr.maxPages)) && Number(ocr.maxPages) > 0
      ? Math.floor(Number(ocr.maxPages))
      : DEFAULT_OCR_MAX_PAGES;
  const enabled = integrationId ? integrationIsOn(integrationId) : Boolean(modelId);
  return { engine, modelId, integrationId, maxPages, enabled };
}

/**
 * Whether chat uploads of this app recognize text: an OCR engine is ready and
 * the opt-in is on (`app.uploads.recognizeText` over `platform.uploads.recognizeText`).
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

/** Whether a media type is an image the OCR engines read. */
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

/**
 * The status of a failed engine call, when it has one: a 4xx is a refusal of
 * the request itself (a bad key, a type the engine does not read), which no
 * other page would get past.
 */
function refusalStatusOf(error) {
  const status = Number(error?.status ?? error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
}

/** A page whose recognition failed for a reason that may not hit the next page. */
function failedPage(pageNum, error, engineLabel) {
  logger.warn('Text recognition failed for a page', {
    component: COMPONENT,
    engine: engineLabel,
    page: pageNum,
    error: error?.message
  });
  return { text: '', failed: true };
}

/** The vision-model engine. */
async function modelEngine(settings) {
  const { model, apiKey } = await resolveOcrModel(settings);
  const { extractTextFromPageImage, DEFAULT_OCR_PROMPT } = await heavyParts();
  return {
    label: `model ${model.id}`,
    record: { modelId: model.id },
    auditId: model.id,
    /** Recognize one page image; a refusal by the model (4xx) stops the document. */
    async recognize(base64, mimeType, { pageNum }) {
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
        const status = refusalStatusOf(error);
        if (status) {
          throw new TextRecognitionError(
            'OCR_FAILED',
            `The text recognition model refused the request (${status})`
          );
        }
        return failedPage(pageNum, error, model.id);
      }
    }
  };
}

/**
 * The text an OCR integration's `recognize` action answered: a string, or an
 * object with `text` (a string) or `pages` (a list of `{ text }`). A tool
 * error (`{ error: true, message, status? }`) is thrown with its status.
 *
 * @param {*} result
 * @returns {string}
 */
export function recognizedTextOf(result) {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object') {
    if (result.error === true || typeof result.error === 'string') {
      const error = new Error(
        String(
          result.message || (typeof result.error === 'string' ? result.error : '') || 'failed'
        ).slice(0, 500)
      );
      if (result.status !== undefined) error.status = result.status;
      throw error;
    }
    if (typeof result.text === 'string') return result.text.trim();
    if (Array.isArray(result.pages)) {
      return result.pages
        .map(page => (typeof page === 'string' ? page : page?.text))
        .filter(text => typeof text === 'string' && text.trim())
        .map(text => text.trim())
        .join('\n\n');
    }
  }
  throw new Error('The OCR integration answered without a text');
}

/**
 * The OCR integration engine: the installation's `recognize` action, called
 * through its protocol adapter. The admin picked it for the whole
 * installation, so it runs for every user, whatever their integration grants.
 */
async function integrationEngine(settings) {
  const { installedIntegrationService, getProtocolAdapter, recordActionEvent } = await heavyParts();
  const id = settings.integrationId;
  const resolved = await installedIntegrationService.resolve(id, 'en');
  const unavailable = reason =>
    new TextRecognitionError('OCR_UNAVAILABLE', `The text recognition integration ${id} ${reason}`);
  if (!resolved) throw unavailable('is not installed');
  if (!resolved.definition) throw unavailable('has no definition');
  if (resolved.definition.type !== OCR_INTEGRATION_TYPE) {
    throw unavailable('is not an OCR integration');
  }
  if (resolved.incompatible || resolved.blocked) {
    throw unavailable(
      `cannot run: ${resolved.statusReason || resolved.migration?.statusReason || 'see Admin → Integrations'}`
    );
  }
  if (resolved.instance.enabled === false) throw unavailable('is switched off');
  const action = resolved.definition.actions.find(entry => entry.name === OCR_RECOGNIZE_ACTION);
  if (!action) throw unavailable(`has no ${OCR_RECOGNIZE_ACTION} action`);
  const adapter = getProtocolAdapter(resolved.definition.protocol.type);
  return {
    label: `integration ${id}`,
    record: { integrationId: id },
    auditId: id,
    /** Recognize one image; a refusal by the engine (4xx) stops the document. */
    async recognize(base64, mimeType, { pageNum, name, user }) {
      recordActionEvent(id, OCR_RECOGNIZE_ACTION, 'call');
      try {
        const result = await adapter.run({
          definition: resolved.definition,
          instance: resolved.instance,
          document: resolved.document,
          security: resolved.security,
          action,
          args: { content: base64, mimeType, ...(name ? { name: String(name) } : {}) },
          context: { user, params: { user } }
        });
        return { text: recognizedTextOf(result) };
      } catch (error) {
        recordActionEvent(id, OCR_RECOGNIZE_ACTION, 'error');
        const status = refusalStatusOf(error);
        if (status) {
          throw new TextRecognitionError(
            'OCR_FAILED',
            `The text recognition integration ${id} refused the request (${status}): ${String(
              error?.message || ''
            ).slice(0, 300)}`
          );
        }
        return failedPage(pageNum, error, id);
      }
    }
  };
}

/**
 * The engine of these settings, decided once per document.
 * @throws {TextRecognitionError} `OCR_UNAVAILABLE`
 */
async function resolveEngine(settings) {
  return settings.integrationId ? integrationEngine(settings) : modelEngine(settings);
}

async function audit({ user, name, engine, pages }) {
  const { logAudit } = await heavyParts();
  logAudit({
    actor: user || undefined,
    action: 'execute',
    resource: 'textRecognition',
    resourceId: engine.auditId,
    summary: `Recognized the text of ${pages} page${pages === 1 ? '' : 's'} of "${String(
      name || 'a file'
    ).slice(0, 200)}" with ${engine.label}`
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
 * @returns {Promise<{text: string, recognition: {modelId?: string, integrationId?: string, pages: number, at: string}}>}
 * @throws {TextRecognitionError}
 */
export async function recognizeImage(bytes, mimeType, { platform, user, name } = {}) {
  const settings = ocrSettings(platform);
  if (!isRecognizableImage(mimeType)) {
    throw new TextRecognitionError('OCR_UNAVAILABLE', `Images of type ${mimeType} cannot be read`);
  }
  const engine = await resolveEngine(settings);
  const { text, failed } = await engine.recognize(bytes.toString('base64'), mimeType, {
    pageNum: 1,
    name,
    user
  });
  if (failed)
    throw new TextRecognitionError('OCR_FAILED', 'The text of the image could not be recognized');
  if (!text) throw new TextRecognitionError('OCR_NO_TEXT', 'No text was found in the image');
  await audit({ user, name, engine, pages: 1 });
  return { text, recognition: { ...engine.record, pages: 1, at: new Date().toISOString() } };
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
 * @returns {Promise<{text: string, recognition: {modelId?: string, integrationId?: string, pages: number, truncated?: boolean, at: string}}|null>}
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
  const engine = await resolveEngine(settings);
  const chosen = wanted.slice(0, settings.maxPages);
  const recognized = new Map();
  let failures = 0;
  await pMap(
    chosen,
    async pageNum => {
      const base64 = await renderPageToImage(bytes, pageNum - 1);
      const result = await engine.recognize(base64, 'image/png', { pageNum, name, user });
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
  await audit({ user, name, engine, pages: recognized.size });
  const text =
    typeof extractedText === 'string' && extractedText
      ? mergeRecognizedPages(extractedText, recognized)
      : recognizedPagesText(numPages, recognized);
  return {
    text,
    recognition: {
      ...engine.record,
      pages: recognized.size,
      ...(wanted.length > chosen.length || failures > 0 ? { truncated: true } : {}),
      at: new Date().toISOString()
    }
  };
}

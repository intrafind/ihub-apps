// Shared file processing utilities for upload components
import { fetchMimetypesConfig, fetchPlatformConfig } from '../../../api/endpoints/config';
import { FeatureFlags } from '../../../../../shared/featureFlags.js';
import { extractDocxMarkdown } from '../../../../../shared/documentExtraction/docx.js';
import { extractPdfText } from '../../../../../shared/documentExtraction/pdfText.js';
import { extractPptxText } from '../../../../../shared/documentExtraction/pptx.js';
import { extractOdfText } from '../../../../../shared/documentExtraction/odf.js';
import { extractXlsxText } from '../../../../../shared/documentExtraction/xlsx.js';
import {
  MIN_REAL_TEXT_CHARS,
  lastPageWithText,
  realTextLength
} from '../../../../../shared/documentExtraction/markers.js';
import {
  createProgressReporter,
  itemProgress
} from '../../../../../shared/documentExtraction/progress.js';
// Resolved by Vite at build time → copied to dist as a local asset.
// Using the ?url suffix is the correct Vite pattern for worker files from
// node_modules; it ensures offline/air-gapped deployments work and the
// version always tracks the installed pdfjs-dist package.
//
// This is the LEGACY worker on purpose, and it must stay paired with the legacy library
// imported in `loadPdfjs`. The modern build calls `Map.prototype.getOrInsertComputed`
// (TC39 "upsert"), which many current browsers do not implement yet, so encrypted PDFs fail
// to parse and no page can be rendered. The legacy build bundles its own polyfill for it —
// in the library and, because a worker has its own global scope, in the worker as well.
// Mixing a modern library with a legacy worker (or the reverse) would leave one of the two
// without the polyfill. tests/unit/client/pdfjs-legacy-build.test.jsx guards both imports.
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { audioBufferToWavAsync } from '../../../utils/wav';
import { TARGET_SAMPLE_RATE, resampleTo16kMono } from '../../../utils/realtimeTranscriptionCore';
import {
  createAbortError,
  isAbortError,
  raceAbort,
  throwIfAborted,
  yieldToEventLoop
} from '../../../utils/abortable';

// Cache for mimetypes configuration
let mimetypesConfigCache = null;
let mimetypesConfigPromise = null;

// Wildcard entry an admin can add to `fileUpload.supportedFormats` to accept
// any file whose content is plain text, regardless of its extension or the
// (often missing) MIME type the browser reports — e.g. `.log`, `.yaml`, `.srt`.
export const GENERIC_TEXT_MIME_TYPE = 'text/*';

// Build default config from new structure for backward compatibility
const buildDefaultConfig = () => {
  return {
    categories: {
      images: {
        name: { en: 'Images', de: 'Bilder' },
        mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
      },
      audio: {
        name: { en: 'Audio', de: 'Audio' },
        mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/mp4']
      },
      video: {
        name: { en: 'Video', de: 'Video' },
        mimeTypes: ['video/mp4', 'video/webm']
      },
      documents: {
        name: { en: 'Documents', de: 'Dokumente' },
        mimeTypes: [
          'text/plain',
          'text/markdown',
          'text/vtt',
          'application/json',
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ]
      }
    },
    mimeTypes: {
      'image/jpeg': { extensions: ['.jpeg', '.jpg'], displayName: 'JPEG', category: 'images' },
      'image/png': { extensions: ['.png'], displayName: 'PNG', category: 'images' },
      'image/gif': { extensions: ['.gif'], displayName: 'GIF', category: 'images' },
      'image/webp': { extensions: ['.webp'], displayName: 'WEBP', category: 'images' },
      'audio/mpeg': { extensions: ['.mp3'], displayName: 'MP3', category: 'audio' },
      'audio/wav': { extensions: ['.wav'], displayName: 'WAV', category: 'audio' },
      'audio/mp4': { extensions: ['.m4a', '.mp4'], displayName: 'MP4 Audio', category: 'audio' },
      'video/mp4': { extensions: ['.mp4'], displayName: 'MP4', category: 'video' },
      'video/webm': { extensions: ['.webm'], displayName: 'WEBM', category: 'video' },
      'application/pdf': { extensions: ['.pdf'], displayName: 'PDF', category: 'documents' },
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
        extensions: ['.docx'],
        displayName: 'DOCX',
        category: 'documents'
      },
      'text/plain': { extensions: ['.txt'], displayName: 'TXT', category: 'documents' },
      'text/markdown': { extensions: ['.md'], displayName: 'MD', category: 'documents' },
      'text/vtt': { extensions: ['.vtt'], displayName: 'VTT', category: 'documents' },
      'application/json': { extensions: ['.json'], displayName: 'JSON', category: 'documents' }
    }
  };
};

const DEFAULT_CONFIG = buildDefaultConfig();

/**
 * Load mimetypes configuration from server
 * Uses caching to avoid repeated API calls
 */
export const loadMimetypesConfig = async () => {
  // Return cached config if available
  if (mimetypesConfigCache) {
    return mimetypesConfigCache;
  }

  // Return existing promise if already loading
  if (mimetypesConfigPromise) {
    return mimetypesConfigPromise;
  }

  // Start loading and cache the promise
  mimetypesConfigPromise = fetchMimetypesConfig()
    .then(config => {
      mimetypesConfigCache = config;
      mimetypesConfigPromise = null;
      return config;
    })
    .catch(error => {
      console.error('Failed to load mimetypes configuration, using defaults:', error);
      mimetypesConfigPromise = null;
      // Use default configuration on error
      mimetypesConfigCache = DEFAULT_CONFIG;
      return DEFAULT_CONFIG;
    });

  return mimetypesConfigPromise;
};

/**
 * Get current mimetypes config (synchronous)
 * Returns default config if not loaded yet
 */
const getConfig = () => mimetypesConfigCache || DEFAULT_CONFIG;

/**
 * Get MIME types for a specific category
 * @param {string} category - Category name (e.g., 'images', 'audio', 'documents', 'text')
 * @returns {string[]} Array of MIME types in the category
 */
export const getMimeTypesByCategory = category => {
  const config = getConfig();
  return config.categories[category]?.mimeTypes || [];
};

/**
 * Get all MIME types from multiple categories
 * @param {string[]} categories - Array of category names
 * @returns {string[]} Array of MIME types
 */
export const getMimeTypesByCategories = categories => {
  const config = getConfig();
  const mimeTypes = [];
  categories.forEach(category => {
    const categoryMimeTypes = config.categories[category]?.mimeTypes || [];
    mimeTypes.push(...categoryMimeTypes);
  });
  return [...new Set(mimeTypes)]; // Remove duplicates
};

// Browsers report one audio format under several MIME types: Chrome and Safari on macOS call a
// QuickTime ".m4a" export `audio/x-m4a`, Windows browsers call a ".wav" `audio/x-wav`. The
// configured formats only list the canonical type, so these map to it.
const MIME_TYPE_ALIASES = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-flac': 'audio/flac'
};

/**
 * Canonical MIME type of a file: known aliases map to the type the configuration lists
 * (`audio/x-m4a` → `audio/mp4`). When the browser reports no type (or the generic
 * `application/octet-stream`) the type comes from the file extension, as far as the extension
 * identifies exactly one audio/video type — `.mp4` is both `audio/mp4` and `video/mp4`, so it
 * stays as reported. Every other type is returned unchanged.
 * @param {string} type - MIME type as reported by the browser (`file.type`)
 * @param {string} [fileName] - File name, used when the type is empty or generic
 * @returns {string} Canonical MIME type
 */
export const canonicalMimeType = (type, fileName = '') => {
  const alias = MIME_TYPE_ALIASES[(type || '').trim().toLowerCase()];
  if (alias) return alias;
  if (type && type !== 'application/octet-stream') return type;

  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return type || '';
  const extension = fileName.slice(dot).toLowerCase();
  const matches = Object.entries(getConfig().mimeTypes || {}).filter(
    ([, details]) =>
      (details.category === 'audio' || details.category === 'video') &&
      details.extensions?.includes(extension)
  );
  return matches.length === 1 ? matches[0][0] : type || '';
};

/**
 * Replace the MIME type in the prefix of a data URL (`data:audio/x-m4a;base64,…` →
 * `data:audio/mp4;base64,…`). The adapters strip that prefix with a pattern that only knows
 * plain type names, so an alias or the `application/octet-stream` a browser puts there for an
 * empty type would reach the model provider as part of the audio.
 * @param {string} dataUrl - Data URL as produced by `FileReader.readAsDataURL`
 * @param {string} mimeType - MIME type the prefix should carry
 * @returns {string} Data URL with the given MIME type
 */
export const withDataUrlMimeType = (dataUrl, mimeType) =>
  mimeType && !dataUrl.startsWith(`data:${mimeType};`)
    ? dataUrl.replace(/^data:[^;,]*/, `data:${mimeType}`)
    : dataUrl;

// Legacy export for backward compatibility - returns all document MIME types (text merged into documents)
export const SUPPORTED_TEXT_FORMATS = getMimeTypesByCategories(['documents']);

// Legacy MIME_TO_EXTENSION for backward compatibility - empty for now, use getMimeTypeDetails
export const MIME_TO_EXTENSION = {};

// NB: no module-init prefetch of mimetypes here. In the browser extension
// the side panel imports this transitively from sidepanel-entry.jsx's
// static imports — i.e. before `installExtensionAuth` has set the apiClient
// baseURL — so a module-init fetch resolves against `chrome-extension://`
// and fails with ERR_FILE_NOT_FOUND. `loadMimetypesConfig` is called
// lazily by every consumer that needs it, so warm-up here was only ever a
// minor optimisation.

// Lazy load PDF.js only when needed.
// Loads the legacy build (see the worker import above for why) — never `pdfjs-dist` itself or
// `pdfjs-dist/build/*`, which are the modern build.
export const loadPdfjs = async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Use the locally bundled legacy worker (resolved by the static import above).
  // Works in offline/air-gapped environments; version tracks pdfjs-dist.
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
  return pdfjsLib;
};

// Lazy load Mammoth only when needed
export const loadMammoth = async () => {
  const mammoth = await import('mammoth');
  return mammoth;
};

// Lazy load Turndown (HTML → Markdown) only when a Word document is converted
export const loadTurndown = async () => {
  const mod = await import('turndown');
  return mod.default ?? mod;
};

// Admin switch (Admin → Features) for the structure-preserving extraction of Word
// documents. Everything structured is optional: with the switch off, or when the
// platform config cannot be read, behavior is the registry default (on) — and any error in
// the structured path falls back to the plain text extraction below.
export const STRUCTURED_EXTRACTION_FEATURE = 'structuredDocumentExtraction';

export const isStructuredExtractionEnabled = async () => {
  try {
    const platformConfig = await fetchPlatformConfig();
    const features = platformConfig?.features;
    const featuresMap = Array.isArray(features)
      ? Object.fromEntries(features.map(feature => [feature.id, feature.enabled]))
      : undefined;
    return new FeatureFlags({ featuresMap }).isEnabled(STRUCTURED_EXTRACTION_FEATURE, true);
  } catch {
    return true;
  }
};

// Lazy load MSGReader only when needed.
// @kenjiuno/msgreader is a CommonJS module that exposes the MsgReader class as
// its default export (it sets both `__esModule` and `exports.default`). Because
// of that double-default, bundler CJS/ESM interop can surface the constructor at
// mod.default, mod.default.default, or mod itself depending on the build. Pick
// the first candidate that is actually a constructor so it works everywhere.
export const loadMsgReader = async () => {
  const mod = await import('@kenjiuno/msgreader');
  const MsgReader = [mod?.default?.default, mod?.default, mod].find(
    candidate => typeof candidate === 'function'
  );
  if (!MsgReader) {
    throw new Error('msg-reader-unavailable');
  }
  return MsgReader;
};

// Lazy load the RTF decompressor only when a .msg has no plain/HTML body and we
// must fall back to its compressed RTF stream (PidTagRtfCompressed).
export const loadDecompressRtf = async () => {
  const mod = await import('@kenjiuno/decompressrtf');
  return mod?.decompressRTF || mod?.default?.decompressRTF || mod?.default;
};

// Lazy load JSZip only when needed for OpenOffice formats
export const loadJSZip = async () => {
  const JSZip = await import('jszip');
  return JSZip.default;
};

// Lazy load SheetJS (xlsx) only when needed for spreadsheet reading
export const loadXlsx = async () => {
  const mod = await import('xlsx');
  return mod.default ?? mod;
};

// Lazy load UTIF only when needed for TIFF processing
export const loadUTIF = async () => {
  const UTIF = await import('utif2');
  return UTIF.default;
};

// Progress and Stop of the extraction of a document. The functions below take a trailing
// `{ signal, onProgress }` (both optional: the cloud picker, the chat's source documents and the
// Office add-in pass none). `onProgress` there receives what the extractors report: `{ stage,
// percent, detail }` with the percent of that stage. The entry points (processDocumentFile,
// processImageFile, processGenericTextFile) take the callback of the uploader instead — overall
// percent, never going down — and make the one from the other with `progressFor`.

// What share of the overall progress (percent) each stage spans, by kind of document: a scale
// for the bar, not a share of the time. The stages are the ones the extractors report (see
// shared/documentExtraction); a stage without a percent shows as an indeterminate bar.
const DOCUMENT_STAGES = {
  pdf: { read: [0, 10], parse: [10, 15], extract: [15, 85], finalize: [85, 90], render: [90, 100] },
  docx: { read: [0, 10], parse: [10, 40], convert: [40, 85], finalize: [85, 100] },
  pptx: { read: [0, 15], parse: [15, 25], extract: [25, 100] },
  tiff: { read: [0, 10], parse: [10, 15], convert: [15, 90], finalize: [90, 100] },
  // Spreadsheets, OpenDocument, mails: one call of a library takes the file apart
  opaque: { read: [0, 90], extract: [90, 100] },
  // Text and plain images: reading is all there is
  read: { read: [0, 100] }
};

/**
 * `{ signal, onProgress }` for the extractors of a `kind` of document (a key of
 * `DOCUMENT_STAGES`), given those of the caller.
 */
const progressFor = (kind, { signal, onProgress } = {}) => ({
  signal,
  onProgress: onProgress && createProgressReporter(onProgress, DOCUMENT_STAGES[kind])
});

/**
 * Options to read a file with as the `read` stage of an extraction (see `readBlob`); reports 0
 * at once, so the panel names a stage before the first bytes are in.
 */
const readingOf = ({ signal, onProgress } = {}) => {
  const read = percent => onProgress?.({ stage: 'read', percent });
  read(0);
  return { signal, onProgress: read };
};

// Nothing to report to and no one to stop it (the cloud picker, the chat's source documents, the
// Office add-in): the file is read as it always was
const readDocumentBuffer = (file, progress = {}) =>
  progress.signal || progress.onProgress
    ? readFileAsArrayBuffer(file, readingOf(progress))
    : file.arrayBuffer();

/**
 * Read a document taken apart by one call of a library (spreadsheet, OpenDocument, mail): the
 * read can be measured and stopped, what follows cannot, and shows as an indeterminate bar.
 */
const readOpaqueDocument = async (file, progress = {}) => {
  const arrayBuffer = await readDocumentBuffer(file, progress);
  throwIfAborted(progress.signal);
  progress.onProgress?.({ stage: 'extract', percent: null });
  return arrayBuffer;
};

/**
 * Where a failure is caught to try another way (the plain text extraction after a failed
 * structured one), a stopped extraction must not be one: call this first, it throws the abort
 * error when the extraction was stopped. A library whose document was destroyed on Stop fails
 * with an error of its own; the signal tells it was the Stop.
 */
const rethrowIfAborted = (error, signal) => {
  if (isAbortError(error)) throw error;
  throwIfAborted(signal);
};

/**
 * Process TIFF file and convert to PNG/JPEG
 * Handles multipage TIFF by converting each page
 * @param {File} file - The TIFF file to process
 * @param {Object} options - Processing options
 * @param {number} options.maxDimension - Maximum dimension for resizing
 * @param {boolean} options.resize - Whether to resize images
 * @param {Object} [progress] - `signal` stops the conversion between pages (rejecting with the
 *   abort error); `onProgress` hears the `read`, `parse` and `convert` stages, the latter with the
 *   page being converted as `detail`
 * @returns {Promise<Array>} Array of processed image data (one per page)
 */
export const processTiffFile = async (file, options = {}, progress = {}) => {
  const { maxDimension = 1024, resize = true } = options;
  const { signal, onProgress } = progress;

  try {
    // Load UTIF library
    const UTIF = await loadUTIF();

    // Read file as ArrayBuffer
    const arrayBuffer = await readDocumentBuffer(file, progress);
    throwIfAborted(signal);

    // Decode TIFF
    onProgress?.({ stage: 'parse', percent: null });
    const ifds = UTIF.decode(arrayBuffer);

    // Process each page
    const pages = [];

    for (let i = 0; i < ifds.length; i++) {
      throwIfAborted(signal);
      onProgress?.(itemProgress('convert', 'page', i + 1, ifds.length));
      // A page takes long to decode and holds the page while it does: let the panel show which
      // page it is, and let Stop land, before it starts
      await yieldToEventLoop();
      throwIfAborted(signal);

      const ifd = ifds[i];
      UTIF.decodeImage(arrayBuffer, ifd);

      // Get RGBA data
      const rgba = UTIF.toRGBA8(ifd);

      // Create canvas
      const canvas = document.createElement('canvas');
      let width = ifd.width;
      let height = ifd.height;

      // Resize if needed
      if (resize) {
        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      // Create ImageData from RGBA
      const imageData = ctx.createImageData(ifd.width, ifd.height);
      imageData.data.set(rgba);

      // Draw to canvas (with resize if needed)
      if (width !== ifd.width || height !== ifd.height) {
        // Create temp canvas for original size
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = ifd.width;
        tempCanvas.height = ifd.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);

        // Draw resized to main canvas
        ctx.drawImage(tempCanvas, 0, 0, width, height);
      } else {
        ctx.putImageData(imageData, 0, 0);
      }

      // Convert to base64
      const base64 = canvas.toDataURL('image/png', 0.9);

      pages.push({
        base64,
        width,
        height,
        originalWidth: ifd.width,
        originalHeight: ifd.height,
        pageNumber: i + 1,
        totalPages: ifds.length
      });
    }

    return pages;
  } catch (error) {
    // Stopping is not a failure
    if (isAbortError(error)) throw error;
    console.error('Error processing TIFF file:', error);
    throw new Error('tiff-processing-error');
  }
};

/**
 * Resize an already-loaded image to fit within `maxDimension` (longest edge)
 * and re-encode it as JPEG. Shared canvas primitive used by both the
 * uploader's processImageFile and the Office add-in's attachment resizer so
 * the resize/re-encode behavior can't drift between the two call sites.
 * @param {HTMLImageElement} img - A loaded image element
 * @param {number} maxDimension - Maximum dimension for the longest edge
 * @param {number} [quality] - JPEG re-encode quality (0-1)
 * @returns {{ width: number, height: number, dataUrl: string }}
 */
export const resizeImageCanvas = (img, maxDimension, quality = 0.8) => {
  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;

  if (width > height && width > maxDimension) {
    height = Math.round((height * maxDimension) / width);
    width = maxDimension;
  } else if (height > maxDimension) {
    width = Math.round((width * maxDimension) / height);
    height = maxDimension;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);

  return { width, height, dataUrl };
};

/**
 * Process an image (or TIFF) file into the uploader's preview/data shape.
 * Handles multipage TIFF (optionally returning one result per page via
 * `allowMultiple`), resizing regular images through `resizeImageCanvas`.
 * @param {File} file - The image file to process
 * @param {Object} [options] - Processing options
 * @param {number} [options.maxDimension] - Maximum dimension for resizing
 * @param {boolean} [options.resize] - Whether to resize images
 * @param {boolean} [options.allowMultiple] - Return one result per TIFF page
 * @param {number} [options.quality] - JPEG re-encode quality (0-1)
 * @param {Object} [progressOptions] - What the uploader hands its processors
 * @param {AbortSignal} [progressOptions.signal] - Stops a TIFF between its pages (a plain image is
 *   only stopped while it is read), rejecting with the abort error
 * @param {(progress: {stage: string, percent: number|null, detail?: object}) => void} [progressOptions.onProgress] -
 *   Overall progress: reading the file, and for a TIFF every page being converted
 * @returns {Promise<Object>} `{ preview, data }` or `{ multipleResults }`
 */
export const processImageFile = async (file, options = {}, progressOptions = {}) => {
  const { maxDimension = 1024, resize = true, allowMultiple = false, quality = 0.8 } = options;
  const isTiff = file.type === 'image/tiff' || file.type === 'image/tif';

  if (isTiff) {
    const progress = progressFor('tiff', progressOptions);
    const { signal, onProgress } = progress;
    try {
      const pages = await processTiffFile(file, { maxDimension, resize }, progress);

      if (pages.length > 1 && allowMultiple) {
        const pageResults = [];

        for (let i = 0; i < pages.length; i++) {
          onProgress?.(itemProgress('finalize', 'page', i + 1, pages.length));
          const page = pages[i];

          const response = await fetch(page.base64);
          const blob = await response.blob();
          // Checked after the read, the last page's too: nothing shows the previews of a
          // stopped upload, so none is made and the ones made so far are let go
          if (signal?.aborted) {
            pageResults.forEach(({ preview }) => URL.revokeObjectURL(preview.url));
            throwIfAborted(signal);
          }
          const previewUrl = URL.createObjectURL(blob);

          const baseFileName = file.name.replace(/\.tiff?$/i, '');
          const fileName = `${baseFileName}_page${page.pageNumber}.png`;

          pageResults.push({
            preview: { type: 'image', url: previewUrl },
            data: {
              type: 'image',
              source: 'local',
              base64: page.base64,
              fileName,
              fileSize: blob.size,
              fileType: 'image/png',
              width: page.width,
              height: page.height,
              originalFileType: file.type,
              originalFileName: file.name,
              pageNumber: page.pageNumber,
              totalPages: page.totalPages
            }
          });
        }

        return { multipleResults: pageResults };
      }

      const firstPage = pages[0];
      const response = await fetch(firstPage.base64);
      const blob = await response.blob();
      throwIfAborted(signal);
      const previewUrl = URL.createObjectURL(blob);

      return {
        preview: { type: 'image', url: previewUrl },
        data: {
          type: 'image',
          source: 'local',
          base64: firstPage.base64,
          fileName: file.name.replace(/\.tiff?$/i, '.png'),
          fileSize: blob.size,
          fileType: 'image/png',
          width: firstPage.width,
          height: firstPage.height,
          originalFileType: file.type,
          originalFileName: file.name,
          tiffPages: pages.length > 1 ? pages : undefined
        }
      };
    } catch (error) {
      // Stopping is not a failure
      if (isAbortError(error)) throw error;
      console.error('Error processing TIFF file:', error);
      throw new Error('tiff-processing-error');
    }
  }

  const source = await readFileAsDataURL(file, readingOf(progressFor('read', progressOptions)));

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const previewUrl = URL.createObjectURL(file);

      if (!resize) {
        return resolve({
          preview: { type: 'image', url: previewUrl },
          data: {
            type: 'image',
            source: 'local',
            base64: source,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            width: img.width,
            height: img.height
          }
        });
      }

      const { width, height, dataUrl } = resizeImageCanvas(img, maxDimension, quality);

      resolve({
        preview: { type: 'image', url: previewUrl },
        data: {
          type: 'image',
          source: 'local',
          base64: dataUrl,
          fileName: file.name,
          fileSize: file.size,
          fileType: 'image/jpeg',
          width,
          height
        }
      });
    };
    img.onerror = () => reject(new Error('invalid-image'));
    img.src = source;
  });
};

// What share of the overall progress (percent) each stage of the extraction
// spans. A scale for the bar, not a share of the time: decoding takes by far
// the longest but has nothing to report while it runs.
const EXTRACTION_STAGES = {
  read: [0, 10],
  decode: [10, 50],
  resample: [50, 70],
  encode: [70, 90],
  finalize: [90, 100]
};

/**
 * A context to decode with. `decodeAudioData` resamples to the context's sample
 * rate while it decodes, off the main thread, so a context at the rate the
 * track is reduced to anyway keeps the decoded track small and quick to hand
 * over: for 40 minutes of 44.1 kHz stereo, 290 MB instead of 810 MB, decoded in
 * 7.5 s instead of 11 s, with a 0.2 s instead of 0.65 s stall of the page. The
 * result differs from decoding first and resampling after by -70 dB.
 */
const createDecodingContext = () => {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  try {
    return new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    // Cannot run at 16 kHz: decode at the device's rate, the render resamples
    return new AudioContextCtor();
  }
};

/**
 * The most a browser reads into one ArrayBuffer. A 1.9 GB file works, a 3 GB one
 * fails with NotReadableError, `File.slice()` works at any size (measured in
 * Chromium). Whatever has to be read whole, a video that is sent as it is or
 * decoded by the browser as it is, stays below this.
 */
export const WHOLE_FILE_READ_LIMIT_BYTES = Math.floor(1.9 * 1024 * 1024 * 1024);

// Errors of the extraction the caller shows as they are; any other becomes
// `video-audio-extraction-error`
const SPECIFIC_EXTRACTION_ERRORS = [
  'audio-decode-error',
  'video-large-audio-unsupported',
  'video-unsupported-large-container'
];

/**
 * The audio of an MP4, MOV or M4A file, read with `File.slice()` and decoded:
 * `{ audioBuffer, trim }` for the resample, whatever the size of the file (see
 * `mp4AudioExtraction.js`: only the index and the audio are read). `trim` is the
 * part of the audio the edit list of the file plays, or null for all of it. Null
 * where the whole-file path takes over: the file is not an MP4-family one, or
 * this could not read it (a codec or layout it does not handle, an edit list or
 * fragments it cannot follow, a damaged index, a browser that cannot decode the
 * AAC) and the file is small enough for that path. A large one has nothing to
 * fall back on and fails with `video-large-audio-unsupported`.
 */
const decodeMp4Streaming = async (file, audioContext, { signal, report }) => {
  try {
    const mp4 = await import('./mp4AudioExtraction');
    if (!(await mp4.isMp4Container(file, signal))) return null;

    const audio = await mp4.readMp4Audio(file, {
      signal,
      onProgress: percent => report('read', percent),
      createPcmBuffer: (length, sampleRate) => audioContext.createBuffer(1, length, sampleRate)
    });
    if (audio.kind === 'pcm') {
      // Nothing to decode: the samples were converted as they were read
      report('decode', 100);
      return { audioBuffer: audio.buffer, trim: audio.trim };
    }
    report('decode');
    const frames = await readFileAsArrayBuffer(audio.blob, { signal });
    const audioBuffer = await raceAbort(audioContext.decodeAudioData(frames), signal);
    return { audioBuffer, trim: audio.trim };
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.warn('Could not extract the audio by reading the file in parts:', error);
    if (file.size > WHOLE_FILE_READ_LIMIT_BYTES) throw new Error('video-large-audio-unsupported');
    return null;
  }
};

/**
 * Extract the audio track of a video file as a 16 kHz mono WAV using the Web
 * Audio API.
 *
 * The track is decoded at the video's own sample rate and channel count, then
 * rendered straight to 16 kHz mono before it is encoded: the format the
 * transcription models are fed anyway (see `resampleTo16kMono`), and plenty
 * for speech sent to a multimodal chat model. A WAV of the original 48 kHz
 * stereo is six times larger — over 11 MB per minute. Its base64 data URL
 * then outgrows the engine's maximum string length for videos beyond ~35
 * minutes, where `FileReader` hands back an empty string without an error:
 * the attachment looks fine and only fails once it is sent.
 *
 * Videos of any size work as MP4 or MOV: only their index and audio are read,
 * with `File.slice()` (see `decodeMp4Streaming`). Other containers (WebM, MKV,
 * AVI, ...) are decoded by the browser from the whole file, up to
 * `WHOLE_FILE_READ_LIMIT_BYTES`; above it they fail with
 * `video-unsupported-large-container`.
 *
 * A long video takes seconds to minutes, so the extraction reports its
 * progress and can be stopped, and it never holds the page: reading, decoding
 * and resampling run natively, and the WAV is encoded in slices with the event
 * loop in between (`audioBufferToWavAsync`).
 *
 * @param {File} file - The video file to extract audio from
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Stops the extraction at the next
 *   checkpoint, rejecting with an Error whose message and `code` are
 *   `'aborted'` (never mapped to `video-audio-extraction-error`)
 * @param {(progress: {stage: string, percent: number|null}) => void} [options.onProgress] -
 *   `stage` is `read`, `decode`, `resample`, `encode` or `finalize`, in that
 *   order. `percent` is the overall progress, 0-100 and never going down, or
 *   `null` while the stage has nothing to measure (`decode`, and `resample` in
 *   browsers that cannot suspend an offline render).
 * @returns {Promise<Object>} The WAV as a data URL (`base64`) and a `blob`,
 *   with `format`, `sampleRate` (16000), `channels` (1), `duration` (seconds)
 *   and `size` (bytes) describing that output
 */
export const extractAudioFromVideo = async (file, { signal, onProgress } = {}) => {
  let audioContext = null;
  let lastPercent = 0;
  let lastReport = null;

  // Report `stage` at `local` percent of its own span, `null`: unknown
  const report = (stage, local = null) => {
    if (!onProgress) return;
    const [from, to] = EXTRACTION_STAGES[stage];
    const percent =
      local === null ? null : Math.max(lastPercent, Math.round(from + ((to - from) * local) / 100));
    if (lastReport === `${stage}:${percent}`) return;
    lastReport = `${stage}:${percent}`;
    if (percent !== null) lastPercent = percent;
    onProgress({ stage, percent });
  };

  try {
    throwIfAborted(signal);
    audioContext = createDecodingContext();

    report('read', 0);
    // Where the browser cannot read the video whole (above ~2 GB) it reads what
    // it needs. An MP4 or MOV is read that way at any size, it is quicker
    const streamed = await decodeMp4Streaming(file, audioContext, { signal, report });
    let audioBuffer = streamed?.audioBuffer ?? null;
    // What the edit list of the video plays of that audio, applied by the resample.
    // The browser applies it itself where it decodes the whole file: no trim there
    const trim = streamed?.trim ?? null;

    if (!audioBuffer) {
      if (file.size > WHOLE_FILE_READ_LIMIT_BYTES) {
        throw new Error('video-unsupported-large-container');
      }
      const arrayBuffer = await readFileAsArrayBuffer(file, {
        signal,
        onProgress: percent => report('read', percent)
      });

      // Decode audio from video file. It cannot report progress or be cancelled:
      // stopping drops its result.
      report('decode');
      try {
        audioBuffer = await raceAbort(audioContext.decodeAudioData(arrayBuffer), signal);
      } catch (decodeError) {
        if (isAbortError(decodeError)) throw decodeError;
        console.error('Audio decode error:', decodeError);
        throw new Error('audio-decode-error');
      }
    }

    // Downmix + resample natively. (An earlier version re-rendered the decoded
    // PCM through a same-rate/same-channel OfflineAudioContext — a pure copy
    // that doubled peak memory on long videos.)
    report('resample');
    const samples = await resampleTo16kMono(audioBuffer, {
      signal,
      onProgress: percent => report('resample', percent),
      offset: trim?.offset,
      duration: trim?.duration
    });
    // The decoded track (hundreds of MB for a long video) is not needed again
    audioBuffer = null;

    // The encoder only reads these four members of its input.
    report('encode', 0);
    const wavBlob = await audioBufferToWavAsync(
      {
        numberOfChannels: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        length: samples.length,
        getChannelData: () => samples
      },
      { signal, onProgress: percent => report('encode', percent) }
    );

    report('finalize', 0);
    const wavBase64 = await blobToBase64(wavBlob, {
      signal,
      onProgress: percent => report('finalize', percent)
    });
    report('finalize', 100);

    return {
      base64: wavBase64,
      blob: wavBlob,
      format: 'audio/wav',
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      duration: samples.length / TARGET_SAMPLE_RATE,
      size: wavBlob.size
    };
  } catch (error) {
    // Stopping is not a failure
    if (isAbortError(error)) throw error;
    console.error('Error extracting audio from video:', error);
    if (SPECIFIC_EXTRACTION_ERRORS.includes(error.message)) {
      throw error;
    }
    throw new Error('video-audio-extraction-error');
  } finally {
    // Close on EVERY path: browsers cap concurrent AudioContexts (~6 in
    // Chrome), so leaking one per failed decode would break all audio features
    // (recording, dictation, decoding) until the page reloads.
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {});
    }
  }
};

/**
 * Convert a base64 data URL (or bare base64 string) to an ArrayBuffer without
 * relying on fetch(), which does not handle `data:` URLs consistently across
 * environments.
 */
const dataUrlToArrayBuffer = dataUrl => {
  const commaIdx = dataUrl.indexOf(',');
  const meta = commaIdx >= 0 ? dataUrl.slice(0, commaIdx) : '';
  const payload = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const isBase64 = commaIdx < 0 || /;base64/i.test(meta);
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

/**
 * Decode an uploaded audio source into an AudioBuffer using the Web Audio API.
 *
 * Used by the Voxtral transcription flow: the decoded buffer is re-rendered to
 * 16 kHz mono PCM16 and streamed to the realtime endpoint. Decoding happens in
 * the browser, so codec support varies (e.g. Safari lacks OGG); an undecodable
 * source raises `audio-decode-error` so the caller can surface a clear message
 * (issue #1927 gap G10).
 *
 * @param {string|ArrayBuffer|Blob} input - A base64 data URL, an ArrayBuffer, or a Blob/File.
 * @returns {Promise<AudioBuffer>}
 */
export const decodeAudioFileToBuffer = async input => {
  let arrayBuffer;
  if (typeof input === 'string') {
    arrayBuffer = dataUrlToArrayBuffer(input);
  } else if (input instanceof ArrayBuffer) {
    arrayBuffer = input;
  } else if (input && typeof input.arrayBuffer === 'function') {
    arrayBuffer = await input.arrayBuffer();
  } else {
    throw new Error('audio-decode-error');
  }

  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  try {
    // decodeAudioData may detach the input buffer, so decode a copy.
    return await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } catch (decodeError) {
    console.error('Audio decode error:', decodeError);
    throw new Error('audio-decode-error');
  } finally {
    try {
      await audioContext.close();
    } catch {
      /* ignore */
    }
  }
};

/**
 * Read a Blob or File with a FileReader: `start(reader)` calls the `readAs…`
 * method. Unlike `blob.arrayBuffer()`, the read reports its progress and can
 * be stopped.
 *
 * @param {(reader: FileReader) => void} start
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Aborts the read, rejecting with the
 *   abort error (see `abortable.js`)
 * @param {(percent: number) => void} [options.onProgress] - Percent (0-100) read
 */
const readBlob = (start, { signal, onProgress } = {}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const reader = new FileReader();
    const onAbort = () => reader.abort();
    const finish = settle => () => {
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    reader.onprogress = event => {
      if (!event.lengthComputable || !event.total) return;
      onProgress?.((event.loaded / event.total) * 100);
    };
    reader.onload = finish(() => resolve(reader.result));
    reader.onerror = finish(() => reject(new Error('read-error')));
    reader.onabort = finish(() => reject(createAbortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    start(reader);
  });

const readFileAsArrayBuffer = (file, options) =>
  readBlob(reader => reader.readAsArrayBuffer(file), options);

/**
 * Read a file as a base64 data URL.
 * @param {Blob} file
 * @param {Object} [options] - `signal` and `onProgress`, see `readBlob`
 * @returns {Promise<string>}
 */
export const readFileAsDataURL = (file, options) =>
  readBlob(reader => reader.readAsDataURL(file), options);

/**
 * Convert Blob to base64 string
 * @param {Blob} blob - The blob to convert
 * @param {Object} [options] - `signal` and `onProgress`, see `readBlob`
 * @returns {Promise<string>} Base64 data URL
 */
const blobToBase64 = async (blob, options) => {
  const dataUrl = await readFileAsDataURL(blob, options);
  // A data URL beyond the engine's maximum string length comes back as an
  // empty string, not as an error: fail now instead of attaching a file
  // that is empty once sent.
  if (!dataUrl && blob.size > 0) throw new Error('read-error');
  return dataUrl;
};

/**
 * A microphone recording as an audio attachment, in the shape an uploaded
 * audio file has: 16 kHz mono WAV, as the audio of a video is extracted to.
 *
 * @param {AudioBuffer} audioBuffer - The recording (any rate/channels).
 * @param {string} fileName
 * @returns {Promise<Object>} The attachment (`type: 'audio'`).
 */
export const recordingToAudioAttachment = async (audioBuffer, fileName) => {
  const samples = await resampleTo16kMono(audioBuffer);
  const blob = await audioBufferToWavAsync({
    numberOfChannels: 1,
    sampleRate: TARGET_SAMPLE_RATE,
    length: samples.length,
    getChannelData: () => samples
  });
  return {
    type: 'audio',
    source: 'local',
    base64: await blobToBase64(blob),
    fileName,
    fileSize: blob.size,
    fileType: 'audio/wav',
    duration: samples.length / TARGET_SAMPLE_RATE
  };
};

// Convert MIME types array to accept string with both MIME types and extensions
export const formatAcceptAttribute = mimeTypes => {
  const config = getConfig();
  const acceptValues = [];
  mimeTypes.forEach(mimeType => {
    // Add the MIME type
    acceptValues.push(mimeType);
    // Add the file extension(s) if available
    const mimeTypeDetails = config.mimeTypes[mimeType];
    if (mimeTypeDetails && mimeTypeDetails.extensions) {
      acceptValues.push(...mimeTypeDetails.extensions);
    }
  });
  return acceptValues;
};

// Get display type for a MIME type
export const getFileTypeDisplay = mimeType => {
  const config = getConfig();
  const mimeTypeDetails = config.mimeTypes[mimeType];
  return mimeTypeDetails?.displayName || 'FILE';
};

// Convert MIME types to display format list
export const formatMimeTypesToDisplay = mimeTypes => {
  const displayFormats = mimeTypes.map(getFileTypeDisplay);
  return [...new Set(displayFormats)].join(', ');
};

/**
 * Read a text file.
 * @param {Blob} file
 * @param {Object} [options] - `signal` and `onProgress`, see `readBlob`
 * @returns {Promise<string>}
 */
export const readTextFile = (file, options) => readBlob(reader => reader.readAsText(file), options);

// Upper-cased extension of a file name ("meeting.log" → "LOG"), used as the
// display type for files accepted via GENERIC_TEXT_MIME_TYPE, which have no
// entry in the mimetypes config.
export const getExtensionDisplay = fileName => {
  const dot = (fileName || '').lastIndexOf('.');
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toUpperCase() : 'TXT';
};

// Plain text of a PDF: the items of each page joined with spaces, one line per page. This is the
// extraction before structured extraction existed — it loses page boundaries and line breaks
// and doubles spaces — and stays unchanged as the fallback and as the result when the admin
// switch is off.
const legacyPdfText = async (pdf, { signal, onProgress } = {}) => {
  let textContent = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    throwIfAborted(signal);
    onProgress?.(itemProgress('extract', 'page', i, pdf.numPages));
    const page = await pdf.getPage(i);
    const textContentPage = await page.getTextContent();
    const textItems = textContentPage.items.map(item => item.str).join(' ');
    textContent += textItems + '\n';
  }

  return textContent.trim();
};

/**
 * Read a PDF, open it with pdf.js and hand the document to `work`. The document is destroyed
 * afterwards, which ends pdf.js's worker for it — also when the extraction is stopped: Stop
 * destroys it at once, whatever pdf.js is doing, and the extraction rejects with the abort error.
 * (A request that pdf.js is answering when its document is destroyed may never be answered at
 * all, so Stop does not wait for the extraction to notice.)
 */
const withPdfDocument = async (file, progress, work) => {
  const { signal, onProgress } = progress;
  const arrayBuffer = await readDocumentBuffer(file, progress);
  const pdfjsLib = await loadPdfjs();
  throwIfAborted(signal);

  onProgress?.({ stage: 'parse', percent: null });
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
  const destroy = () => {
    try {
      loadingTask.destroy?.()?.catch?.(() => {});
    } catch {
      // Already destroyed
    }
  };
  signal?.addEventListener('abort', destroy, { once: true });
  try {
    return await raceAbort((async () => work(await loadingTask.promise))(), signal);
  } catch (error) {
    rethrowIfAborted(error, signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', destroy);
    destroy();
  }
};

// PDF text and how it was extracted: structured text carries page markers, which must not
// count as text when deciding whether the PDF is a scan.
const extractPdfContent = (file, progress = {}) =>
  withPdfDocument(file, progress, async pdf => {
    if (await isStructuredExtractionEnabled()) {
      try {
        return { content: await extractPdfText(pdf, progress), structured: true };
      } catch (error) {
        // A stopped extraction is not one to try again the plain way
        rethrowIfAborted(error, progress.signal);
        // Never make an upload fail that worked before: use the plain text extraction.
        console.warn('[fileProcessing] structured extraction failed, using legacy', error);
      }
    }

    return { content: await legacyPdfText(pdf, progress), structured: false };
  });

// Process PDF file. `progress`: `{ signal, onProgress }`, see the notes above processTiffFile.
export const processPdfFile = async (file, progress) =>
  (await extractPdfContent(file, progress)).content;

// Render PDF pages to images when text extraction yields nothing
export const renderPdfPagesToImages = (file, maxPages = 5, scale = 1.5, progress = {}) =>
  withPdfDocument(file, progress, async pdf => {
    const pages = Math.min(pdf.numPages, maxPages);
    const images = [];
    for (let i = 1; i <= pages; i++) {
      throwIfAborted(progress.signal);
      progress.onProgress?.(itemProgress('render', 'page', i, pages));
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push(canvas.toDataURL('image/jpeg', 0.8));
    }
    return images;
  });

// Plain text of a DOCX file: mammoth's HTML flattened with textContent. This is the
// extraction before structured extraction existed — it loses headings, numbering, list
// markers, table cells and paragraph boundaries — and stays unchanged as the fallback and
// as the result when the admin switch is off.
export const legacyDocxText = async (arrayBuffer, { signal, onProgress } = {}) => {
  throwIfAborted(signal);
  onProgress?.({ stage: 'convert', percent: null });
  const mammoth = await loadMammoth();
  // Stopped while mammoth was loaded: the conversion is not started
  throwIfAborted(signal);
  const result = await mammoth.convertToHtml({ arrayBuffer });
  throwIfAborted(signal);

  // Extract plain text from HTML for better readability
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = result.value;
  return tempDiv.textContent || tempDiv.innerText || '';
};

// Process DOCX file. `progress`: `{ signal, onProgress }`, see the notes above processTiffFile.
export const processDocxFile = async (file, options = {}, progress = {}) => {
  const arrayBuffer = await readDocumentBuffer(file, progress);

  if (await isStructuredExtractionEnabled()) {
    try {
      const [mammoth, JSZip, TurndownService] = await Promise.all([
        loadMammoth(),
        loadJSZip(),
        loadTurndown()
      ]);
      return await extractDocxMarkdown({
        arrayBuffer,
        JSZip,
        mammoth,
        TurndownService,
        DOMParser,
        XMLSerializer,
        trackedChanges: options?.trackedChanges,
        comments: options?.comments,
        ...progress
      });
    } catch (error) {
      // A stopped extraction is not one to try again the plain way
      rethrowIfAborted(error, progress.signal);
      // Never make an upload fail that worked before: use the plain text extraction.
      console.warn('[fileProcessing] structured extraction failed, using legacy', error);
    }
  }

  return legacyDocxText(arrayBuffer, progress);
};

// Tab-separated text of every sheet: the extraction before structured extraction existed. It
// stays unchanged as the fallback and as the result when the admin switch is off.
export const legacyXlsxText = async arrayBuffer => {
  const XLSX = await loadXlsx();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t' });
    if (csv.trim()) {
      parts.push(`[Sheet: ${sheetName}]\n${csv}`);
    }
  }
  return parts.join('\n\n').trim();
};

// Process XLSX / XLS file — a sheet with a header row as a Markdown table, merged cells filled,
// hidden sheets flagged, rows and characters limited (see shared/documentExtraction/xlsx.js)
export const processXlsxFile = async (file, progress) => {
  const arrayBuffer = await readOpaqueDocument(file, progress);

  if (await isStructuredExtractionEnabled()) {
    try {
      const XLSX = await loadXlsx();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      return extractXlsxText({ XLSX, workbook });
    } catch (error) {
      // Never make an upload fail that worked before: use the plain text extraction.
      console.warn('[fileProcessing] structured extraction failed, using legacy', error);
    }
  }

  return legacyXlsxText(arrayBuffer);
};

// Map a Windows/MAPI code page number to a label TextDecoder understands.
// MSG bodies stored as bytes (PidTagHtml, decompressed RTF) carry no charset of
// their own, so we decode with the message's declared code page when possible.
const CODEPAGE_TO_LABEL = {
  20127: 'us-ascii',
  28591: 'iso-8859-1',
  28592: 'iso-8859-2',
  28595: 'iso-8859-5',
  65000: 'utf-7',
  65001: 'utf-8',
  1200: 'utf-16le',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5'
};

const decodeBytesWithCodepage = (bytes, ...codepages) => {
  const label = codepages.map(cp => CODEPAGE_TO_LABEL[cp]).find(Boolean) || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
};

// Convert an HTML fragment/document to readable plain text. Runs in the browser
// (and jsdom) using an inert document, so no scripts run and no resources load.
export const htmlToText = html => {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc
    .querySelectorAll('script, style, head, title, meta, link, noscript')
    .forEach(el => el.remove());
  doc.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  // Force a line break after common block-level elements so the flattened text
  // keeps paragraph/row structure instead of running together.
  doc
    .querySelectorAll(
      'p, div, tr, li, h1, h2, h3, h4, h5, h6, table, blockquote, section, article, header, footer'
    )
    .forEach(el => el.append('\n'));
  const root = doc.body || doc.documentElement;
  const text = root ? root.textContent || '' : '';
  return text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

// Best-effort conversion of RTF to plain text. Handles HTML-encapsulated RTF
// (MS-OXRTFEX, used by Outlook) by stripping the RTF wrapper and then flattening
// the recovered HTML. Never throws; returns '' if nothing readable is found.
const rtfToText = rtf => {
  if (!rtf) return '';
  let text = rtf
    // Drop RTF-only spans that wrap the encapsulated HTML markup.
    .replace(/\\htmlrtf\b[\s\S]*?\\htmlrtf0 ?/g, ' ')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, n) => {
      let code = Number.parseInt(n, 10);
      if (code < 0) code += 65536;
      return String.fromCharCode(code);
    })
    .replace(/\\par[d]?\b ?/g, '\n')
    .replace(/\\line\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '') // remaining control words
    .replace(/[{}]/g, '')
    .replace(/\\\r?\n/g, '\n');
  // Encapsulated HTML leaves real markup behind — flatten it to text.
  if (/<\/?[a-z][\s\S]*>/i.test(text)) {
    text = htmlToText(text);
  }
  return text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

// Outlook stores internal Exchange addresses as an X.500 DN (e.g. "/O=EXCHANGE
// LABS/...") which is noise to a model. Prefer a real SMTP address when present.
const isExchangeDn = value => typeof value === 'string' && /^\/[oO]=/.test(value);
const pickEmail = (...candidates) => candidates.find(v => v && !isExchangeDn(v)) || '';

const formatMsgParticipant = (name, email) => {
  if (name && email && name !== email) return `${name} <${email}>`;
  return name || email || '';
};

// Build a readable text representation (headers + body) from parsed MSG data.
// Exported for unit testing of the fallback chain independent of the binary
// parser. The body falls back across all storage formats Outlook may use:
// plain text → HTML string → HTML bytes → compressed RTF.
export const extractMsgContent = async fileData => {
  if (!fileData) return '';

  const headerLines = [];
  if (fileData.subject) headerLines.push(`Subject: ${fileData.subject}`);

  const senderEmail = pickEmail(
    fileData.senderSmtpAddress,
    fileData.sentRepresentingSmtpAddress,
    fileData.senderEmail
  );
  const fromLine = formatMsgParticipant(fileData.senderName, senderEmail);
  if (fromLine) headerLines.push(`From: ${fromLine}`);

  const recipients = Array.isArray(fileData.recipients) ? fileData.recipients : [];
  const formatGroup = type =>
    recipients
      .filter(r => (r.recipType || 'to').toLowerCase() === type)
      .map(r => formatMsgParticipant(r.name, pickEmail(r.smtpAddress, r.email)))
      .filter(Boolean)
      .join(', ');
  const toLine = formatGroup('to');
  const ccLine = formatGroup('cc');
  if (toLine) headerLines.push(`To: ${toLine}`);
  if (ccLine) headerLines.push(`Cc: ${ccLine}`);

  const date = fileData.messageDeliveryTime || fileData.clientSubmitTime || fileData.creationTime;
  if (date) headerLines.push(`Date: ${date}`);

  const attachmentNames = (Array.isArray(fileData.attachments) ? fileData.attachments : [])
    .map(a => a.fileName || a.name)
    .filter(Boolean);
  if (attachmentNames.length > 0) {
    headerLines.push(`Attachments: ${attachmentNames.join(', ')}`);
  }

  // Resolve the body across every format Outlook may have stored it in.
  let body = '';
  if (fileData.body && fileData.body.trim()) {
    body = fileData.body.trim();
  } else if (fileData.bodyHtml && String(fileData.bodyHtml).trim()) {
    body = htmlToText(String(fileData.bodyHtml));
  } else if (fileData.html) {
    const htmlString =
      typeof fileData.html === 'string'
        ? fileData.html
        : decodeBytesWithCodepage(
            fileData.html,
            fileData.internetCodepage,
            fileData.messageCodepage
          );
    body = htmlToText(htmlString);
  } else if (fileData.compressedRtf) {
    try {
      const decompressRTF = await loadDecompressRtf();
      const rtfBytes = decompressRTF(Array.from(fileData.compressedRtf));
      const rtf = decodeBytesWithCodepage(Uint8Array.from(rtfBytes), fileData.messageCodepage);
      body = rtfToText(rtf);
    } catch (error) {
      console.warn('[fileProcessing] MSG RTF body extraction failed:', error);
    }
  }

  return [headerLines.join('\n'), body].filter(Boolean).join('\n\n').trim();
};

// Process MSG file
export const processMsgFile = async (file, progress) => {
  const arrayBuffer = await readOpaqueDocument(file, progress);
  const MsgReader = await loadMsgReader();
  const msgReader = new MsgReader(arrayBuffer);
  const fileData = msgReader.getFileData();
  return extractMsgContent(fileData);
};

// DrawingML namespace — text runs in PPTX slide XML live in <a:t> elements
// under this namespace regardless of the prefix the producer chose.
const DRAWINGML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// Plain text of every slide from the OOXML package (ppt/slides/slideN.xml), slides in the order
// of their file names, one line per paragraph: the extraction before structured extraction
// existed. It stays unchanged as the fallback and as the result when the admin switch is off.
// (Without any PPTX handler the file fell through to readTextFile, which decoded the raw ZIP
// container as text and shipped hundreds of thousands of garbage tokens to the model.)
export const legacyPptxText = async (arrayBuffer, { signal, onProgress } = {}) => {
  throwIfAborted(signal);
  onProgress?.({ stage: 'parse', percent: null });
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const slideNumber = path => {
    const match = path.match(/slide(\d+)\.xml$/);
    return match ? Number.parseInt(match[1], 10) : 0;
  };
  const slidePaths = Object.keys(zip.files)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const parser = new DOMParser();
  const slides = [];
  for (const [index, path] of slidePaths.entries()) {
    throwIfAborted(signal);
    onProgress?.(itemProgress('extract', 'slide', index + 1, slidePaths.length));
    const xml = await zip.file(path).async('string');
    const doc = parser.parseFromString(xml, 'application/xml');
    // Paragraphs (<a:p>) keep line structure; each holds one or more text
    // runs (<a:t>) that must be joined without separators (a word can be
    // split across runs by formatting boundaries).
    const paragraphs = [];
    for (const p of Array.from(doc.getElementsByTagNameNS(DRAWINGML_NS, 'p'))) {
      const line = Array.from(p.getElementsByTagNameNS(DRAWINGML_NS, 't'))
        .map(t => t.textContent)
        .join('')
        .trim();
      if (line) paragraphs.push(line);
    }
    if (paragraphs.length > 0) {
      slides.push(`[Slide ${slideNumber(path)}]\n${paragraphs.join('\n')}`);
    }
  }

  return slides.join('\n\n').trim();
};

// Process PPTX file — slides in the order of the presentation, the title as a heading, tables as
// Markdown, hidden slides flagged; speaker notes only when the app asks for them
// (see shared/documentExtraction/pptx.js)
// `progress`: `{ signal, onProgress }`, see the notes above processTiffFile.
export const processPptxFile = async (file, options = {}, progress = {}) => {
  const arrayBuffer = await readDocumentBuffer(file, progress);

  if (await isStructuredExtractionEnabled()) {
    try {
      const JSZip = await loadJSZip();
      return await extractPptxText({
        arrayBuffer,
        JSZip,
        DOMParser,
        speakerNotes: options?.speakerNotes,
        ...progress
      });
    } catch (error) {
      // A stopped extraction is not one to try again the plain way
      rethrowIfAborted(error, progress.signal);
      // Never make an upload fail that worked before: use the plain text extraction.
      console.warn('[fileProcessing] structured extraction failed, using legacy', error);
    }
  }

  return legacyPptxText(arrayBuffer, progress);
};

// Heuristic check that a string produced by reading a file "as text" is
// actually text. Binary containers (ZIP, OLE, images) decode to NUL bytes
// and long runs of U+FFFD replacement characters — either signal means the
// file has no meaningful text representation and must not be sent to the
// model as content.
export const looksLikeBinaryText = text => {
  if (!text) return false;
  const sample = text.slice(0, 8192);
  let replacements = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code === 0xfffd) replacements++;
  }
  return replacements > sample.length * 0.05;
};

// Read a file accepted only via GENERIC_TEXT_MIME_TYPE. Unlike
// processDocumentFile it never dispatches to a format-specific extractor —
// the admin allowed "any text file", not e.g. DOCX — so binary content is
// rejected instead of being parsed.
export const processGenericTextFile = async (file, progressOptions) => {
  const content = await readTextFile(file, readingOf(progressFor('read', progressOptions)));
  if (looksLikeBinaryText(content)) {
    throw new Error('unsupported-format');
  }
  return { content };
};

// Text of an OpenOffice/LibreOffice file as it was before structured extraction existed: every
// text node of content.xml, paragraphs on their own line. It stays unchanged as the fallback
// and as the result when the admin switch is off.
export const legacyOpenOfficeText = async arrayBuffer => {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Extract content.xml which contains the text content
  const contentXml = await zip.file('content.xml')?.async('string');

  if (contentXml) {
    // Parse XML and extract text content
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(contentXml, 'text/xml');

    // Extract all text nodes
    const extractText = node => {
      let text = '';
      if (node.nodeType === Node.TEXT_NODE) {
        text = node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Add line breaks for paragraphs
        if (node.nodeName === 'text:p' || node.nodeName === 'text:h') {
          text = '\n';
        }
        for (const child of node.childNodes) {
          text += extractText(child);
        }
        if (node.nodeName === 'text:p' || node.nodeName === 'text:h') {
          text += '\n';
        }
      }
      return text;
    };

    return extractText(xmlDoc.documentElement).trim();
  } else {
    throw new Error('Unable to extract content from OpenOffice document');
  }
};

// Process OpenOffice/LibreOffice file (.odt, .ods, .odp) — headings, lists with their numbers,
// tables, footnotes, links; sheets as tables; slides (see shared/documentExtraction/odf.js)
export const processOpenOfficeFile = async (file, options = {}, progress = {}) => {
  const arrayBuffer = await readOpaqueDocument(file, progress);

  if (await isStructuredExtractionEnabled()) {
    try {
      const JSZip = await loadJSZip();
      return await extractOdfText({
        arrayBuffer,
        JSZip,
        DOMParser,
        speakerNotes: options?.speakerNotes
      });
    } catch (error) {
      // Never make an upload fail that worked before: use the plain text extraction.
      console.warn('[fileProcessing] structured extraction failed, using legacy', error);
    }
  }

  return legacyOpenOfficeText(arrayBuffer);
};

// Main document processing function
// Returns { content, pageImages } where pageImages is set for image-based PDFs.
// `options` are the per-app extraction options of `upload.fileUpload` (Word documents only):
// `trackedChanges: 'markup'` and `comments: 'inline'` — see docs/file-upload-feature.md.
// `progressOptions` is what the uploader hands its processors, both parts optional: `signal` stops
// the extraction (rejecting with the abort error, see abortable.js) and `onProgress({ stage,
// percent, detail })` hears how far it is. PDF, Word, PowerPoint and TIFF stop at the next page,
// slide or step, and report the page or slide they are on as `detail`; spreadsheets, OpenDocument
// files and mails are taken apart by one call of a library: they report and stop while they are
// read, then show an indeterminate bar. See docs/file-upload-feature.md.
export const processDocumentFile = async (file, options = {}, progressOptions = {}) => {
  let content = '';
  let pageImages;
  const progressOf = kind => progressFor(kind, progressOptions);

  // Get file extension as fallback for MIME type detection
  const fileExtension = '.' + file.name.split('.').pop().toLowerCase();

  // Determine processing method based on MIME type or file extension
  if (file.type === 'application/pdf' || fileExtension === '.pdf') {
    const progress = progressOf('pdf');
    const extracted = await extractPdfContent(file, progress);
    content = extracted.content;
    // If text extraction yields empty/minimal content, render pages as images. Page markers
    // of structured text are not text: a scan with markers only must still be rendered.
    const textLength = extracted.structured
      ? realTextLength(content)
      : (content || '').trim().length;
    if (textLength < MIN_REAL_TEXT_CHARS) {
      console.log(
        `[fileProcessing] PDF text extraction yielded ${textLength} chars, attempting page-to-image rendering`
      );
      try {
        pageImages = await renderPdfPagesToImages(file, 5, undefined, progress);
        console.log(
          `[fileProcessing] Rendered ${pageImages.length} PDF page(s) as images (${pageImages.reduce((sum, img) => sum + img.length, 0)} bytes total base64)`
        );
        // The images carry the page; the few characters of the text layer (a page number, a
        // stamp) would only keep the images from being attached. Without images, keep the text
        // — and keep it when it sits on a page that was not rendered.
        if (
          extracted.structured &&
          pageImages.length > 0 &&
          lastPageWithText(content) <= pageImages.length
        ) {
          content = '';
        }
      } catch (e) {
        // Stopping is not a failure
        rethrowIfAborted(e, progress.signal);
        console.warn('PDF page rendering failed:', e);
      }
    }
  } else if (
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileExtension === '.docx'
  ) {
    content = await processDocxFile(file, options, progressOf('docx'));
  } else if (
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.type === 'application/vnd.ms-excel' ||
    fileExtension === '.xlsx' ||
    fileExtension === '.xls'
  ) {
    content = await processXlsxFile(file, progressOf('opaque'));
  } else if (file.type === 'application/vnd.ms-outlook' || fileExtension === '.msg') {
    content = await processMsgFile(file, progressOf('opaque'));
  } else if (
    file.type === 'image/tif' ||
    file.type === 'image/tiff' ||
    fileExtension === '.tif' ||
    fileExtension === '.tiff'
  ) {
    content = await processTiffFile(file, {}, progressOf('tiff'));
  } else if (
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    fileExtension === '.pptx'
  ) {
    content = await processPptxFile(file, options, progressOf('pptx'));
  } else if (file.type === 'application/vnd.ms-powerpoint' || fileExtension === '.ppt') {
    // Legacy binary PowerPoint (OLE compound file) — no client-side extractor
    // exists. Reject instead of falling through to readTextFile, which would
    // decode the OLE container as garbage text.
    throw new Error('unsupported-format');
  } else if (
    file.type === 'application/vnd.oasis.opendocument.text' ||
    file.type === 'application/vnd.oasis.opendocument.spreadsheet' ||
    file.type === 'application/vnd.oasis.opendocument.presentation' ||
    fileExtension === '.odt' ||
    fileExtension === '.ods' ||
    fileExtension === '.odp'
  ) {
    content = await processOpenOfficeFile(file, options, progressOf('opaque'));
  } else {
    // Default: read as text file
    content = await readTextFile(file, readingOf(progressOf('read')));
    // Unknown binary formats (renamed Office files, archives, executables)
    // decode to NUL/replacement-character soup here — refuse to treat that
    // as document content rather than flooding the model's context window.
    if (looksLikeBinaryText(content)) {
      throw new Error('unsupported-format');
    }
  }

  return { content, pageImages };
};

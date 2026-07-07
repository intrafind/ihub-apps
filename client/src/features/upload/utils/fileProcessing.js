// Shared file processing utilities for upload components
import { fetchMimetypesConfig } from '../../../api/endpoints/config';
// Resolved by Vite at build time → copied to dist as a local asset.
// Using the ?url suffix is the correct Vite pattern for worker files from
// node_modules; it ensures offline/air-gapped deployments work and the
// version always tracks the installed pdfjs-dist package.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Cache for mimetypes configuration
let mimetypesConfigCache = null;
let mimetypesConfigPromise = null;

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

// Lazy load PDF.js only when needed
export const loadPdfjs = async () => {
  const pdfjsLib = await import('pdfjs-dist');
  // Use the locally bundled worker (resolved by the static import above).
  // Works in offline/air-gapped environments; version tracks pdfjs-dist.
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
  return pdfjsLib;
};

// Lazy load Mammoth only when needed
export const loadMammoth = async () => {
  const mammoth = await import('mammoth');
  return mammoth;
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

/**
 * Process TIFF file and convert to PNG/JPEG
 * Handles multipage TIFF by converting each page
 * @param {File} file - The TIFF file to process
 * @param {Object} options - Processing options
 * @param {number} options.maxDimension - Maximum dimension for resizing
 * @param {boolean} options.resize - Whether to resize images
 * @returns {Promise<Array>} Array of processed image data (one per page)
 */
export const processTiffFile = async (file, options = {}) => {
  const { maxDimension = 1024, resize = true } = options;

  try {
    // Load UTIF library
    const UTIF = await loadUTIF();

    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();

    // Decode TIFF
    const ifds = UTIF.decode(arrayBuffer);

    // Process each page
    const pages = [];

    for (let i = 0; i < ifds.length; i++) {
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
    console.error('Error processing TIFF file:', error);
    throw new Error('tiff-processing-error');
  }
};

/**
 * Extract audio from a video file using Web Audio API
 * @param {File} file - The video file to extract audio from
 * @param {Object} options - Processing options
 * @param {string} options.format - Output format: 'wav' (default) or 'mp3'
 * @returns {Promise<Object>} Object with audioBuffer and metadata
 */
export const extractAudioFromVideo = async (file, options = {}) => {
  const { format = 'wav' } = options;

  try {
    // Create audio context
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Read video file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();

    // Decode audio from video file
    let audioBuffer;
    try {
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    } catch (decodeError) {
      console.error('Audio decode error:', decodeError);
      throw new Error('audio-decode-error');
    }

    // Use OfflineAudioContext to render the audio
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      audioBuffer.length,
      audioBuffer.sampleRate
    );

    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start();

    const renderedBuffer = await offlineContext.startRendering();

    // Convert to WAV format
    const wavBlob = audioBufferToWav(renderedBuffer);
    const wavBase64 = await blobToBase64(wavBlob);

    // Get duration in seconds
    const duration = renderedBuffer.duration;

    // Clean up
    await audioContext.close();

    return {
      audioBuffer: renderedBuffer,
      base64: wavBase64,
      blob: wavBlob,
      format: 'audio/wav',
      sampleRate: renderedBuffer.sampleRate,
      channels: renderedBuffer.numberOfChannels,
      duration,
      size: wavBlob.size
    };
  } catch (error) {
    console.error('Error extracting audio from video:', error);
    if (error.message === 'audio-decode-error') {
      throw error;
    }
    throw new Error('video-audio-extraction-error');
  }
};

/**
 * Convert AudioBuffer to WAV Blob
 * @param {AudioBuffer} audioBuffer - The audio buffer to convert
 * @returns {Blob} WAV file blob
 */
const audioBufferToWav = audioBuffer => {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;

  const data = [];
  for (let i = 0; i < numberOfChannels; i++) {
    data.push(audioBuffer.getChannelData(i));
  }

  const dataLength = audioBuffer.length * numberOfChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write audio data
  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, data[channel][i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
};

/**
 * Write string to DataView
 * @param {DataView} view - The DataView to write to
 * @param {number} offset - Offset position
 * @param {string} string - String to write
 */
const writeString = (view, offset, string) => {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
};

/**
 * Convert Blob to base64 string
 * @param {Blob} blob - The blob to convert
 * @returns {Promise<string>} Base64 data URL
 */
const blobToBase64 = blob => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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

// Read text file
export const readTextFile = file => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('read-error'));
    reader.readAsText(file);
  });
};

// Process PDF file
export const processPdfFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
  let textContent = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContentPage = await page.getTextContent();
    const textItems = textContentPage.items.map(item => item.str).join(' ');
    textContent += textItems + '\n';
  }

  return textContent.trim();
};

// Render PDF pages to images when text extraction yields nothing
export const renderPdfPagesToImages = async (file, maxPages = 5, scale = 1.5) => {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
  const pages = Math.min(pdf.numPages, maxPages);
  const images = [];
  for (let i = 1; i <= pages; i++) {
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
};

// Process DOCX file
export const processDocxFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
  const mammoth = await loadMammoth();
  const result = await mammoth.convertToHtml({ arrayBuffer });

  // Extract plain text from HTML for better readability
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = result.value;
  return tempDiv.textContent || tempDiv.innerText || '';
};

// Process XLSX / XLS file — converts all sheets to tab-separated text
export const processXlsxFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
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
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, n) => {
      let code = parseInt(n, 10);
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
export const processMsgFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
  const MsgReader = await loadMsgReader();
  const msgReader = new MsgReader(arrayBuffer);
  const fileData = msgReader.getFileData();
  return extractMsgContent(fileData);
};

// DrawingML namespace — text runs in PPTX slide XML live in <a:t> elements
// under this namespace regardless of the prefix the producer chose.
const DRAWINGML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// Process PPTX file — extracts the visible text of every slide from the OOXML
// package (ppt/slides/slideN.xml). Without this handler PPTX fell through to
// readTextFile, which decoded the raw ZIP container as text and shipped
// hundreds of thousands of garbage tokens to the model.
export const processPptxFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const slideNumber = path => {
    const match = path.match(/slide(\d+)\.xml$/);
    return match ? parseInt(match[1], 10) : 0;
  };
  const slidePaths = Object.keys(zip.files)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const parser = new DOMParser();
  const slides = [];
  for (const path of slidePaths) {
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

// Process OpenOffice/LibreOffice file
export const processOpenOfficeFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
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

// Main document processing function
// Returns { content, pageImages } where pageImages is set for image-based PDFs
export const processDocumentFile = async file => {
  let content = '';
  let pageImages;

  // Get file extension as fallback for MIME type detection
  const fileExtension = '.' + file.name.split('.').pop().toLowerCase();

  // Determine processing method based on MIME type or file extension
  if (file.type === 'application/pdf' || fileExtension === '.pdf') {
    content = await processPdfFile(file);
    // If text extraction yields empty/minimal content, render pages as images
    if (!content || content.trim().length < 50) {
      console.log(
        `[fileProcessing] PDF text extraction yielded ${content ? content.trim().length : 0} chars, attempting page-to-image rendering`
      );
      try {
        pageImages = await renderPdfPagesToImages(file, 5);
        console.log(
          `[fileProcessing] Rendered ${pageImages.length} PDF page(s) as images (${pageImages.reduce((sum, img) => sum + img.length, 0)} bytes total base64)`
        );
      } catch (e) {
        console.warn('PDF page rendering failed:', e);
      }
    }
  } else if (
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileExtension === '.docx'
  ) {
    content = await processDocxFile(file);
  } else if (
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.type === 'application/vnd.ms-excel' ||
    fileExtension === '.xlsx' ||
    fileExtension === '.xls'
  ) {
    content = await processXlsxFile(file);
  } else if (file.type === 'application/vnd.ms-outlook' || fileExtension === '.msg') {
    content = await processMsgFile(file);
  } else if (
    file.type === 'image/tif' ||
    file.type === 'image/tiff' ||
    fileExtension === '.tif' ||
    fileExtension === '.tiff'
  ) {
    content = await processTiffFile(file);
  } else if (
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    fileExtension === '.pptx'
  ) {
    content = await processPptxFile(file);
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
    content = await processOpenOfficeFile(file);
  } else {
    // Default: read as text file
    content = await readTextFile(file);
    // Unknown binary formats (renamed Office files, archives, executables)
    // decode to NUL/replacement-character soup here — refuse to treat that
    // as document content rather than flooding the model's context window.
    if (looksLikeBinaryText(content)) {
      throw new Error('unsupported-format');
    }
  }

  return { content, pageImages };
};

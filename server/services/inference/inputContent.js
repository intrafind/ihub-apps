/**
 * Request input of the inference API → iHub chat messages.
 *
 * The chat pipeline takes a message as `{ role, content, fileData?,
 * imageData? }`: `content` is what the user typed, `fileData` the documents
 * (their extracted text, rendered around the typed text as `<content>` blocks
 * by `shared/promptContext.js`) and `imageData` the pictures (base64, each
 * adapter formats them for its provider). The browser extracts document text
 * before it sends; an API caller sends the file itself, so the text is
 * extracted here.
 *
 * Two request shapes are understood:
 *
 *   - Responses `input`: a string, or a list of message items whose content is
 *     `input_text` / `input_image` / `input_file` parts (`output_text` for
 *     earlier assistant turns);
 *   - Chat Completions `messages` content parts: `text`, `image_url`, `file`.
 *
 * Files and images travel inline (`data:` URLs or base64). Provider-hosted
 * references — an OpenAI `file_id`, a remote URL — are refused: iHub has no
 * files API, and fetching an arbitrary URL on the caller's behalf is not
 * something this endpoint does.
 *
 * @module services/inference/inputContent
 */
import path from 'node:path';
import { InferenceApiError } from './errors.js';

/** Longest document text taken from one file. */
export const MAX_FILE_TEXT_CHARS = 500_000;

/** PDF pages read from one file. */
const MAX_PDF_PAGES = 500;

/** MIME types read as UTF-8 text. */
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/csv',
  'application/x-ndjson',
  'application/javascript',
  'application/sql'
]);

/** File extensions read as text when no usable MIME type came along. */
const TEXT_EXTENSIONS = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.json', 'application/json'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.log', 'text/plain']
]);

const IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
]);

const DATA_URL = /^data:([^;,]*)(;[^,]*)?,(.*)$/s;

/**
 * Split inline file data into its MIME type and base64 payload.
 *
 * @param {string} data - A `data:` URL or bare base64.
 * @returns {{mimeType: string|null, base64: string}}
 */
function parseInlineData(data) {
  const match = DATA_URL.exec(data);
  if (!match) return { mimeType: null, base64: data.replace(/\s+/g, '') };
  const [, mimeType, params = '', payload] = match;
  if (!/;base64/i.test(params)) {
    // A percent-encoded data URL: re-encode so every caller sees base64.
    let decoded;
    try {
      decoded = decodeURIComponent(payload);
    } catch {
      throw new InferenceApiError(400, 'invalid_file', 'data: URL has invalid percent-encoding');
    }
    return {
      mimeType: mimeType || null,
      base64: Buffer.from(decoded, 'utf8').toString('base64')
    };
  }
  return { mimeType: mimeType || null, base64: payload.replace(/\s+/g, '') };
}

function mimeFromName(filename, table) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return table.get(ext) || null;
}

function isTextMime(mimeType) {
  return mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(mimeType);
}

/**
 * The text of a PDF.
 *
 * @param {Buffer} bytes
 * @returns {Promise<string>}
 */
async function pdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  try {
    let text = '';
    const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      text += `${content.items.map(item => item.str).join(' ')}\n`;
      if (text.length > MAX_FILE_TEXT_CHARS) break;
    }
    return text.trim();
  } finally {
    await pdf.destroy?.();
  }
}

/**
 * A document from the request as chat `fileData`.
 *
 * @param {Object} file
 * @param {string} file.data - `data:` URL or base64.
 * @param {string} [file.filename]
 * @param {string} param - Request field, for errors.
 * @returns {Promise<{fileName: string, fileType: string, content: string}>}
 * @throws {InferenceApiError} 400 for a type without text or an unreadable file.
 */
export async function documentFromInlineFile({ data, filename }, param) {
  if (typeof data !== 'string' || !data) {
    throw new InferenceApiError(400, 'invalid_file', 'file data is empty', { param });
  }
  const parsed = parseInlineData(data);
  const fileName = typeof filename === 'string' && filename ? filename.slice(0, 255) : 'document';
  let mimeType = (parsed.mimeType || '').toLowerCase();
  if (!mimeType || mimeType === 'application/octet-stream') {
    mimeType =
      mimeFromName(fileName, TEXT_EXTENSIONS) ||
      (path.extname(fileName).toLowerCase() === '.pdf' ? 'application/pdf' : '');
  }
  const bytes = Buffer.from(parsed.base64, 'base64');
  if (bytes.length === 0) {
    throw new InferenceApiError(
      400,
      'invalid_file',
      `${fileName}: file data is empty or not base64`,
      {
        param
      }
    );
  }

  let text;
  if (mimeType === 'application/pdf') {
    try {
      text = await pdfText(bytes);
    } catch (error) {
      throw new InferenceApiError(
        400,
        'invalid_file',
        `${fileName}: not a readable PDF (${error.message})`,
        {
          param
        }
      );
    }
    if (!text) {
      throw new InferenceApiError(
        400,
        'file_has_no_text',
        `${fileName}: the PDF has no extractable text (scanned documents are not supported through the API; send the pages as input_image)`,
        { param }
      );
    }
  } else if (mimeType && isTextMime(mimeType)) {
    text = bytes.toString('utf8');
  } else {
    throw new InferenceApiError(
      400,
      'unsupported_file_type',
      `${fileName}: unsupported file type ${mimeType || '(unknown)'}. Send PDF or text files, or images as input_image.`,
      { param }
    );
  }
  return {
    fileName,
    fileType: mimeType,
    content: text.length > MAX_FILE_TEXT_CHARS ? text.slice(0, MAX_FILE_TEXT_CHARS) : text,
    bytes: bytes.length
  };
}

/**
 * An image from the request as chat `imageData`.
 *
 * @param {string} url - `data:` URL (or bare base64 with a name to infer the type).
 * @param {string} param
 * @param {string} [filename]
 * @returns {{base64: string, fileType: string, fileName?: string}}
 */
export function imageFromInline(url, param, filename) {
  if (typeof url !== 'string' || !url) {
    throw new InferenceApiError(400, 'invalid_image', 'image_url is required', { param });
  }
  if (/^https?:\/\//i.test(url)) {
    throw new InferenceApiError(
      400,
      'unsupported_image_source',
      'Remote image URLs are not supported; send the image inline as a data: URL',
      { param }
    );
  }
  const parsed = parseInlineData(url);
  const fileType = (
    parsed.mimeType ||
    mimeFromName(filename, IMAGE_EXTENSIONS) ||
    ''
  ).toLowerCase();
  if (!fileType.startsWith('image/')) {
    throw new InferenceApiError(400, 'invalid_image', 'image_url must be a data:image/... URL', {
      param
    });
  }
  return { base64: parsed.base64, fileType, ...(filename ? { fileName: String(filename) } : {}) };
}

function refuseHostedReference(kind, param) {
  throw new InferenceApiError(
    400,
    'unsupported_file_reference',
    `${kind} is not supported: iHub has no files API. Send the file inline (file_data / a data: URL).`,
    { param }
  );
}

/** An empty message under construction. */
function newMessage(role) {
  return { role, text: [], files: [], images: [] };
}

/** The finished chat message of one collected input message. */
function finish(message) {
  const out = { role: message.role, content: message.text.join('\n') };
  if (message.files.length > 0) out.fileData = message.files;
  if (message.images.length > 0) out.imageData = message.images;
  return out;
}

/**
 * The upload descriptors of a message, for the stored transcript.
 *
 * @param {Object} message - Chat message.
 * @returns {Array<{type: string, name?: string, bytes?: number}>}
 */
export function attachmentsOf(message) {
  return [
    ...(message.fileData || []).map(file => ({
      type: file.fileType,
      name: file.fileName,
      ...(Number.isFinite(file.bytes) ? { bytes: file.bytes } : {})
    })),
    ...(message.imageData || []).map(image => ({
      type: image.fileType,
      ...(image.fileName ? { name: image.fileName } : {})
    }))
  ];
}

const RESPONSES_ROLES = new Set(['user', 'assistant', 'system', 'developer']);

/**
 * Responses `input` → chat messages, oldest first.
 *
 * @param {unknown} input
 * @returns {Promise<Array<{role: string, content: string, fileData?: Array, imageData?: Array}>>}
 * @throws {InferenceApiError}
 */
export async function messagesFromResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) {
    throw new InferenceApiError(
      400,
      'invalid_input',
      'input must be a string or an array of items',
      {
        param: 'input'
      }
    );
  }
  const messages = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const param = `input[${index}]`;
    if (!item || typeof item !== 'object') {
      throw new InferenceApiError(400, 'invalid_input', `${param} must be an object`, { param });
    }
    if (item.type !== undefined && item.type !== 'message') {
      throw new InferenceApiError(
        400,
        'unsupported_input_item',
        `${param}: input items of type ${String(item.type)} are not supported; send message items`,
        { param: `${param}.type` }
      );
    }
    if (!RESPONSES_ROLES.has(item.role)) {
      throw new InferenceApiError(
        400,
        'invalid_input',
        `${param}.role must be one of user, assistant, system, developer`,
        { param: `${param}.role` }
      );
    }
    const message = newMessage(item.role === 'developer' ? 'system' : item.role);
    const parts =
      typeof item.content === 'string'
        ? [{ type: 'input_text', text: item.content }]
        : item.content;
    if (!Array.isArray(parts)) {
      throw new InferenceApiError(
        400,
        'invalid_input',
        `${param}.content must be a string or an array`,
        {
          param: `${param}.content`
        }
      );
    }
    for (let p = 0; p < parts.length; p += 1) {
      const part = parts[p];
      const partParam = `${param}.content[${p}]`;
      const type = part?.type;
      if (type === 'input_text' || type === 'output_text' || type === 'text') {
        if (typeof part.text !== 'string') {
          throw new InferenceApiError(400, 'invalid_input', `${partParam}.text must be a string`, {
            param: partParam
          });
        }
        message.text.push(part.text);
      } else if (type === 'refusal') {
        if (typeof part.refusal === 'string') message.text.push(part.refusal);
      } else if (type === 'input_image') {
        if (part.file_id) refuseHostedReference('input_image.file_id', partParam);
        message.images.push(imageFromInline(part.image_url, partParam));
      } else if (type === 'input_file') {
        if (part.file_id) refuseHostedReference('input_file.file_id', partParam);
        if (part.file_url) refuseHostedReference('input_file.file_url', partParam);
        message.files.push(
          await documentFromInlineFile({ data: part.file_data, filename: part.filename }, partParam)
        );
      } else {
        throw new InferenceApiError(
          400,
          'unsupported_content_part',
          `${partParam}: content parts of type ${String(type)} are not supported`,
          { param: partParam }
        );
      }
    }
    if (message.role !== 'user' && (message.files.length > 0 || message.images.length > 0)) {
      throw new InferenceApiError(
        400,
        'invalid_input',
        `${param}: only user messages carry files`,
        {
          param
        }
      );
    }
    messages.push(finish(message));
  }
  return messages;
}

const CHAT_ROLES = new Set(['user', 'assistant', 'system', 'developer']);

/**
 * Chat Completions `messages` → chat messages, for the app path (the model
 * path forwards messages as they came).
 *
 * @param {Array} messages
 * @returns {Promise<Array>}
 * @throws {InferenceApiError}
 */
export async function messagesFromChatCompletions(messages) {
  const out = [];
  for (let index = 0; index < messages.length; index += 1) {
    const entry = messages[index];
    const param = `messages[${index}]`;
    if (!entry || typeof entry !== 'object' || !CHAT_ROLES.has(entry.role)) {
      throw new InferenceApiError(
        400,
        'invalid_messages',
        `${param}.role must be one of user, assistant, system, developer (tool messages need a model that runs your own tools; apps run theirs)`,
        { param: `${param}.role` }
      );
    }
    if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
      throw new InferenceApiError(
        400,
        'invalid_messages',
        `${param}: tool calls cannot be replayed to an app; apps run their own tools`,
        { param }
      );
    }
    const message = newMessage(entry.role === 'developer' ? 'system' : entry.role);
    const parts =
      typeof entry.content === 'string'
        ? [{ type: 'text', text: entry.content }]
        : entry.content === null || entry.content === undefined
          ? []
          : entry.content;
    if (!Array.isArray(parts)) {
      throw new InferenceApiError(
        400,
        'invalid_messages',
        `${param}.content must be a string or an array`,
        {
          param: `${param}.content`
        }
      );
    }
    for (let p = 0; p < parts.length; p += 1) {
      const part = parts[p];
      const partParam = `${param}.content[${p}]`;
      const type = part?.type;
      if (type === 'text') {
        if (typeof part.text === 'string') message.text.push(part.text);
      } else if (type === 'image_url') {
        message.images.push(imageFromInline(part.image_url?.url, partParam));
      } else if (type === 'file') {
        const file = part.file || {};
        if (file.file_id) refuseHostedReference('file.file_id', partParam);
        message.files.push(
          await documentFromInlineFile({ data: file.file_data, filename: file.filename }, partParam)
        );
      } else {
        throw new InferenceApiError(
          400,
          'unsupported_content_part',
          `${partParam}: content parts of type ${String(type)} are not supported`,
          { param: partParam }
        );
      }
    }
    if (message.role !== 'user' && (message.files.length > 0 || message.images.length > 0)) {
      throw new InferenceApiError(
        400,
        'invalid_messages',
        `${param}: only user messages carry files`,
        {
          param
        }
      );
    }
    out.push(finish(message));
  }
  return out;
}

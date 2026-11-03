// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * Files travel inline (`data:` URLs or base64) or by reference: a `file_id` is a
 * file the caller uploaded with `POST /v1/files` (see ./files.js), or one that is
 * stored in the conversation the response runs in. Images are inline only.
 * Remote URLs are refused: fetching an arbitrary URL on the caller's behalf is not
 * something this endpoint does.
 *
 * An inline file is read by the shared chat-file pipeline (`ingestChatFile`, see
 * ./files.js): the same types, the same Markdown, and a scanned PDF becomes page
 * images instead of an error.
 *
 * @module services/inference/inputContent
 */
import path from 'node:path';
import { renderUserMessage } from '../../../shared/promptContext.js';
import { InferenceApiError } from './errors.js';
import {
  DOCX_MIME,
  MAX_PDF_PAGES,
  ODP_MIME,
  ODS_MIME,
  ODT_MIME,
  PPTX_MIME,
  structuredExtractionEnabled
} from '../documentExtraction.js';
import { PDF_MIME, XLSX_MIME, acceptedTypeOf } from '../projects/extractText.js';
import { extractInlineFile, pageImagesOf, rememberOriginal } from './files.js';

/** Longest document text taken from one file. */
export const MAX_FILE_TEXT_CHARS = 500_000;

/**
 * Office and OpenDocument types, which the admin switch "Structured document
 * extraction" gates: with it off the API reads PDFs and text only, as it did
 * before the structured extraction existed.
 */
const STRUCTURED_ONLY_TYPES = new Set([
  DOCX_MIME,
  PPTX_MIME,
  XLSX_MIME,
  ODT_MIME,
  ODS_MIME,
  ODP_MIME
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

/**
 * The text of a PDF as it was before the structured extraction: the words of a page joined by
 * spaces, no page markers. Used while the admin switch "Structured document extraction" is off.
 *
 * @param {Buffer} bytes
 * @returns {Promise<string>}
 */
async function legacyPdfText(bytes) {
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
 * The document of a file read the way the API did before the structured extraction
 * (admin switch off): a PDF's text in one run, no Office files. Null when the switch
 * does not change how this file is read.
 *
 * @returns {Promise<{text: string, mimeType: string}|null>}
 */
async function readWithoutStructuredExtraction({ bytes, mimeType, fileName }, param) {
  const accepted = acceptedTypeOf({ contentType: mimeType, name: fileName });
  if (accepted === PDF_MIME) {
    let text;
    try {
      text = await legacyPdfText(bytes);
    } catch (error) {
      throw new InferenceApiError(
        400,
        'invalid_file',
        `${fileName}: not a readable PDF (${error.message})`,
        { param }
      );
    }
    if (!text) {
      throw new InferenceApiError(
        400,
        'file_has_no_text',
        `${fileName}: the PDF has no extractable text (scanned documents are read only with the structured extraction switched on; send the pages as input_image)`,
        { param }
      );
    }
    return { text, mimeType: PDF_MIME };
  }
  if (accepted && STRUCTURED_ONLY_TYPES.has(accepted)) {
    throw new InferenceApiError(
      400,
      'unsupported_file_type',
      `${fileName}: unsupported file type ${accepted}. Send PDF, e-mail (.eml, .msg) or text files, or images as input_image.`,
      { param }
    );
  }
  return null;
}

/**
 * A document from the request as chat `fileData`, read by the shared chat-file
 * pipeline: PDF (a scanned one becomes `pageImages`), Word, PowerPoint, Excel,
 * OpenDocument, HTML, e-mail and text files. Nothing is stored; the bytes stay
 * reachable through `originalBytesOf` so a persisted turn can keep the file.
 *
 * @param {Object} file
 * @param {string} file.data - `data:` URL or base64.
 * @param {string} [file.filename]
 * @param {string} param - Request field, for errors.
 * @returns {Promise<{fileName: string, fileType: string, content: string, bytes: number,
 *   origin: 'api', pages?: number, pageImages?: string[], truncated?: boolean}>}
 * @throws {InferenceApiError} 400 for a type that is not supported, a file without text
 *   or an unreadable one; 413 for a file over the size limit.
 */
export async function documentFromInlineFile({ data, filename }, param) {
  if (typeof data !== 'string' || !data) {
    throw new InferenceApiError(400, 'invalid_file', 'file data is empty', { param });
  }
  const parsed = parseInlineData(data);
  const fileName = typeof filename === 'string' && filename ? filename.slice(0, 255) : 'document';
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
  const mimeType = (parsed.mimeType || '').toLowerCase();

  const legacy = structuredExtractionEnabled()
    ? null
    : await readWithoutStructuredExtraction({ bytes, mimeType, fileName }, param);
  const extracted =
    legacy ||
    // Speaker notes stay out, as they always did on this API: a presenter's notes are not
    // what was sent to the model unless the caller put them on a slide.
    (await extractInlineFile({ name: fileName, mimeType, bytes }, param, {
      speakerNotes: 'ignore'
    }));
  const text = extracted.text;
  const truncated = extracted.truncated === true || text.length > MAX_FILE_TEXT_CHARS;
  return rememberOriginal(
    {
      fileName,
      fileType: extracted.mimeType,
      content: text.length > MAX_FILE_TEXT_CHARS ? text.slice(0, MAX_FILE_TEXT_CHARS) : text,
      bytes: bytes.length,
      origin: 'api',
      ...(Number.isFinite(extracted.pages) ? { pages: extracted.pages } : {}),
      ...(extracted.pageImages ? { pageImages: extracted.pageImages } : {}),
      ...(truncated ? { truncated: true } : {})
    },
    bytes
  );
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

function refuseHostedReference(kind, param, hint) {
  throw new InferenceApiError(
    400,
    'unsupported_file_reference',
    `${kind} is not supported${hint ? `: ${hint}` : ''}`,
    { param }
  );
}

const FILE_HINT =
  'upload the file with POST /api/inference/v1/files and reference its id, or send it inline (file_data / a data: URL)';

/**
 * The document of a file content part: an inline file, or a `file_id` resolved
 * through the request's file context. Without a context (a caller that has no
 * caller to resolve for) a reference is refused, as it was before there was a
 * files API.
 *
 * @param {Object} part
 * @param {string} [part.fileId]
 * @param {string} [part.fileUrl]
 * @param {string} [part.data]
 * @param {string} [part.filename]
 * @param {string} kind - Part type, for errors (`input_file`, `file`).
 * @param {string} partParam
 * @param {{files?: {resolve: Function}}} ctx
 */
export async function fileFromPart({ fileId, fileUrl, data, filename }, kind, partParam, ctx) {
  if (fileUrl) {
    refuseHostedReference(
      `${kind}.file_url`,
      partParam,
      `fetching a URL is not supported; ${FILE_HINT}`
    );
  }
  if (fileId) {
    if (!ctx?.files) refuseHostedReference(`${kind}.file_id`, partParam, FILE_HINT);
    return ctx.files.resolve(fileId, partParam);
  }
  return documentFromInlineFile({ data, filename }, partParam);
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
 * @param {Array<Object>|null} [fileDescriptors] - The descriptors of the message's files as
 *   stored (`persistTurnFiles`, with their ids); without them the files are described as sent.
 * @returns {Array<{id?: string, type: string, name?: string, bytes?: number}>}
 */
export function attachmentsOf(message, fileDescriptors = null) {
  return [
    ...(fileDescriptors ||
      (message.fileData || []).map(file => ({
        type: file.fileType,
        name: file.fileName,
        ...(Number.isFinite(file.bytes) ? { bytes: file.bytes } : {})
      }))),
    ...(message.imageData || []).map(image => ({
      type: image.fileType,
      ...(image.fileName ? { name: image.fileName } : {})
    }))
  ];
}

/**
 * A message as a plain model receives it: documents rendered as `<content>` blocks
 * in the text, the pages of scanned documents attached as images.
 *
 * @param {{role: string, content: string, fileData?: Array, imageData?: Array}} message
 * @returns {{role: string, content: string, imageData?: Array}}
 */
export function toModelMessage(message) {
  if (message.role !== 'user') return { role: message.role, content: message.content };
  const images = [...(message.imageData || []), ...pageImagesOf(message.fileData)];
  return {
    role: 'user',
    content: renderUserMessage({ content: message.content, files: message.fileData }),
    ...(images.length > 0 ? { imageData: images } : {})
  };
}

/**
 * The stored `renderedContent` of a turn whose files are stored with it: the
 * rendered message without the file blocks (they come back from the file
 * repository when the turn is replayed, see `hydratedHistoryForModel`).
 *
 * @param {string} rendered - The message as the model saw it, file blocks included.
 * @param {{content: string, fileData?: Array}} message
 * @returns {string|undefined} Undefined when the blocks cannot be told apart — the stored
 *   `content` is replayed then.
 */
export function renderedWithoutFiles(rendered, message) {
  const withFiles = renderUserMessage({ content: message.content, files: message.fileData });
  if (withFiles === message.content) return rendered;
  if (typeof rendered !== 'string' || !rendered.includes(withFiles)) return undefined;
  return rendered.replace(withFiles, () => message.content);
}

const RESPONSES_ROLES = new Set(['user', 'assistant', 'system', 'developer']);

/**
 * Responses `input` → chat messages, oldest first.
 *
 * @param {unknown} input
 * @param {{files?: {resolve: Function}}} [ctx] - Resolves `file_id` references
 *   (`createFileContext`); without it they are refused.
 * @returns {Promise<Array<{role: string, content: string, fileData?: Array, imageData?: Array}>>}
 * @throws {InferenceApiError}
 */
export async function messagesFromResponsesInput(input, ctx = {}) {
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
        if (part.file_id) {
          refuseHostedReference(
            'input_image.file_id',
            partParam,
            'images are not stored files; send the image inline as a data: URL'
          );
        }
        message.images.push(imageFromInline(part.image_url, partParam));
      } else if (type === 'input_file') {
        message.files.push(
          await fileFromPart(
            {
              fileId: part.file_id,
              fileUrl: part.file_url,
              data: part.file_data,
              filename: part.filename
            },
            'input_file',
            partParam,
            ctx
          )
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
 * One Chat Completions message → a chat message.
 *
 * @param {Object} entry
 * @param {number} index
 * @param {{files?: {resolve: Function}}} ctx
 */
async function chatMessageFromCompletions(entry, index, ctx) {
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
      message.files.push(
        await fileFromPart(
          { fileId: file.file_id, data: file.file_data, filename: file.filename },
          'file',
          partParam,
          ctx
        )
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
  return finish(message);
}

/**
 * Chat Completions `messages` → chat messages, for the app path (the model
 * path forwards messages as they came, see {@link withReadFiles}).
 *
 * @param {Array} messages
 * @param {{files?: {resolve: Function}}} [ctx] - Resolves `file_id` references
 *   (`createFileContext`); without it they are refused.
 * @returns {Promise<Array>}
 * @throws {InferenceApiError}
 */
export async function messagesFromChatCompletions(messages, ctx = {}) {
  const out = [];
  for (let index = 0; index < messages.length; index += 1) {
    out.push(await chatMessageFromCompletions(messages[index], index, ctx));
  }
  return out;
}

/** Whether a Chat Completions message carries a `file` content part. */
function hasFilePart(entry) {
  return Array.isArray(entry?.content) && entry.content.some(part => part?.type === 'file');
}

/**
 * Chat Completions `messages` for a plain model: a message with `file` content parts is
 * read (the files extracted, or fetched by `file_id`) and rendered as the model receives a
 * document — `<content>` blocks in the text, the pages of a scanned PDF as images. Every
 * other message, tool calls and tool results included, goes through untouched, and so does
 * the whole list when no message carries a file.
 *
 * @param {Array} messages
 * @param {{files?: {resolve: Function}}} [ctx]
 * @returns {Promise<Array>} The same array when there was nothing to read.
 * @throws {InferenceApiError}
 */
export async function withReadFiles(messages, ctx = {}) {
  if (!messages.some(hasFilePart)) return messages;
  const out = [];
  for (let index = 0; index < messages.length; index += 1) {
    out.push(
      hasFilePart(messages[index])
        ? toModelMessage(await chatMessageFromCompletions(messages[index], index, ctx))
        : messages[index]
    );
  }
  return out;
}

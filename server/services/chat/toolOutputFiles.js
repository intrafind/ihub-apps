// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files and pictures a tool hands back — an MCP server's `resource` / `image`
 * blocks, the `FilePart`s of a remote A2A agent, the documents of a system
 * skill — on their way to the chat's Files drawer.
 *
 * The rule is the one generated files already follow: the model sees a compact
 * descriptor (`{ fileId, name, mimeType, bytes }`), never the bytes. The bytes
 * go to the user and to the stored answer instead:
 *
 * - a document the server can read (PDF, Office, text) is ingested into the
 *   chat's `ChatFileRepository` scope with origin `mcp` / `a2a`, so it shows
 *   in the Files drawer and a later tool call can use it by `fileId`;
 * - a document of a generated-file type (PDF, Office, text, ZIP) is also held
 *   for the turn (`generatedFiles.js`) and reaches the client as a download
 *   card; the materializer stores it as an artifact of the chat;
 * - a picture is held here and reaches the client as an `image` delta; the
 *   materializer stores it as an artifact of kind `image`;
 * - anything else is refused with a note in the descriptor. Nothing throws.
 *
 * @module services/chat/toolOutputFiles
 */
import { randomUUID } from 'node:crypto';
import logger from '../../utils/logger.js';
import {
  GENERATED_FILE_MEDIA_TYPES,
  TEXT_FILE_TYPES,
  ZIP_MEDIA_TYPE,
  generatedFilesOf,
  textFileMediaType
} from '../../../shared/generatedFiles.js';
import {
  MAX_GENERATED_FILE_BYTES,
  holdGeneratedFile,
  heldGeneratedFileData
} from '../documents/generatedFiles.js';
import { OPAQUE_MEDIA_TYPE, artifactMediaType } from '../artifacts/artifactPolicy.js';
import { isValidId } from '../../utils/pathSecurity.js';

const COMPONENT = 'toolOutputFiles';

/** Most files and pictures lifted from one tool result; the rest are refused. */
export const MAX_LIFTED_BLOCKS = 20;

const HOLD_MS = 60 * 60 * 1000;
const MAX_HELD_IMAGES = 50;
const MAX_HELD_IMAGE_BYTES = 200 * 1024 * 1024;

/** Pictures held for the chat seam, by id, oldest first. */
const heldImages = new Map();

const EXTENSIONS = Object.freeze({
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp'
});

const OFFICE_BY_EXTENSION = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: ZIP_MEDIA_TYPE
});

/**
 * The media type of a file as the server will treat it: the declared one with
 * its parameters dropped and known aliases (`image/jpg`) resolved; when the
 * peer declared nothing useful, what the name's extension says.
 *
 * @param {unknown} mimeType
 * @param {unknown} [name]
 * @returns {string} `''` when nothing can be told.
 */
export function normalizeMediaType(mimeType, name) {
  const declared =
    typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase().slice(0, 120) : '';
  if (declared && declared !== OPAQUE_MEDIA_TYPE && declared !== 'binary/octet-stream') {
    for (const kind of ['image', 'document', 'code', 'archive']) {
      const known = artifactMediaType(kind, declared);
      if (known !== OPAQUE_MEDIA_TYPE) return known;
    }
    return declared;
  }
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(typeof name === 'string' ? name : '');
  const extension = match ? match[1].toLowerCase() : '';
  if (OFFICE_BY_EXTENSION[extension]) return OFFICE_BY_EXTENSION[extension];
  if (Object.hasOwn(TEXT_FILE_TYPES, extension)) return textFileMediaType(name);
  return declared;
}

/** `value` without leading and trailing dots and blanks (linear, no regex backtracking). */
function trimDotsAndBlanks(value) {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '.' || value[start] === ' ')) start += 1;
  while (end > start && (value[end - 1] === '.' || value[end - 1] === ' ')) end -= 1;
  return value.slice(start, end);
}

/**
 * A plain file name: last path segment, no control or reserved characters,
 * bounded. Falls back to `fallback` when nothing usable is left.
 *
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function plainFileName(value, fallback = 'file') {
  const last = String(typeof value === 'string' ? value : '')
    .split(/[\\/]/)
    .pop();
  const cleaned = trimDotsAndBlanks(
    last
      .replaceAll(/[:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .join(' ')
      .slice(0, 120)
  );
  return cleaned || fallback;
}

/**
 * A name for a file a peer did not name: the last segment of its URI, else a
 * generic one with the extension of its type.
 */
function deriveName({ name, uri, mimeType, index }) {
  if (typeof name === 'string' && name.trim()) return plainFileName(name);
  if (typeof uri === 'string' && uri) {
    let tail = '';
    try {
      tail = decodeURIComponent(new URL(uri).pathname.split('/').pop() || '');
    } catch {
      tail = '';
    }
    const fromUri = plainFileName(tail, '');
    if (fromUri) return fromUri;
  }
  const extension = EXTENSIONS[mimeType];
  return `file-${index + 1}${extension ? `.${extension}` : ''}`;
}

/**
 * Decode base64 without first allocating the decoded buffer of a payload that
 * is over the cap or not base64 at all.
 *
 * @param {unknown} value
 * @param {number} [maxBytes]
 * @returns {{ok: true, buffer: Buffer}|{ok: false, reason: 'invalid'|'empty'|'too-large', bytes?: number}}
 */
export function decodeBase64Capped(value, maxBytes = MAX_GENERATED_FILE_BYTES) {
  if (typeof value !== 'string') return { ok: false, reason: 'invalid' };
  const compact = value.replace(/^data:[^,]*;base64,/i, '').replaceAll(/\s+/g, '');
  if (!compact) return { ok: false, reason: 'empty' };
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return { ok: false, reason: 'invalid' };
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const estimate = Math.floor((compact.length * 3) / 4) - padding;
  if (estimate > maxBytes) return { ok: false, reason: 'too-large', bytes: estimate };
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length === 0) return { ok: false, reason: 'empty' };
  if (buffer.length > maxBytes) return { ok: false, reason: 'too-large', bytes: buffer.length };
  return { ok: true, buffer };
}

// ── held pictures ───────────────────────────────────────────────────────────

function pruneImages(now = Date.now()) {
  let total = 0;
  for (const [id, entry] of heldImages) {
    if (entry.expires <= now) heldImages.delete(id);
    else total += entry.data.length;
  }
  for (const [id, entry] of heldImages) {
    if (heldImages.size <= MAX_HELD_IMAGES && total <= MAX_HELD_IMAGE_BYTES) break;
    heldImages.delete(id);
    total -= entry.data.length;
  }
}

/**
 * Hold a picture a tool returned, for the chat to pick up.
 *
 * @param {Object} params
 * @param {string} [params.chatId]
 * @param {Buffer} params.data
 * @param {string} params.mimeType - An image type the artifact store accepts.
 * @param {string} [params.name]
 * @returns {{id: string, name: string, mimeType: string, bytes: number}}
 */
export function holdToolImage({ chatId, data, mimeType, name }) {
  const descriptor = {
    id: randomUUID().replaceAll('-', ''),
    name: plainFileName(name, 'image'),
    mimeType,
    bytes: data.length
  };
  heldImages.set(descriptor.id, {
    chatId: typeof chatId === 'string' && chatId ? chatId : null,
    data,
    descriptor,
    expires: Date.now() + HOLD_MS
  });
  pruneImages();
  return descriptor;
}

/**
 * A held picture, base64, for the chat seam.
 *
 * @param {string} id
 * @param {Object} [options]
 * @param {string} [options.chatId]
 * @returns {{mimeType: string, data: string, name: string, bytes: number}|null}
 */
export function heldToolImage(id, { chatId } = {}) {
  const entry = heldImages.get(String(id || ''));
  if (!entry || entry.expires <= Date.now()) return null;
  if (entry.chatId && chatId && entry.chatId !== chatId) return null;
  return {
    mimeType: entry.descriptor.mimeType,
    name: entry.descriptor.name,
    bytes: entry.descriptor.bytes,
    data: entry.data.toString('base64')
  };
}

/** Forget every held picture (tests). */
export function clearHeldToolImages() {
  heldImages.clear();
}

// ── storing one output ──────────────────────────────────────────────────────

/**
 * Store one file or picture a tool returned.
 *
 * Never throws: a file that cannot be kept comes back with `error` in its
 * descriptor, so the turn goes on and the model can say so.
 *
 * @param {Object} params
 * @param {string} params.chatId - The chat whose turn made the call.
 * @param {string|null} [params.ownerId] - Who owns the chat's files.
 * @param {Buffer} params.bytes
 * @param {string} [params.name]
 * @param {string} [params.mimeType]
 * @param {string} [params.uri] - Where the peer says it came from (names the file when it has no name).
 * @param {number} [params.index] - Position among the outputs (names the file).
 * @param {'mcp'|'a2a'} params.origin
 * @param {Object|null} [params.meta] - Identity of the producer (`serverId`, `agentId`, …).
 * @param {Object|null} [params.store] - A `ChatFileRepository` (tests).
 * @returns {Promise<{descriptor: Object, files: Array<Object>, images: Array<Object>}>}
 *   `descriptor` is what the model sees; `files` / `images` are the held
 *   descriptors the chat seam resolves into bytes.
 */
export async function storeToolOutputFile({
  chatId,
  ownerId = null,
  bytes,
  name,
  mimeType,
  uri,
  index = 0,
  origin,
  meta = null,
  store = null
}) {
  const mime = normalizeMediaType(mimeType, name);
  const fileName = deriveName({ name, uri, mimeType: mime, index });
  const size = Buffer.isBuffer(bytes) ? bytes.length : 0;
  const base = { type: 'file', name: fileName, mimeType: mime || 'application/octet-stream' };
  const refuse = error => ({
    descriptor: { ...base, bytes: size, error },
    files: [],
    images: []
  });
  if (!size) return refuse('The file is empty and was not stored.');
  if (size > MAX_GENERATED_FILE_BYTES) {
    return refuse(
      `The file is larger than ${MAX_GENERATED_FILE_BYTES / 1024 / 1024} MB and was not stored.`
    );
  }

  const out = { files: [], images: [] };
  let fileId = null;

  if (mime.startsWith('image/')) {
    if (artifactMediaType('image', mime) === OPAQUE_MEDIA_TYPE) {
      return refuse(`Images of type ${mime} are not supported and were not stored.`);
    }
    const held = holdToolImage({ chatId, data: bytes, mimeType: mime, name: fileName });
    out.images.push(held);
    return {
      descriptor: { ...base, mimeType: mime, fileId: held.id, bytes: size, displayedToUser: true },
      ...out
    };
  }

  // A document the server can read joins the chat's files (Files drawer,
  // later tool calls by `fileId`). Refusals — unsupported type, scanner,
  // quota, storage down — only mean it is not kept there.
  let ingestNote = null;
  if (chatId && isValidId(chatId)) {
    try {
      const { ingestChatFile } = await import('../chatFiles/ChatFileService.js');
      const stored = await ingestChatFile({
        scope: { type: 'chat', id: chatId },
        ownerId,
        name: fileName,
        mimeType: mime || undefined,
        bytes,
        origin,
        meta,
        ...(store ? { store } : {})
      });
      fileId = stored?.id || null;
    } catch (error) {
      ingestNote = error?.message || 'not stored';
      logger.debug('Tool output not added to the chat files', {
        component: COMPONENT,
        chatId,
        origin,
        code: error?.code,
        error: ingestNote
      });
    }
  }

  // A download card for the types a generated file may have.
  if (GENERATED_FILE_MEDIA_TYPES.includes(mime)) {
    try {
      const held = holdGeneratedFile({
        user: { id: ownerId },
        chatId,
        data: bytes,
        mimeType: mime,
        name: fileName
      });
      out.files.push({ id: held.id, name: held.name, mimeType: held.mimeType, bytes: held.bytes });
      fileId = fileId || held.id;
    } catch (error) {
      ingestNote = ingestNote || error?.message || 'not stored';
    }
  }

  if (!fileId) {
    return refuse(
      ingestNote
        ? `The file was not stored: ${String(ingestNote).slice(0, 200)}`
        : 'The file was not stored.'
    );
  }
  return {
    descriptor: { ...base, mimeType: mime, fileId, bytes: size },
    ...out
  };
}

// ── lifting MCP content blocks ──────────────────────────────────────────────

/** The base64 payload of a content block that carries a binary file, or null. */
function binaryBlockOf(part) {
  if (!part || typeof part !== 'object') return null;
  if ((part.type === 'image' || part.type === 'audio') && typeof part.data === 'string') {
    return { data: part.data, mimeType: part.mimeType, name: part.name || part.title, uri: null };
  }
  if (part.type === 'resource' && part.resource && typeof part.resource === 'object') {
    const { uri, mimeType, blob } = part.resource;
    // An embedded view page (`ui://…`) is for the host to render, not a file.
    if (typeof uri === 'string' && uri.startsWith('ui://')) return null;
    if (typeof blob === 'string') {
      return { data: blob, mimeType, name: part.resource.name || part.name, uri };
    }
  }
  return null;
}

/**
 * Replace the binary blocks of an MCP tool result with descriptors and store
 * the files they carried.
 *
 * @param {Array<Object>} content - The result's content blocks.
 * @param {Object} params
 * @param {string} params.chatId
 * @param {string|null} [params.ownerId]
 * @param {Object} [params.meta]
 * @param {Object|null} [params.store]
 * @returns {Promise<{result: Array<Object>, files: Array<Object>, images: Array<Object>}|null>}
 *   `null` when the result holds no binary block.
 */
export async function liftMcpBinaryContent(content, { chatId, ownerId, meta, store } = {}) {
  if (!Array.isArray(content) || !content.some(part => binaryBlockOf(part))) return null;
  const files = [];
  const images = [];
  const result = [];
  let lifted = 0;
  for (const part of content) {
    const block = binaryBlockOf(part);
    if (!block) {
      result.push(part);
      continue;
    }
    const index = lifted;
    lifted += 1;
    const mime = normalizeMediaType(block.mimeType, block.name);
    const name = deriveName({ name: block.name, uri: block.uri, mimeType: mime, index });
    if (index >= MAX_LIFTED_BLOCKS) {
      result.push({
        type: 'file',
        name,
        mimeType: mime || 'application/octet-stream',
        error: `More than ${MAX_LIFTED_BLOCKS} files in one result; this one was not stored.`
      });
      continue;
    }
    const decoded = decodeBase64Capped(block.data);
    if (!decoded.ok) {
      result.push({
        type: 'file',
        name,
        mimeType: mime || 'application/octet-stream',
        ...(decoded.bytes ? { bytes: decoded.bytes } : {}),
        error:
          decoded.reason === 'too-large'
            ? `The file is larger than ${MAX_GENERATED_FILE_BYTES / 1024 / 1024} MB and was not stored.`
            : decoded.reason === 'empty'
              ? 'The file is empty and was not stored.'
              : 'The file content is not valid base64 and was not stored.'
      });
      continue;
    }
    const stored = await storeToolOutputFile({
      chatId,
      ownerId,
      bytes: decoded.buffer,
      name: block.name,
      mimeType: block.mimeType,
      uri: block.uri,
      index,
      origin: 'mcp',
      meta,
      store
    });
    files.push(...stored.files);
    images.push(...stored.images);
    result.push(stored.descriptor);
  }
  return { result, files, images };
}

// ── the chat seam's entry point ─────────────────────────────────────────────

/** Held descriptors → what the client and the stored answer take (with bytes). */
export function resolveHeldOutputs({ files = [], images = [] }, { chatId } = {}) {
  return {
    files: generatedFilesOf(files)
      .map(file => ({ ...file, data: heldGeneratedFileData(file.id, { chatId }) }))
      .filter(file => file.data),
    images: (Array.isArray(images) ? images : [])
      .map(image => {
        const held =
          image && typeof image.id === 'string' ? heldToolImage(image.id, { chatId }) : null;
        return held ? { mimeType: held.mimeType, data: held.data, name: held.name } : null;
      })
      .filter(Boolean)
  };
}

/**
 * What the files and pictures of a finished tool call come to.
 *
 * - A system skill tool names its generated files in `result.files`.
 * - An A2A skill tool names the files and pictures its remote agent returned
 *   in `result.files` / `result.images`.
 * - An MCP tool's binary content blocks are stored here and replaced by
 *   descriptors (`replaced`, `rawResult`).
 *
 * Any other tool's result with the same fields is ignored.
 *
 * @param {Object} params
 * @param {Object} params.toolDef
 * @param {*} params.rawResult
 * @param {string} params.chatId
 * @param {string|null} [params.ownerId]
 * @param {Object|null} [params.store]
 * @returns {Promise<{replaced: boolean, rawResult?: *, files: Array<Object>, images: Array<Object>}>}
 */
export async function liftToolOutputs({
  toolDef,
  rawResult,
  chatId,
  ownerId = null,
  store = null
}) {
  const none = { replaced: false, files: [], images: [] };
  try {
    if (toolDef?.isSystemSkillTool) {
      return {
        ...none,
        ...resolveHeldOutputs({ files: rawResult?.files }, { chatId })
      };
    }
    if (toolDef?._a2a) {
      return {
        ...none,
        ...resolveHeldOutputs({ files: rawResult?.files, images: rawResult?.images }, { chatId })
      };
    }
    if (toolDef?._mcp && Array.isArray(rawResult)) {
      const lifted = await liftMcpBinaryContent(rawResult, {
        chatId,
        ownerId,
        meta: { serverId: toolDef._mcp.serverId, tool: toolDef._mcp.originalName },
        store
      });
      if (!lifted) return none;
      return {
        replaced: true,
        rawResult: lifted.result,
        ...resolveHeldOutputs(lifted, { chatId })
      };
    }
  } catch (error) {
    // Never crash the turn for a file; the model sees what it saw before.
    logger.warn('Tool output files could not be lifted', {
      component: COMPONENT,
      chatId,
      toolId: toolDef?.id,
      error: error?.message
    });
  }
  return none;
}

/**
 * Seam for runs without a client (`ChatService.invokeAppInternal`: the MCP and
 * A2A gateways): the same lift as the chat's tool seam, collecting what the
 * run's tools produced instead of streaming it.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {Object} [params.user]
 * @param {Array<Object>} params.generatedFiles - Receives `{id, name, mimeType, bytes, data}`.
 * @param {Array<Object>} params.generatedImages - Receives `{mimeType, data, name}`.
 * @param {Object|null} [params.store]
 */
export function headlessToolOutputSeam({
  chatId,
  user = null,
  generatedFiles,
  generatedImages,
  store = null
}) {
  return {
    name: 'headless-tool-outputs',
    async postTool(_ctx, info, outcome) {
      if (outcome.error) return;
      const lifted = await liftToolOutputs({
        toolDef: info.toolDef,
        rawResult: outcome.rawResult,
        chatId,
        ownerId: user?.id || null,
        store
      });
      if (lifted.replaced) {
        outcome.rawResult = lifted.rawResult;
        outcome.message.content = JSON.stringify(lifted.rawResult);
      }
      for (const file of lifted.files) {
        if (generatedFiles.length < 20) generatedFiles.push(file);
      }
      for (const image of lifted.images) {
        if (generatedImages.length < 20) generatedImages.push(image);
      }
    }
  };
}

/** Whether a mime type is a picture the artifact store accepts. */
export function isStorableImageType(mimeType) {
  return artifactMediaType('image', normalizeMediaType(mimeType)) !== OPAQUE_MEDIA_TYPE;
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files that arrive with a call from outside iHub: the `files` input of an MCP
 * `app__*` / `workflow__*` tool and the `FilePart`s of an A2A message.
 *
 * Both are untrusted. Every file is size-capped before it is decoded, goes
 * through the same server-side extraction, scanner and quotas as an upload
 * (`ingestChatFile`, origin `mcp` / `a2a`) into the chat the call runs in, and
 * comes back as a `fileData` entry on the user message (`prepareTurnFiles`).
 * A file that cannot be taken fails the call with an {@link InboundFileError}
 * the gateway answers as a protocol error — never an exception.
 *
 * @module services/mcp/inboundFiles
 */
import logger from '../../utils/logger.js';
import { httpFetch } from '../../utils/httpConfig.js';
import { assertPublicTarget, createPinnedLookup } from '../../utils/ssrfGuard.js';
import { MAX_GENERATED_FILE_BYTES } from '../documents/generatedFiles.js';
import { decodeBase64Capped, plainFileName } from '../chat/toolOutputFiles.js';

const COMPONENT = 'InboundFiles';

/** Most files one call may bring. */
export const MAX_INBOUND_FILES = 10;

/** Largest file one call may bring (inline or fetched). */
export const MAX_INBOUND_FILE_BYTES = MAX_GENERATED_FILE_BYTES;

/** How long fetching a `file.uri` may take. */
export const INBOUND_FETCH_TIMEOUT_MS = 30_000;

/**
 * Why a file of a call was refused. `code` is `UNSUPPORTED_TYPE` when the file
 * type cannot be read (A2A answers `-32005`), `INVALID_FILE` for everything the
 * caller got wrong, or the `ChatFileError` / quota code of the refusal.
 */
export class InboundFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InboundFileError';
    this.code = code;
  }
}

function labelOf(file, index) {
  return file?.name ? `"${plainFileName(file.name)}"` : `file ${index + 1}`;
}

/**
 * Validate the MCP `files` input and decode it.
 *
 * @param {unknown} files - `[{ name, mimeType?, data? (base64), text? }]`
 * @returns {Array<{name: string, mimeType: string|undefined, bytes?: Buffer, text?: string}>}
 * @throws {InboundFileError}
 */
export function normalizeMcpFiles(files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new InboundFileError('INVALID_FILE', '"files" must be an array');
  if (files.length > MAX_INBOUND_FILES) {
    throw new InboundFileError(
      'INVALID_FILE',
      `At most ${MAX_INBOUND_FILES} files per call are accepted`
    );
  }
  return files.map((file, index) => {
    if (!file || typeof file !== 'object') {
      throw new InboundFileError('INVALID_FILE', `files[${index}] must be an object`);
    }
    const name = plainFileName(file.name, '');
    if (!name) throw new InboundFileError('INVALID_FILE', `files[${index}] needs a "name"`);
    const mimeType =
      typeof file.mimeType === 'string' && file.mimeType.trim() ? file.mimeType.trim() : undefined;
    if (typeof file.data === 'string' && file.data) {
      const decoded = decodeBase64Capped(file.data, MAX_INBOUND_FILE_BYTES);
      if (!decoded.ok) throw decodeError(decoded, `"${name}"`);
      return { name, mimeType, bytes: decoded.buffer };
    }
    if (typeof file.text === 'string' && file.text.trim()) {
      if (Buffer.byteLength(file.text, 'utf8') > MAX_INBOUND_FILE_BYTES) {
        throw new InboundFileError('INVALID_FILE', `${labelOf(file, index)} is too large`);
      }
      return { name, mimeType: mimeType || 'text/plain', text: file.text };
    }
    throw new InboundFileError(
      'INVALID_FILE',
      `files[${index}] ("${name}") needs "data" (base64) or "text"`
    );
  });
}

function decodeError(decoded, label) {
  if (decoded.reason === 'too-large') {
    return new InboundFileError(
      'INVALID_FILE',
      `${label} is larger than ${MAX_INBOUND_FILE_BYTES / 1024 / 1024} MB`
    );
  }
  if (decoded.reason === 'empty') return new InboundFileError('INVALID_FILE', `${label} is empty`);
  return new InboundFileError('INVALID_FILE', `${label} is not valid base64`);
}

/**
 * Fetch the content of an A2A `file.uri`: HTTPS only, a public host (the
 * address is resolved once and the connection pinned to it, so a name cannot
 * be re-pointed at an internal host), no redirects, a size cap and a timeout.
 * Goes through `httpFetch`, so the platform's proxy and SSL whitelist apply.
 *
 * @param {string} uri
 * @param {Object} [options]
 * @param {number} [options.maxBytes]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetch] - Replacement for `httpFetch` (tests)
 * @param {Function} [options.assertPublic] - Replacement for the SSRF check (tests)
 * @returns {Promise<{bytes: Buffer, mimeType: string|undefined}>}
 * @throws {InboundFileError}
 */
export async function fetchInboundUri(
  uri,
  {
    maxBytes = MAX_INBOUND_FILE_BYTES,
    timeoutMs = INBOUND_FETCH_TIMEOUT_MS,
    fetch = httpFetch,
    assertPublic = assertPublicTarget
  } = {}
) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new InboundFileError('INVALID_FILE', 'file.uri is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new InboundFileError('INVALID_FILE', 'file.uri must be an https:// URL');
  }
  if (url.username || url.password) {
    throw new InboundFileError('INVALID_FILE', 'file.uri must not carry credentials');
  }
  const check = await assertPublic(url);
  if (!check?.ok) {
    throw new InboundFileError(
      'INVALID_FILE',
      `file.uri refused: ${check?.reason || 'host is not allowed'}`
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      lookup: createPinnedLookup(check.addresses)
    });
    if (response.status >= 300 && response.status < 400) {
      throw new InboundFileError('INVALID_FILE', 'file.uri must not redirect');
    }
    if (!response.ok) {
      throw new InboundFileError('INVALID_FILE', `file.uri answered HTTP ${response.status}`);
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new InboundFileError(
        'INVALID_FILE',
        `file.uri is larger than ${maxBytes / 1024 / 1024} MB`
      );
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) {
        controller.abort();
        throw new InboundFileError(
          'INVALID_FILE',
          `file.uri is larger than ${maxBytes / 1024 / 1024} MB`
        );
      }
      chunks.push(Buffer.from(chunk));
    }
    if (total === 0) throw new InboundFileError('INVALID_FILE', 'file.uri returned no content');
    const mimeType = response.headers?.get?.('content-type')?.split(';')[0].trim() || undefined;
    return { bytes: Buffer.concat(chunks), mimeType };
  } catch (error) {
    if (error instanceof InboundFileError) throw error;
    logger.warn('Inbound file could not be fetched', {
      component: COMPONENT,
      host: url.hostname,
      error: error?.message
    });
    throw new InboundFileError(
      'INVALID_FILE',
      controller.signal.aborted
        ? 'file.uri could not be fetched in time'
        : 'file.uri could not be fetched'
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalise the file parts of an A2A message (`part.kind === 'file'`).
 *
 * @param {Array<Object>} parts - The message's parts
 * @param {Object} [options] - Passed to {@link fetchInboundUri}
 * @returns {Promise<Array<{name: string, mimeType: string|undefined, bytes: Buffer}>>}
 * @throws {InboundFileError}
 */
export async function filesFromA2aParts(parts, options = {}) {
  const fileParts = (Array.isArray(parts) ? parts : []).filter(part => part?.kind === 'file');
  if (fileParts.length === 0) return [];
  if (fileParts.length > MAX_INBOUND_FILES) {
    throw new InboundFileError(
      'INVALID_FILE',
      `At most ${MAX_INBOUND_FILES} file parts per message are accepted`
    );
  }
  const out = [];
  for (const [index, part] of fileParts.entries()) {
    const file = part.file;
    if (!file || typeof file !== 'object') {
      throw new InboundFileError('INVALID_FILE', `File part ${index + 1} has no "file"`);
    }
    const declaredMime =
      typeof file.mimeType === 'string' && file.mimeType.trim() ? file.mimeType.trim() : undefined;
    const fallbackName = `file-${index + 1}`;
    if (typeof file.bytes === 'string' && file.bytes) {
      const name = plainFileName(file.name, fallbackName);
      const decoded = decodeBase64Capped(file.bytes, MAX_INBOUND_FILE_BYTES);
      if (!decoded.ok) throw decodeError(decoded, `"${name}"`);
      out.push({ name, mimeType: declaredMime, bytes: decoded.buffer });
    } else if (typeof file.uri === 'string' && file.uri) {
      const fetched = await fetchInboundUri(file.uri, options);
      let uriName = '';
      try {
        uriName = decodeURIComponent(new URL(file.uri).pathname.split('/').pop() || '');
      } catch {
        uriName = '';
      }
      out.push({
        name: plainFileName(file.name || uriName, fallbackName),
        mimeType: declaredMime || fetched.mimeType,
        bytes: fetched.bytes
      });
    } else {
      throw new InboundFileError(
        'INVALID_FILE',
        `File part ${index + 1} needs file.bytes (base64) or file.uri`
      );
    }
  }
  return out;
}

/**
 * Take the files of a call into the chat it runs in and attach them to the
 * user message.
 *
 * @param {Object} params
 * @param {Array<Object>} params.files - From {@link normalizeMcpFiles} / {@link filesFromA2aParts}
 * @param {string} params.chatId - The chat (scope) the call runs in
 * @param {Object} params.user - The authenticated caller
 * @param {'mcp'|'a2a'} params.origin
 * @param {Object} params.message - The user message (`{ role: 'user', content }`)
 * @param {Object|null} [params.store] - A `ChatFileRepository` (tests)
 * @returns {Promise<{message: Object, fileData: Array<Object>, attachments: Array<Object>}>}
 *   `message` is the user message with `fileData`; unchanged when there are no files
 * @throws {InboundFileError}
 */
export async function ingestInboundFiles({ files, chatId, user, origin, message, store = null }) {
  if (!Array.isArray(files) || files.length === 0) {
    return { message, fileData: [], attachments: [] };
  }
  const { ingestChatFile, prepareTurnFiles, ChatFileError } = await loadChatFiles();
  const { acceptedTypeOf, ACCEPTED_TYPES } = await import('../projects/extractText.js');
  const ownerId = user?.id || null;
  const fileIds = [];
  for (const [index, file] of files.entries()) {
    // The type is checked first: it is the caller's to fix, whatever the state
    // of the storage.
    if (file.bytes && !acceptedTypeOf({ contentType: file.mimeType, name: file.name })) {
      throw new InboundFileError(
        'UNSUPPORTED_TYPE',
        `${labelOf(file, index)} has an unsupported type. Supported: ${ACCEPTED_TYPES.summary}.`
      );
    }
    try {
      const stored = await ingestChatFile({
        scope: { type: 'chat', id: chatId },
        ownerId,
        name: file.name,
        mimeType: file.mimeType,
        ...(file.bytes ? { bytes: file.bytes } : { text: file.text }),
        origin,
        ...(store ? { store } : {})
      });
      fileIds.push(stored.id);
    } catch (error) {
      const code =
        error?.code === 'UNSUPPORTED_TYPE' || error?.code === 'STORAGE_UNAVAILABLE'
          ? error.code
          : 'INVALID_FILE';
      logger.warn('Inbound file refused', {
        component: COMPONENT,
        origin,
        code: error?.code,
        error: error?.message
      });
      if (error instanceof ChatFileError || error?.code) {
        throw new InboundFileError(code, `${labelOf(file, index)}: ${error.message}`);
      }
      throw new InboundFileError('INVALID_FILE', `${labelOf(file, index)} could not be read`);
    }
  }
  const prepared = await prepareTurnFiles({
    chatId,
    ownerId,
    message: { ...message, fileIds },
    ...(store ? { store } : {})
  });
  const promptMessage = prepared.promptMessage;
  // The ids were only the way to find the stored files again.
  const { fileIds: _ids, attachmentIds: _legacy, ...clean } = promptMessage;
  const fileData = Array.isArray(clean.fileData)
    ? clean.fileData
    : clean.fileData
      ? [clean.fileData]
      : [];
  return { message: clean, fileData, attachments: prepared.attachments };
}

async function loadChatFiles() {
  const service = await import('../chatFiles/ChatFileService.js');
  return {
    ingestChatFile: service.ingestChatFile,
    prepareTurnFiles: service.prepareTurnFiles,
    ChatFileError: service.ChatFileError
  };
}

/** The chat id a gateway call with files runs in: short enough for a storage key. */
export function inboundChatId(runId) {
  const base = String(runId || 'call')
    .replaceAll(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 48);
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

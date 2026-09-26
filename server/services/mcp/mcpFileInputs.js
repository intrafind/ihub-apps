/**
 * File inputs of MCP tools.
 *
 * A tool declares a parameter as a file with `format: "file"` on the property
 * (whatever its `type`, an object in the Langdock convention) or on the items
 * of an array. The model never sees that shape: the schema it is offered has
 * a string in its place — the file name of an attachment of the current
 * message, or `attachment:<n>` for the n-th one — and the reference is
 * resolved into the FileData the server expects right before `tools/call`:
 *
 *   { fileName, mimeType, base64, size }   // base64 without a data-URL prefix,
 *                                          // size in bytes
 *
 * Only top-level properties are inspected. A file input nested in an object
 * or further down an array is not supported and is sent as the model wrote it.
 *
 * Nothing in this module logs or quotes file contents; error messages carry
 * names and sizes only.
 *
 * @module services/mcp/mcpFileInputs
 */

export const FILE_INPUT_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'MCP_FILE_NOT_FOUND',
  TOO_LARGE: 'MCP_FILE_TOO_LARGE',
  UNAVAILABLE: 'MCP_FILE_UNAVAILABLE'
});

/** Per-server limit for one file handed to a tool, when the config sets none. */
export const DEFAULT_MAX_FILE_SIZE_MB = 20;

/** How the model is told to reference an attachment, appended to every file property. */
const REFERENCE_HINT =
  'Pass the exact file name of an attachment in the current message, or `attachment:<n>` ' +
  'for the n-th attachment.';

const DATA_URL_PREFIX = /^data:[^,]*;base64,/i;
const INDEX_REFERENCE = /^(?:attachment:|#)\s*(\d+)$/i;

function isFileProperty(prop) {
  return Boolean(prop) && typeof prop === 'object' && prop.format === 'file';
}

function isFileArrayProperty(prop) {
  return (
    Boolean(prop) && typeof prop === 'object' && prop.type === 'array' && isFileProperty(prop.items)
  );
}

function propertiesOf(inputSchema) {
  const props = inputSchema?.properties;
  return props && typeof props === 'object' && !Array.isArray(props) ? props : {};
}

/**
 * The file inputs a tool's input schema declares, top-level only.
 *
 * @param {Object} inputSchema - The tool's JSON schema
 * @returns {Array<{name: string, array: boolean, required: boolean}>}
 */
export function findFileInputs(inputSchema) {
  const required = new Set(Array.isArray(inputSchema?.required) ? inputSchema.required : []);
  const out = [];
  for (const [name, prop] of Object.entries(propertiesOf(inputSchema))) {
    if (isFileProperty(prop)) {
      out.push({ name, array: false, required: required.has(name) });
    } else if (isFileArrayProperty(prop)) {
      out.push({ name, array: true, required: required.has(name) });
    }
  }
  return out;
}

function referenceDescription(prop) {
  const own = typeof prop?.description === 'string' ? prop.description.trim() : '';
  return own ? `${own} ${REFERENCE_HINT}` : REFERENCE_HINT;
}

/**
 * The schema the model is offered: every file property becomes a string (or an
 * array of strings) that names an attachment; `format` is gone, `required` is
 * kept. Providers rewrite schemas downstream — Google drops `format`, the
 * OpenAI Responses API forces strict mode — so the rewrite has to happen
 * here, before any adapter sees the tool. The input is not modified.
 *
 * @param {Object} inputSchema - The tool's JSON schema
 * @returns {Object} A deep copy with the file properties rewritten
 */
export function rewriteFileInputSchema(inputSchema) {
  const schema = structuredClone(inputSchema || { type: 'object', properties: {} });
  const props = propertiesOf(schema);
  for (const [name, prop] of Object.entries(props)) {
    if (isFileProperty(prop)) {
      props[name] = { type: 'string', description: referenceDescription(prop) };
    } else if (isFileArrayProperty(prop)) {
      const items = { type: 'string', description: referenceDescription(prop.items) };
      const description =
        typeof prop.description === 'string' && prop.description.trim()
          ? { description: prop.description.trim() }
          : {};
      props[name] = { type: 'array', ...description, items };
    }
  }
  return schema;
}

/**
 * The sentence appended to a tool's description so the model knows to attach
 * the file and name it, in the style of the workflow tools' hint.
 *
 * @param {Array<{name: string}>} fileInputs
 * @returns {string}
 */
export function fileInputHint(fileInputs) {
  const names = fileInputs.map(f => `\`${f.name}\``);
  const list =
    names.length <= 1
      ? names.join('')
      : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `Attach the file to your message and pass its file name as ${list}.`;
}

/**
 * The attachments of a message as one flat list, whichever way the client sent
 * them: a single object or an array, for each of `fileData`, `imageData` and
 * `audioData`. Entries that are not objects are dropped.
 *
 * @param {...(Object|Array<Object>|null|undefined)} sources
 * @returns {Array<Object>}
 */
export function normalizeAttachments(...sources) {
  const out = [];
  for (const source of sources) {
    const list = Array.isArray(source) ? source : source ? [source] : [];
    for (const entry of list) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry);
    }
  }
  return out;
}

function attachmentName(attachment) {
  const name = attachment?.fileName || attachment?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : '';
}

function attachmentMimeType(attachment) {
  for (const candidate of [attachment?.fileType, attachment?.mimeType, attachment?.type]) {
    if (typeof candidate === 'string' && candidate.includes('/')) return candidate;
  }
  return 'application/octet-stream';
}

function fileError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** `1.2 MB`, `340 KB`, `12 B` — for notes and error messages. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The bytes an attachment would hand to a tool, without decoding them:
 * `fileSize`/`size` when the client sent one, else the decoded length of the
 * base64 (or of the text that stands in for it).
 *
 * @param {Object} attachment
 * @returns {number|null}
 */
function attachmentBytes(attachment) {
  const declared = Number(attachment?.fileSize ?? attachment?.size);
  if (Number.isFinite(declared) && declared >= 0) return declared;
  if (typeof attachment?.base64 === 'string') {
    return Buffer.byteLength(attachment.base64.replace(DATA_URL_PREFIX, ''), 'base64');
  }
  if (typeof attachment?.content === 'string') return Buffer.byteLength(attachment.content, 'utf8');
  return null;
}

/**
 * One line per attachment, numbered the way `attachment:<n>` counts them:
 * `attachment:1 — report.pdf (application/pdf, 1.2 MB)`.
 *
 * @param {Array<Object>} attachments - As returned by `normalizeAttachments`
 * @returns {Array<string>}
 */
export function describeAttachments(attachments) {
  return normalizeAttachments(attachments).map((attachment, i) => {
    const name = attachmentName(attachment) || '(unnamed)';
    const bytes = attachmentBytes(attachment);
    const size = bytes == null ? '' : `, ${formatBytes(bytes)}`;
    return `attachment:${i + 1} — ${name} (${attachmentMimeType(attachment)}${size})`;
  });
}

/**
 * The FileData an MCP server receives for one attachment.
 *
 * Images, audio and video carry their bytes as a data URL; the prefix is
 * stripped. A document carries its bytes only when the client sent them; a
 * text document without them is delivered as the base64 of its extracted
 * text, under its own media type. Anything else has no bytes to give.
 *
 * `size` is the byte length of what is delivered: a resized image or the
 * extracted text can differ from the file the user picked.
 *
 * @param {Object} attachment - One chat attachment
 * @returns {{fileName: string, mimeType: string, base64: string, size: number}}
 * @throws {Error} `code: 'MCP_FILE_UNAVAILABLE'` when the bytes are not available
 */
export function toFileData(attachment) {
  const fileName = attachmentName(attachment) || 'attachment';
  const mimeType = attachmentMimeType(attachment);

  let base64 = null;
  if (typeof attachment?.base64 === 'string' && attachment.base64.length > 0) {
    base64 = attachment.base64.replace(DATA_URL_PREFIX, '');
  } else if (mimeType.startsWith('text/') && typeof attachment?.content === 'string') {
    base64 = Buffer.from(attachment.content, 'utf8').toString('base64');
  }
  if (base64 == null) {
    throw fileError(
      FILE_INPUT_ERROR_CODES.UNAVAILABLE,
      `The contents of "${fileName}" are not available to tools. Re-attach the file from the chat UI.`
    );
  }

  return { fileName, mimeType, base64, size: Buffer.byteLength(base64, 'base64') };
}

function matchAttachment(reference, attachments) {
  if (typeof reference !== 'string') return null;
  const ref = reference.trim();
  if (!ref) return null;

  const indexed = INDEX_REFERENCE.exec(ref);
  if (indexed) {
    const index = Number(indexed[1]);
    return index >= 1 && index <= attachments.length ? attachments[index - 1] : null;
  }

  const wanted = ref.toLowerCase();
  return attachments.find(a => attachmentName(a).toLowerCase() === wanted) || null;
}

function availableList(attachments) {
  const lines = describeAttachments(attachments);
  return lines.length ? lines.join('; ') : 'none';
}

function resolveOne(reference, { name, attachments, maxBytes }) {
  const attachment = matchAttachment(reference, attachments);
  if (!attachment) {
    const shown = typeof reference === 'string' ? reference : JSON.stringify(reference);
    throw fileError(
      FILE_INPUT_ERROR_CODES.NOT_FOUND,
      `No attachment "${shown}" for parameter "${name}" in the current message. ` +
        `Available attachments: ${availableList(attachments)}.`
    );
  }
  const file = toFileData(attachment);
  if (Number.isFinite(maxBytes) && file.size > maxBytes) {
    throw fileError(
      FILE_INPUT_ERROR_CODES.TOO_LARGE,
      `"${file.fileName}" is ${formatBytes(file.size)}; this server accepts files up to ` +
        `${formatBytes(maxBytes)} per file input.`
    );
  }
  return file;
}

/**
 * The tool's arguments with every file reference replaced by FileData.
 *
 * References resolve only against the attachments given — the current
 * message of the calling user; a stored chat holds descriptors, not bytes. A
 * parameter the model left out or set to null is left as it is.
 *
 * @param {Object} args - Arguments as the model wrote them
 * @param {Array<{name: string, array: boolean}>} fileInputs - From `findFileInputs`
 * @param {Object|Array<Object>} attachments - The message's attachments
 * @param {Object} [options]
 * @param {number} [options.maxBytes] - Largest file to hand over, in bytes
 * @param {string} [options.serverId] - Reported on the error for the caller's logs
 * @returns {Object} A new arguments object
 * @throws {Error} `code` is one of `FILE_INPUT_ERROR_CODES`
 */
export function resolveFileInputs(args, fileInputs, attachments, { maxBytes, serverId } = {}) {
  const list = normalizeAttachments(attachments);
  const out = { ...(args || {}) };
  try {
    for (const { name, array } of fileInputs || []) {
      if (!Object.hasOwn(out, name) || out[name] == null) continue;
      const value = out[name];
      if (array) {
        const refs = Array.isArray(value) ? value : [value];
        out[name] = refs.map(ref => resolveOne(ref, { name, attachments: list, maxBytes }));
      } else {
        out[name] = resolveOne(value, { name, attachments: list, maxBytes });
      }
    }
  } catch (err) {
    if (serverId && err && typeof err === 'object') err.serverId = serverId;
    throw err;
  }
  return out;
}

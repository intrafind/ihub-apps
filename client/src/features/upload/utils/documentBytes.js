/**
 * When an uploaded document carries its own bytes.
 *
 * A document normally reaches the server as its extracted text (and the page
 * images of an image-only PDF). Its raw bytes — a `base64` data URL on the
 * document entry — are needed only by a tool that takes a file: an MCP tool
 * with a `format: "file"` parameter ("file inputs"). The bytes grow the chat
 * request by about 1.37x the file size, so they are attached only when
 *
 *   1. the app offers at least one tool with file inputs, and
 *   2. all documents' bytes of one message stay within a budget well below
 *      the server's JSON body limit (`requestBodyLimitMB`).
 *
 * A document that does not fit travels as text only — the upload never fails
 * because of the bytes. Images and audio are not affected: they always carried
 * their base64 and still do.
 *
 * Everything here is pure; the React side lives in
 * `features/chat/hooks/useDocumentBytesPolicy.js`.
 *
 * @module features/upload/utils/documentBytes
 */

/** The server's JSON body limit when the platform config does not name one. */
export const DEFAULT_REQUEST_BODY_LIMIT_MB = 50;

/**
 * Share of the body limit the documents' bytes of one message may use. The
 * rest is left for the extracted text, images, the history and the envelope.
 * With the default limit of 50 MB this is 30 MB of base64.
 */
export const DOCUMENT_BYTES_BODY_SHARE = 0.6;

const BYTES_PER_MB = 1024 * 1024;

/**
 * The budget, in base64 characters (= bytes of the JSON body), for the bytes
 * of all documents of one message.
 *
 * @param {number|string|undefined|null} requestBodyLimitMB - `platformConfig.requestBodyLimitMB`
 * @returns {number} Characters of base64 the documents of one message may carry
 * @example
 *   getDocumentBytesBudget(50); // 31457280 (30 MB)
 */
export function getDocumentBytesBudget(requestBodyLimitMB) {
  const parsed = Number.parseInt(requestBodyLimitMB, 10);
  const limitMb = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_BODY_LIMIT_MB;
  return Math.floor(limitMb * BYTES_PER_MB * DOCUMENT_BYTES_BODY_SHARE);
}

/**
 * The length of a file's base64 data URL, without reading the file.
 *
 * @param {number} fileSize - File size in bytes
 * @param {string} [mimeType] - The file's MIME type (part of the data-URL prefix)
 * @returns {number} Characters of the data URL `data:<mime>;base64,<payload>`
 */
export function estimateDataUrlLength(fileSize, mimeType = '') {
  const payload = Math.ceil(Math.max(0, fileSize || 0) / 3) * 4;
  return `data:${mimeType || 'application/octet-stream'};base64,`.length + payload;
}

/**
 * Whether an attachment entry is a document (the side that only gained bytes
 * for file inputs). Images and audio are media and keep their base64.
 *
 * @param {Object} entry - Attachment entry from the uploader
 * @returns {boolean}
 */
function isDocumentEntry(entry) {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    entry.type !== 'image' &&
    entry.type !== 'audio'
  );
}

function withoutBase64(entry) {
  const { base64: _base64, ...rest } = entry;
  return rest;
}

/**
 * Whether the app offers at least one tool with file inputs.
 *
 * A tool is part of the app when `app.tools` names it, its MCP server
 * (`_mcp.serverId`) or its function-style base id — the same rules the server
 * applies (`server/utils/toolSelection.js`). With `enabledTools` given (an
 * array), the tool must also be enabled for the turn, exactly as the server
 * filters the tools it offers the model. File inputs are advertised by
 * `/api/tools` as `_mcp.fileInputs`.
 *
 * @param {string[]|undefined} appToolRefs - `app.tools`
 * @param {Array<Object>|undefined} availableTools - `/api/tools?appId=…`
 * @param {string[]|null} [enabledTools] - The turn's enabled tools; `null`/`undefined` means "all of the app's"
 * @returns {boolean}
 * @example
 *   offersFileInputTool(['files'], [{ id: 'files__inspect', _mcp: { serverId: 'files', fileInputs: [{ name: 'doc' }] } }]);
 *   // → true
 */
export function offersFileInputTool(appToolRefs, availableTools, enabledTools) {
  if (!Array.isArray(appToolRefs) || appToolRefs.length === 0) return false;
  if (!Array.isArray(availableTools) || availableTools.length === 0) return false;
  const selectedBy = (tool, refs) => {
    if (refs.includes(tool.id)) return true;
    if (tool._mcp?.serverId && refs.includes(tool._mcp.serverId)) return true;
    const baseId =
      typeof tool.id === 'string' && tool.id.includes('_') ? tool.id.split('_')[0] : '';
    return Boolean(baseId) && refs.includes(baseId);
  };
  return availableTools.some(
    tool =>
      Boolean(tool?.id) &&
      Array.isArray(tool._mcp?.fileInputs) &&
      tool._mcp.fileInputs.length > 0 &&
      selectedBy(tool, appToolRefs) &&
      (!Array.isArray(enabledTools) || selectedBy(tool, enabledTools))
  );
}

/**
 * The attachments with the bytes of their documents kept only while they fit
 * the budget, in order: earlier documents keep theirs, a document whose bytes
 * would exceed what is left travels as text only. Accepts the uploader's
 * single entry or array and returns the same shape; returns the input itself
 * when nothing changes.
 *
 * @param {Object|Array<Object>|null|undefined} fileData - Uploader selection or `fileData` of a message
 * @param {number} budget - Characters of base64 all documents may carry together
 * @returns {Object|Array<Object>|null|undefined}
 */
export function capDocumentBytes(fileData, budget) {
  const list = Array.isArray(fileData) ? fileData : fileData ? [fileData] : [];
  let remaining = Math.max(0, Number.isFinite(budget) ? budget : 0);
  let changed = false;
  const capped = list.map(entry => {
    if (!isDocumentEntry(entry) || typeof entry.base64 !== 'string') return entry;
    if (entry.base64.length <= remaining) {
      remaining -= entry.base64.length;
      return entry;
    }
    changed = true;
    return withoutBase64(entry);
  });
  if (!changed) return fileData;
  return Array.isArray(fileData) ? capped : capped[0];
}

/**
 * The attachments as they should be sent: without any document bytes when no
 * tool can take a file, otherwise capped to the budget.
 *
 * @param {Object|Array<Object>|null|undefined} fileData - Uploader selection or `fileData` of a message
 * @param {Object} policy
 * @param {boolean} policy.attachBytes - Whether a tool with file inputs is offered
 * @param {number} policy.budget - Characters of base64 all documents may carry together
 * @returns {Object|Array<Object>|null|undefined}
 */
export function applyDocumentBytesPolicy(fileData, { attachBytes, budget }) {
  return capDocumentBytes(fileData, attachBytes ? budget : 0);
}

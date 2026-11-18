// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import JSZip from 'jszip';
import { parseStructured } from './documentToolHelpers.js';
import { parseJsonArgument } from './jsonArgument.js';
import { chatArtifactCandidates, selectChatFiles } from './files/fileTools.js';
import { GeneratedFileError } from './generatedFiles.js';

/**
 * What the edit tools of the document skills share: the source a generated
 * file was made from, and exact text replacements on it.
 *
 * A Word, PowerPoint or Excel file the model creates is rendered from the
 * tool's own arguments (the Markdown of `create_docx`, the slides of
 * `create_pptx`, the sheets of `create_xlsx`). Those arguments are embedded
 * in the file as a Custom XML Data part (`customXml/ihubSource.xml`, related
 * to the main part like any custom XML Office keeps), so an `edit_*` tool can
 * change them and render the file again instead of the model writing it all
 * once more. The source travels with the file: a stored artifact, a file still
 * held from this turn and a download carry the same part. It holds nothing
 * the document does not show already, besides ids of uploads it was based on.
 *
 * @module services/documents/editableSource
 */

/** Path of the source part inside an Office package. */
export const SOURCE_PART = 'customXml/ihubSource.xml';

/** Namespace of the source part's root element. */
export const SOURCE_NAMESPACE = 'urn:intrafind:ihub:document-source';

/** Revision of the stored source format. */
const SOURCE_VERSION = 1;

/** Largest source, as JSON characters, that is embedded; a larger file is not editable. */
export const MAX_SOURCE_CHARS = 4 * 1024 * 1024;

/** Most replacements one edit call may carry. */
export const MAX_TEXT_EDITS = 50;

/** The main part each format relates the source part to. */
const MAIN_PARTS = Object.freeze({
  docx: 'word/document.xml',
  pptx: 'ppt/presentation.xml',
  xlsx: 'xl/workbook.xml'
});

const CUSTOM_XML_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const RELATIONSHIP_ID = 'rIdIhubSource';

/** The relationships part of a part: `word/document.xml` → `word/_rels/document.xml.rels`. */
function relsPathOf(part) {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

/** Make sure `[Content_Types].xml` gives the part an XML type. */
function withXmlContentType(types) {
  if (/<Default\b[^>]*\bExtension="xml"/i.test(types)) return types;
  if (types.includes(`PartName="/${SOURCE_PART}"`)) return types;
  return types.replace(
    '</Types>',
    `<Override PartName="/${SOURCE_PART}" ContentType="application/xml"/></Types>`
  );
}

/**
 * The tool arguments worth keeping: those the tool definition declares (and
 * `template`, which the template choice adds), never the trusted context the
 * server adds to a call (`user`, `chatId`, `appConfig`).
 *
 * @param {Object} params - The call's parameters.
 * @param {{ parameters: { properties: Object } }} definition - The tool definition.
 * @returns {Object}
 */
export function toolArgsOf(params, definition) {
  const keys = [...Object.keys(definition.parameters.properties), 'template'];
  const args = {};
  for (const key of keys) {
    if (params[key] !== undefined && params[key] !== null) args[key] = params[key];
  }
  return args;
}

/**
 * Put the source of a generated file into the file. A file whose package
 * cannot take it, or whose source is too large, is returned as it was: it is
 * then simply not editable.
 *
 * @param {Buffer} buffer - The rendered `.docx`, `.pptx` or `.xlsx`.
 * @param {'docx'|'pptx'|'xlsx'} format
 * @param {{ tool: string, args: Object }} source - The creating tool and its arguments.
 * @returns {Promise<Buffer>}
 */
export async function embedSource(buffer, format, { tool, args }) {
  const json = JSON.stringify({ version: SOURCE_VERSION, tool, args });
  if (json.length > MAX_SOURCE_CHARS) return buffer;
  const mainPart = MAIN_PARTS[format];
  try {
    const zip = await JSZip.loadAsync(buffer);
    const relsPath = relsPathOf(mainPart);
    const rels = await zip.file(relsPath)?.async('string');
    const types = await zip.file('[Content_Types].xml')?.async('string');
    if (!zip.file(mainPart) || !rels || !types) return buffer;
    const payload = Buffer.from(json, 'utf8').toString('base64');
    zip.file(
      SOURCE_PART,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<source xmlns="${SOURCE_NAMESPACE}" version="${SOURCE_VERSION}" encoding="base64-json">${payload}</source>`
    );
    if (!rels.includes(`Id="${RELATIONSHIP_ID}"`)) {
      zip.file(
        relsPath,
        rels.replace(
          '</Relationships>',
          `<Relationship Id="${RELATIONSHIP_ID}" Type="${CUSTOM_XML_REL}" Target="../${SOURCE_PART}"/></Relationships>`
        )
      );
    }
    zip.file('[Content_Types].xml', withXmlContentType(types));
    return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch {
    return buffer;
  }
}

/**
 * The source embedded in a generated file, or null when it has none (a file
 * made before sources were kept, one the user uploaded, one changed elsewhere
 * and saved without the part).
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ tool: string, args: Object }|null>}
 */
export async function readSource(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file(SOURCE_PART)?.async('string');
    if (!xml?.includes(SOURCE_NAMESPACE)) return null;
    const payload = /<source\b[^>]*>([A-Za-z0-9+/=\s]*)<\/source>/.exec(xml)?.[1];
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (typeof parsed?.tool !== 'string' || !parsed.args || typeof parsed.args !== 'object') {
      return null;
    }
    return { tool: parsed.tool, args: parsed.args };
  } catch {
    return null;
  }
}

/**
 * The newest version of a file of this chat, for an edit: found by name or
 * id among the files this turn generated and the chat's stored artifacts.
 *
 * @param {Object} params - The call's parameters (`filename`, `user`, `chatId`).
 * @returns {Promise<{ name: string, data: Buffer }>}
 * @throws {GeneratedFileError} when the name is missing or nothing matches.
 */
export async function chatFileToEdit(params) {
  const wanted = typeof params.filename === 'string' ? params.filename.trim().slice(0, 200) : '';
  if (!wanted) {
    throw new GeneratedFileError(
      'Name the file to change in "filename" (its name or id in this chat).',
      'invalid'
    );
  }
  const candidates = await chatArtifactCandidates({
    user: params.user,
    chatId: params.chatId,
    intent: 'read'
  });
  const [target] = selectChatFiles(candidates, [wanted], false);
  const data = await target.load();
  if (!data) {
    throw new GeneratedFileError(`The file "${target.name}" is no longer stored.`, 'not-found');
  }
  return { name: target.name, data };
}

/**
 * The source of a chat file made by `tool`, for its edit tool.
 *
 * @param {Object} params - The call's parameters.
 * @param {Object} options
 * @param {string} options.tool - The creating tool (`create_docx`).
 * @param {RegExp} options.extension - The file names the tool makes (`/\.docx$/i`).
 * @param {string} options.what - The kind of file, for messages ("Word document").
 * @returns {Promise<{ name: string, args: Object }>}
 */
export async function editableSourceOf(params, { tool, extension, what }) {
  const { name, data } = await chatFileToEdit(params);
  if (!extension.test(name)) {
    throw new GeneratedFileError(
      `"${name}" is not a ${what}. This tool changes only files ${tool} made.`,
      'invalid'
    );
  }
  const source = await readSource(data);
  if (source?.tool !== tool) {
    throw new GeneratedFileError(
      `"${name}" carries no editable source (it was made before edits were possible, built on an uploaded file, uploaded itself, or saved elsewhere). Create it again with ${tool}; later changes can then be edits.`,
      'not-editable'
    );
  }
  return { name, args: source.args };
}

// ── text replacements ───────────────────────────────────────────────────────

/** Where `needle` occurs in `text`, at most `limit` times. */
function occurrencesOf(text, needle, limit = 3) {
  const found = [];
  let from = 0;
  while (found.length < limit) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + needle.length;
  }
  return found;
}

/**
 * The replacements of an edit call, checked.
 *
 * @param {unknown} value - `edits`, as a list or its JSON.
 * @param {Object} [options]
 * @param {boolean} [options.required=true] - Whether at least one edit must be given.
 * @param {string} [options.rewriteHint] - What to do instead of more edits than allowed.
 * @returns {Array<{oldText: string, newText: string}>}
 */
export function textEditsOf(
  value,
  { required = true, rewriteHint = 'create the file again' } = {}
) {
  const edits = parseStructured(value, 'edits', 'a list of { oldText, newText }');
  if (edits === undefined && !required) return [];
  if (!Array.isArray(edits) || (required && edits.length === 0)) {
    throw new GeneratedFileError(
      '"edits" must be a non-empty list of { oldText, newText }.',
      'invalid'
    );
  }
  if (edits.length > MAX_TEXT_EDITS) {
    throw new GeneratedFileError(
      `One call can carry at most ${MAX_TEXT_EDITS} edits. For a larger change, ${rewriteHint}.`,
      'invalid'
    );
  }
  return edits.map((edit, index) => {
    const oldText = edit?.oldText;
    const newText = edit?.newText ?? '';
    if (typeof oldText !== 'string' || oldText === '' || typeof newText !== 'string') {
      throw new GeneratedFileError(
        `edits[${index}] needs "oldText" (the exact text to replace, not empty) and "newText" (its replacement; "" deletes it).`,
        'invalid'
      );
    }
    return { oldText, newText };
  });
}

/** The refusal for an `oldText` that is not there. */
function notFound(index, readHint) {
  return new GeneratedFileError(
    `edits[${index}].oldText does not occur in the current file${index ? ' (after the edits before it)' : ''}. Copy it exactly from the file, whitespace and quotes included; if you do not have the current text, ${readHint}. No edit was applied.`,
    'invalid'
  );
}

/** The refusal for an `oldText` that is there more than once. */
function notUnique(index, count) {
  return new GeneratedFileError(
    `edits[${index}].oldText occurs ${count >= 3 ? '3 or more' : count} times. Include enough surrounding text to make it unique. No edit was applied.`,
    'invalid'
  );
}

const DEFAULT_READ_HINT = 'read it with chat_artifacts_read';

/**
 * Apply exact replacements to a text, all or none. Each `oldText` must occur
 * exactly once in the text as the edits before it left it, so a replacement
 * never lands in the wrong place.
 *
 * @param {string} text
 * @param {Array<{oldText: string, newText: string}>} edits
 * @param {Object} [options]
 * @param {string} [options.readHint] - How the model gets the current text.
 * @returns {string}
 * @throws {GeneratedFileError} naming the first edit that does not apply.
 */
export function applyTextEdits(text, edits, { readHint = DEFAULT_READ_HINT } = {}) {
  let result = text;
  edits.forEach(({ oldText, newText }, index) => {
    const found = occurrencesOf(result, oldText);
    if (found.length === 0) throw notFound(index, readHint);
    if (found.length > 1) throw notUnique(index, found.length);
    result = result.slice(0, found[0]) + newText + result.slice(found[0] + oldText.length);
  });
  return result;
}

/** How often `needle` occurs in the strings of a JSON value (counting up to 3 per string). */
function countInStrings(node, needle) {
  if (typeof node === 'string') return occurrencesOf(node, needle).length;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countInStrings(item, needle), 0);
  if (node && typeof node === 'object') {
    return Object.values(node).reduce((sum, item) => sum + countInStrings(item, needle), 0);
  }
  return 0;
}

/** A copy of a JSON value with `oldText` replaced in every string that holds it. */
function replaceInStrings(node, oldText, newText) {
  if (typeof node === 'string') {
    return node.includes(oldText) ? node.replace(oldText, () => newText) : node;
  }
  if (Array.isArray(node)) return node.map(item => replaceInStrings(item, oldText, newText));
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, item]) => [key, replaceInStrings(item, oldText, newText)])
    );
  }
  return node;
}

/**
 * Apply exact replacements to the texts inside a structure (the strings of
 * slides, of table cells), all or none. Each `oldText` must occur exactly once
 * across all of them.
 *
 * @param {unknown} value - Any JSON value; it is not changed.
 * @param {Array<{oldText: string, newText: string}>} edits
 * @param {Object} [options]
 * @param {string} [options.readHint]
 * @returns {unknown} A changed copy.
 */
export function applyTextEditsToStrings(value, edits, { readHint = DEFAULT_READ_HINT } = {}) {
  let result = value;
  edits.forEach(({ oldText, newText }, index) => {
    const count = countInStrings(result, oldText);
    if (count === 0) throw notFound(index, readHint);
    if (count > 1) throw notUnique(index, count);
    result = replaceInStrings(result, oldText, newText);
  });
  return result;
}

/**
 * Change top-level settings of a source (`title`, `footer`, `toc`, …): only
 * the keys `allowed` names, so an edit cannot swap the content field or smuggle
 * in a parameter the tool does not have.
 *
 * @param {Object} args - The stored arguments; not changed.
 * @param {unknown} set - `set`, as an object or its JSON.
 * @param {string[]} allowed
 * @returns {Object} The changed copy.
 */
export function applySettings(args, set, allowed) {
  const changes = parseStructured(set, 'set', 'an object of settings');
  if (changes === undefined) return { ...args };
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new GeneratedFileError('"set" must be an object of settings.', 'invalid');
  }
  const unknown = Object.keys(changes).filter(key => !allowed.includes(key));
  if (unknown.length) {
    const named = unknown.map(key => JSON.stringify(key)).join(', ');
    throw new GeneratedFileError(
      `"set" cannot change ${named}. It can change: ${allowed.join(', ')}.`,
      'invalid'
    );
  }
  const next = { ...args };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** Per creating tool: the argument that holds its content, how it is shown, and its edit tool. */
const SOURCE_VIEWS = Object.freeze({
  create_docx: { field: 'markdown', format: 'markdown', editTool: 'edit_docx' },
  create_pptx: { field: 'slides', format: 'json', editTool: 'edit_pptx' },
  create_xlsx: { field: 'sheets', format: 'json', editTool: 'edit_xlsx' }
});

/**
 * The content of a source as the model reads it: the Markdown of a Word
 * document, the slides or sheets of a deck or workbook as indented JSON (the
 * text an edit's `oldText` is copied from).
 *
 * @param {{ tool: string, args: Object }} source
 * @returns {{ text: string, format: 'markdown'|'json', editTool: string }|null}
 */
export function sourceViewOf(source) {
  const view = SOURCE_VIEWS[source?.tool];
  if (!view) return null;
  const value = source.args[view.field];
  let text;
  if (typeof value === 'string' && view.format === 'markdown') text = value;
  else {
    // The arguments as the model sent them: JSON it left brackets open in
    // was closed when the file was made, so it is read the same way here.
    const parsed = typeof value === 'string' ? parseJsonArgument(value).value : value;
    text = JSON.stringify(parsed ?? null, null, 2);
  }
  return { text, format: view.format, editTool: view.editTool };
}

/**
 * The result of an edit: the creating tool's result, worded as an update.
 *
 * @param {Object} result - What the create function returned.
 * @param {number} edited - How many changes the call carried.
 * @returns {Object}
 */
export function editResultOf(result, edited) {
  if (!result?.success) return result;
  return {
    ...result,
    edited,
    message: String(result.message || '').replace(/^Created /, 'Updated ')
  };
}

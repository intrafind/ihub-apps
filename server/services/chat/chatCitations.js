/**
 * The documents behind a chat answer, as the chat stores them with it, so that
 * reopening the chat draws the same Documents panel.
 *
 * Two producers fill that panel, and both speak the one shape it reads —
 * `{ references, resultItems }`, passages and documents: an iAssistant
 * conversation streams them (`adapters/iassistant-conversation.js`), and the
 * turn's iFinder tool calls yield them (`integrations/iFinderCitations.js`).
 * Each producer sends a sequence of payloads during the turn, and a later
 * payload's field replaces the earlier one — the iFinder frames carry the
 * turn's whole list every time. {@link mergeCitations} folds them the way the
 * client does (`features/chat/runToMessage.mergeCitationEntries`), so the
 * stored panel is the one the user saw live.
 *
 * What is stored is only what the panel reads. The payloads come from iFinder
 * and can carry any metadata the index holds; a chat document is rewritten on
 * every message and read back whole when the chat opens, so arbitrary
 * upstream fields have no place in it.
 *
 * @module services/chat/chatCitations
 */
import { jsonByteLength } from '../mcp/mcpApps.js';

/** Most documents stored with one answer (the iFinder collector's own cap). */
export const MAX_STORED_RESULT_ITEMS = 50;

/** Most passages stored with one answer. */
export const MAX_STORED_REFERENCES = 100;

/** Stored size of one answer's citations; past it, passages go first, then documents. */
export const MAX_STORED_CITATIONS_BYTES = 256 * 1024;

const MAX_PASSAGE_CHARS = 4000;
const MAX_VALUE_CHARS = 2048;
const MAX_VALUES = 5;

/** The `additional_document_metadata` keys the panel reads (`citationDocuments.js`). */
const METADATA_KEYS = [
  'id',
  'title',
  'accessInfo.deepLink',
  'file.name',
  'sourceType',
  'sourceName',
  'application'
];

/**
 * Fold a turn's citation payloads into the one the answer ends with.
 *
 * @param {Array<{references?: Array, resultItems?: Array}>} entries - in the order they arrived
 * @returns {{references: Array, resultItems: Array}|null} null when no payload lists anything
 */
export function mergeCitations(entries) {
  if (!Array.isArray(entries)) return null;
  let references = [];
  let resultItems = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.references)) references = entry.references;
    if (Array.isArray(entry.resultItems)) resultItems = entry.resultItems;
  }
  return references.length || resultItems.length ? { references, resultItems } : null;
}

function text(value, max = MAX_VALUE_CHARS) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

/** A metadata value as iFinder sends it: a string, or a list of strings. */
function metadataValue(value) {
  if (Array.isArray(value)) {
    const values = value
      .map(entry => text(entry))
      .filter(Boolean)
      .slice(0, MAX_VALUES);
    return values.length ? values : null;
  }
  return text(value);
}

function documentId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value, 1024);
}

/**
 * The fields of one document or passage the panel needs to draw its tile and
 * act on it, or null when it carries no id (the panel lists none of those).
 */
function storedDocument(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const metadata = {};
  const source = item.additional_document_metadata;
  if (source && typeof source === 'object') {
    for (const key of METADATA_KEYS) {
      const value = metadataValue(source[key]);
      if (value) metadata[key] = value;
    }
  }
  const id = documentId(item.document_id);
  if (!id && !metadata.id) return null;

  const stored = {};
  if (id) stored.document_id = id;
  const title = text(item.title);
  if (title) stored.title = title;
  if (Object.keys(metadata).length) stored.additional_document_metadata = metadata;
  // Only the ACCESS link: it is what preview, download and "Add to email"
  // fetch the document through, with the reader's own iFinder permissions.
  const access = Array.isArray(item.links)
    ? item.links.find(link => link?.type === 'ACCESS' && documentId(link.documentId))
    : null;
  if (access) {
    const searchProfile = text(access.searchProfile, 256);
    stored.links = [
      {
        type: 'ACCESS',
        documentId: documentId(access.documentId),
        ...(searchProfile ? { searchProfile } : {})
      }
    ];
  }
  return stored;
}

function storedReference(reference) {
  const stored = storedDocument(reference);
  if (!stored) return null;
  const content = text(reference.content, MAX_PASSAGE_CHARS);
  if (content) stored.content = content;
  if (Number.isFinite(reference.index)) stored.index = reference.index;
  return stored;
}

/**
 * The citations to store with an answer: only the fields the panel reads,
 * within {@link MAX_STORED_CITATIONS_BYTES}.
 *
 * @param {{references?: Array, resultItems?: Array}|null} citations - merged citations
 * @returns {{references: Array, resultItems: Array}|null} null when nothing is left to store
 */
export function boundStoredCitations(citations) {
  if (!citations || typeof citations !== 'object') return null;
  const references = (Array.isArray(citations.references) ? citations.references : [])
    .map(storedReference)
    .filter(Boolean)
    .slice(0, MAX_STORED_REFERENCES);
  const resultItems = (Array.isArray(citations.resultItems) ? citations.resultItems : [])
    .map(storedDocument)
    .filter(Boolean)
    .slice(0, MAX_STORED_RESULT_ITEMS);

  const stored = { references, resultItems };
  while (
    (references.length || resultItems.length) &&
    jsonByteLength(stored) > MAX_STORED_CITATIONS_BYTES
  ) {
    if (references.length) references.pop();
    else resultItems.pop();
  }
  return references.length || resultItems.length ? stored : null;
}

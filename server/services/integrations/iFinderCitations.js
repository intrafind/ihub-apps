/**
 * The iFinder documents a chat turn's tool calls found, as the citation
 * result items the chat's Documents panel renders.
 *
 * The iAssistant conversation adapter streams its documents in this shape —
 * `document_id`, `title`, `additional_document_metadata` and an `ACCESS` link
 * naming the search profile — and the panel builds every per-document action
 * on it: preview, download, "Add to email" in the Outlook task pane, details
 * and "Open in App". An answer researched with the iFinder tools produced no
 * such items, so a document it found could only be opened by the link in the
 * answer text (issue #2597).
 *
 * Read from the full tool result, never from the preview the client sees:
 *   - `iFinder_search`      `{ searchProfile, results: [hit, …] }`
 *   - `iFinder_getMetadata` a single hit carrying `searchProfile`
 *   - `iFinder_getContent`  `{ searchProfile, documentId, metadata: { title, filename, url } }`
 *
 * @module services/integrations/iFinderCitations
 */

/** Most documents one turn lists; a search returns at most 100 hits, usually 10. */
export const MAX_CITATION_DOCUMENTS = 50;

const MAX_TEXT_CHARS = 300;

const DOCUMENT_TOOLS = new Set(['ifinder_search', 'ifinder_getmetadata', 'ifinder_getcontent']);

/**
 * @param {string} toolId
 * @returns {boolean} whether the tool's result describes iFinder documents
 */
export function isIFinderDocumentTool(toolId) {
  return DOCUMENT_TOOLS.has(String(toolId || '').toLowerCase());
}

/** A trimmed string, or the first one of an array (iFinder returns most fields as arrays). */
function textOf(value, max = MAX_TEXT_CHARS) {
  const candidate = Array.isArray(value)
    ? value.find(entry => typeof entry === 'string' && entry.trim())
    : value;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, max) : null;
}

function documentIdOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value && value.length <= 1024 ? value : null;
}

/**
 * Only http(s) links, since the panel opens this one in the user's browser.
 * Kept as written rather than normalized: the panel also looks for it in the
 * answer, which quotes the link the way the tool returned it.
 */
function httpUrl(value) {
  const text = textOf(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

function parse(result) {
  if (typeof result !== 'string') return result;
  const text = result.trim();
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One document as a citation result item.
 *
 * @param {Object} doc - an iFinder hit, or the metadata of a read document
 * @param {string|null} searchProfile - the profile the document was found in
 * @returns {Object|null} null when the document carries no id
 */
function toCitationItem(doc, searchProfile) {
  const id = documentIdOf(doc.id ?? doc.documentId);
  if (!id) return null;
  const title = textOf(doc.title);
  const metadata = {
    id,
    title,
    // A hit's `url` is often the document's own location (`file://`,
    // `smb://`); the deep link is what opens it in a browser.
    'accessInfo.deepLink': httpUrl(doc.deepLink ?? doc.accessInfo?.deepLink) || httpUrl(doc.url),
    'file.name': textOf(doc.filename ?? doc.file?.name),
    sourceType: textOf(doc.sourceType),
    sourceName: textOf(doc.sourceName),
    application: textOf(doc.application)
  };
  return {
    document_id: id,
    ...(title ? { title } : {}),
    additional_document_metadata: Object.fromEntries(
      Object.entries(metadata).filter(([, value]) => value)
    ),
    links: [{ type: 'ACCESS', documentId: id, ...(searchProfile ? { searchProfile } : {}) }]
  };
}

/**
 * @param {string} toolId - the tool that produced the result
 * @param {unknown} result - the tool's raw result (object or JSON text)
 * @returns {Array<Object>} citation result items in result order; empty for
 *   any other tool, a failed call or a result that lists no document
 */
export function extractIFinderCitationItems(toolId, result) {
  if (!isIFinderDocumentTool(toolId)) return [];
  const parsed = parse(result);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error) return [];

  const searchProfile = textOf(parsed.searchProfile, 256);
  const tool = String(toolId).toLowerCase();
  let documents;
  if (tool === 'ifinder_search') {
    documents = Array.isArray(parsed.results) ? parsed.results : [];
  } else if (tool === 'ifinder_getcontent') {
    documents = [{ ...(parsed.metadata || {}), documentId: parsed.documentId }];
  } else {
    documents = [parsed];
  }

  return documents
    .filter(doc => doc && typeof doc === 'object' && !Array.isArray(doc))
    .map(doc => toCitationItem(doc, searchProfile))
    .filter(Boolean);
}

/**
 * The documents of one turn, deduplicated by id in the order they were first
 * found. A document seen again (the search hit a later read fetched) only
 * fills in what the earlier sighting lacked.
 *
 * @returns {{ add: (toolId: string, result: unknown) => boolean, items: () => Array<Object> }}
 *   `add` reports whether the list changed.
 */
export function createIFinderCitationCollector() {
  const byId = new Map();
  return {
    add(toolId, result) {
      let changed = false;
      for (const item of extractIFinderCitationItems(toolId, result)) {
        const known = byId.get(item.document_id);
        if (!known) {
          if (byId.size >= MAX_CITATION_DOCUMENTS) break;
          byId.set(item.document_id, item);
          changed = true;
          continue;
        }
        const metadata = {
          ...item.additional_document_metadata,
          ...known.additional_document_metadata
        };
        const title = known.title || item.title;
        const hasProfile = known.links[0].searchProfile || !item.links[0].searchProfile;
        const merged = {
          ...known,
          ...(title ? { title } : {}),
          additional_document_metadata: metadata,
          links: hasProfile ? known.links : item.links
        };
        if (JSON.stringify(merged) !== JSON.stringify(known)) {
          byId.set(item.document_id, merged);
          changed = true;
        }
      }
      return changed;
    },
    items() {
      return [...byId.values()];
    }
  };
}

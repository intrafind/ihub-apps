/**
 * Source producer for the iFinder tools, and the conversion of iFinder
 * documents as the iAssistant conversation API sends them.
 *
 * Both report iFinder documents: `provider: 'ifinder'`, `kind: 'document'`,
 * with a `ref` of document id and search profile. The ref is what the
 * `ifinder` source provider (`providers/ifinder.js`) previews, downloads,
 * attaches and describes a document through, with the reader's own iFinder
 * permissions — so every document is private and a share never carries it.
 *
 * Tool results, read from the full result, never from the preview:
 *   - `iFinder_search`      `{ searchProfile, results: [hit, …] }`
 *   - `iFinder_getMetadata` a single hit carrying `searchProfile`
 *   - `iFinder_getContent`  `{ searchProfile, documentId, metadata: { title, filename, url } }`
 *
 * iAssistant payloads: `result_items` (documents, cited as
 * `<cite type="r">N</cite>` by their 1-based position) and `references`
 * (passages, cited as `<cite type="s">N</cite>` by their `index`), each with
 * `document_id`, `title`, `additional_document_metadata` and `links`.
 *
 * @module services/sources/producers/ifinder
 */
import { storedSourceSet } from '../../../../shared/sources/index.js';

const DOCUMENT_TOOLS = new Set(['ifinder_search', 'ifinder_getmetadata', 'ifinder_getcontent']);

const DOCUMENT = { provider: 'ifinder', kind: 'document', private: true };

/**
 * @param {string} toolId
 * @returns {boolean} whether the tool's result describes iFinder documents
 */
export function isIFinderDocumentTool(toolId) {
  return DOCUMENT_TOOLS.has(String(toolId || '').toLowerCase());
}

/** A trimmed string, or the first one of an array (iFinder returns most fields as arrays). */
function textOf(value) {
  const candidate = Array.isArray(value)
    ? value.find(entry => typeof entry === 'string' && entry.trim())
    : value;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

/** A document id as a string (numbers too), else undefined. */
function idOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * A hit's `url` is often the document's own location (`file://`, `smb://`);
 * the deep link is what opens it in a browser. Only http(s) survives
 * normalization, so the first http(s) one wins.
 */
function browserLink(...values) {
  return values.map(textOf).find(value => typeof value === 'string' && /^https?:\/\//i.test(value));
}

/**
 * One iFinder document as a source input.
 *
 * @param {Object} doc - a hit, or the metadata of a read document
 * @param {string|undefined} searchProfile
 * @param {Object} [fields] - more fields (a read, markers, passages)
 * @returns {Object|null} null when the document carries no id
 */
function documentSource(doc, searchProfile, fields = {}) {
  const id = idOf(doc.id ?? doc.documentId);
  if (!id) return null;
  return {
    ...DOCUMENT,
    ref: { id, scope: searchProfile },
    title: textOf(doc.title),
    url: browserLink(doc.deepLink, doc.accessInfo?.deepLink, doc.url),
    site: textOf(doc.sourceName) || textOf(doc.sourceType),
    fileName: textOf(doc.filename ?? doc.file?.name),
    type: textOf(doc.application),
    snippet: textOf(doc.teasers ?? doc.teaser),
    ...fields
  };
}

/** An iFinder tool result as an object: JSON text parsed, else null. */
function parseResult(result) {
  if (typeof result !== 'string') return result;
  const text = result.trim();
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** What the search looked for, unless it was the match-all `*`. */
function queryOf(args) {
  const query = args && typeof args === 'object' ? args.query : null;
  return typeof query === 'string' && query.trim() && query.trim() !== '*' ? query : null;
}

export const iFinderSourceProducer = {
  id: 'ifinder',

  /** @param {{toolId: string}} call */
  matches({ toolId }) {
    return isIFinderDocumentTool(toolId);
  },

  /**
   * @param {{toolId: string, args?: Object, result: unknown, failed?: boolean}} call
   * @returns {{items: Array, queries: string[]}}
   */
  fromToolResult({ toolId, args, result, failed }) {
    const tool = String(toolId).toLowerCase();
    const queries = tool === 'ifinder_search' ? [queryOf(args)].filter(Boolean) : [];
    const parsed = parseResult(result);
    if (failed || !parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error) {
      return { items: [], queries };
    }
    const searchProfile = textOf(parsed.searchProfile) || textOf(args?.searchProfile);
    let items;
    if (tool === 'ifinder_search') {
      items = (Array.isArray(parsed.results) ? parsed.results : []).map(hit =>
        hit && typeof hit === 'object' ? documentSource(hit, searchProfile) : null
      );
    } else if (tool === 'ifinder_getcontent') {
      items = [
        documentSource({ ...parsed.metadata, documentId: parsed.documentId }, searchProfile, {
          read: { ok: true }
        })
      ];
    } else {
      items = [documentSource(parsed, searchProfile)];
    }
    return { items: items.filter(Boolean), queries };
  }
};

// ── iAssistant ─────────────────────────────────────────────────────────────

function metaOf(item, key) {
  const metadata = item?.additional_document_metadata;
  return metadata && typeof metadata === 'object' ? metadata[key] : undefined;
}

/** The search profile an iAssistant document's ACCESS link names. */
function accessProfile(item) {
  const links = Array.isArray(item?.links) ? item.links : [];
  const access = links.find(link => link?.type === 'ACCESS');
  return textOf(access?.searchProfile);
}

/** One iAssistant result item as an iFinder document source, or null without a document id. */
function iAssistantDocument(item, searchProfile, fields) {
  if (!item || typeof item !== 'object') return null;
  const id = idOf(item.document_id) || idOf(textOf(metaOf(item, 'id')));
  if (!id) return null;
  return {
    ...DOCUMENT,
    ref: { id, scope: accessProfile(item) || searchProfile },
    title: textOf(item.title) || textOf(metaOf(item, 'title')),
    url: browserLink(metaOf(item, 'accessInfo.deepLink')),
    site: textOf(metaOf(item, 'sourceName')) || textOf(metaOf(item, 'sourceType')),
    fileName: textOf(metaOf(item, 'file.name')),
    type: textOf(metaOf(item, 'application')),
    ...fields
  };
}

/**
 * iAssistant's documents and passages as a source frame.
 *
 * iFinder sends result items with no title and an invalid id (`publicpush-*`)
 * along with the real ones; a document is only listed when it has a title or
 * a passage the answer can cite.
 *
 * @param {{references?: Array, resultItems?: Array}|null} payload
 * @param {{searchProfile?: string}} [context] - the conversation's search profile,
 *   for documents whose ACCESS link names none (or that have none)
 * @returns {{items: Array}|null} null when the payload lists nothing
 */
export function iAssistantSourceFrame(payload, { searchProfile } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const items = [];
  const resultItems = Array.isArray(payload.resultItems) ? payload.resultItems : [];
  resultItems.forEach((item, position) => {
    const source = iAssistantDocument(item, searchProfile, { markers: [`r:${position + 1}`] });
    if (source?.title) items.push(source);
  });
  for (const reference of Array.isArray(payload.references) ? payload.references : []) {
    const content = textOf(reference?.content);
    const marker = Number.isInteger(reference?.index) ? `s:${reference.index}` : undefined;
    const source = iAssistantDocument(reference, searchProfile, {
      passages: content ? [{ text: content, ...(marker ? { marker } : {}) }] : []
    });
    if (source && (source.title || source.passages.length)) items.push(source);
  }
  return items.length ? { items } : null;
}

/**
 * A page of iAssistant conversation history, as `GET /conversations/:id/messages`
 * returns it (`{ messages: [...] }` or a bare array, each message carrying
 * `references` and `result_items`), with each message's documents as
 * `sources` — so a resumed conversation's answers show the same panel and
 * actions as the live ones.
 *
 * @param {Object|Array} page - the conversation API's response
 * @param {string} [searchProfile] - the conversation's search profile
 * @returns {Object|Array} the page with `sources` on each message that lists documents
 */
export function withConversationSources(page, searchProfile) {
  const convert = messages =>
    messages.map(message => {
      if (!message || typeof message !== 'object') return message;
      const frame = iAssistantSourceFrame(
        { references: message.references, resultItems: message.result_items },
        { searchProfile }
      );
      const sources = frame ? storedSourceSet(frame) : null;
      return sources ? { ...message, sources } : message;
    });
  if (Array.isArray(page)) return convert(page);
  if (page && Array.isArray(page.messages)) return { ...page, messages: convert(page.messages) };
  return page;
}

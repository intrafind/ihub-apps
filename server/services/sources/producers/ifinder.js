// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * Every document also carries `scopeName`, the display name of the profile it
 * was found in ("Contracts"), or the profile id when the name is unknown; the
 * sources panel shows it on the card (#3056). A search records the profile it
 * ran in, and an iAssistant answer the iAssistant it asked, as the frame's
 * `scopes` (`shared/sources/sourceSet.js`).
 *
 * Tool results, read from the full result, never from the preview:
 *   - `iFinder_search`      `{ searchProfile, searchProfileName?, results: [hit, …] }`
 *   - `iFinder_getMetadata` a single hit carrying `searchProfile` (and `searchProfileName`)
 *   - `iFinder_getContent`  `{ searchProfile, searchProfileName?, documentId,
 *                             metadata: { title, filename, url } }`
 *
 * `searchProfileName` is added by the tool (`tools/iFinder.js`) from the
 * user's cached profile list.
 *
 * iAssistant payloads: `result_items` (documents, cited as
 * `<cite type="r">N</cite>` by their 1-based position) and `references`
 * (passages, cited as `<cite type="s">N</cite>` by their `index`), each with
 * `document_id`, `title`, `additional_document_metadata` and `links`.
 *
 * @module services/sources/producers/ifinder
 */

const DOCUMENT_TOOLS = new Set(['ifinder_search', 'ifinder_getmetadata', 'ifinder_getcontent']);

const DOCUMENT = { provider: 'ifinder', kind: 'document', private: true };

/** The scope registry's id of the iFinder integration (`scopes/iFinderScopes.js`). */
const IFINDER_INTEGRATION_ID = 'ifinder';

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
 * The display name of a search profile: its name when known, else its id.
 *
 * @param {string|undefined} searchProfile
 * @param {Map<string, string>|Object<string, string>|undefined} names - by profile id
 * @returns {string|undefined}
 */
function profileName(searchProfile, names) {
  if (!searchProfile) return undefined;
  return textOf(nameIn(names, searchProfile)) || searchProfile;
}

/** The entry for `id` in a Map or a plain object of names, if any. */
function nameIn(names, id) {
  if (names instanceof Map) return names.get(id);
  if (names && typeof names === 'object' && Object.hasOwn(names, id)) return names[id];
  return undefined;
}

/**
 * One iFinder document as a source input.
 *
 * @param {Object} doc - a hit, or the metadata of a read document
 * @param {string|undefined} searchProfile
 * @param {string|undefined} scopeName - the profile's display name
 * @param {Object} [fields] - more fields (a read, markers, passages)
 * @returns {Object|null} null when the document carries no id
 */
function documentSource(doc, searchProfile, scopeName, fields = {}) {
  const id = idOf(doc.id ?? doc.documentId);
  if (!id) return null;
  return {
    ...DOCUMENT,
    ref: { id, scope: searchProfile },
    ...(searchProfile && scopeName ? { scopeName } : {}),
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

  /**
   * What the call came to, from the full result: the hits of a search, whether
   * a document read delivered any text. Left out when the result does not say.
   *
   * @param {{toolId: string, result: unknown, failed?: boolean}} call
   * @returns {{resultCount?: number, readOutcome?: 'opened'|'empty'}}
   */
  outcomeOf({ toolId, result, failed }) {
    const parsed = parseResult(result);
    if (failed || !parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error) {
      return {};
    }
    const tool = String(toolId).toLowerCase();
    if (tool === 'ifinder_search') {
      return Array.isArray(parsed.results) ? { resultCount: parsed.results.length } : {};
    }
    if (tool === 'ifinder_getcontent' && typeof parsed.content === 'string') {
      return { readOutcome: parsed.content.trim() ? 'opened' : 'empty' };
    }
    return {};
  },

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
    const scopeName = textOf(parsed.searchProfileName) || searchProfile;
    let items;
    if (tool === 'ifinder_search') {
      items = (Array.isArray(parsed.results) ? parsed.results : []).map(hit =>
        hit && typeof hit === 'object' ? documentSource(hit, searchProfile, scopeName) : null
      );
    } else if (tool === 'ifinder_getcontent') {
      items = [
        documentSource(
          { ...parsed.metadata, documentId: parsed.documentId },
          searchProfile,
          scopeName,
          { read: { ok: true } }
        )
      ];
    } else {
      items = [documentSource(parsed, searchProfile, scopeName)];
    }
    // Where the search ran, even when it found nothing; a read names no search.
    const scopes =
      tool === 'ifinder_search' && searchProfile
        ? [
            {
              integrationId: IFINDER_INTEGRATION_ID,
              id: searchProfile,
              name: scopeName,
              action: 'search'
            }
          ]
        : [];
    return { items: items.filter(Boolean), queries, ...(scopes.length ? { scopes } : {}) };
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
function iAssistantDocument(item, { searchProfile, scopeNames }, fields) {
  if (!item || typeof item !== 'object') return null;
  const id = idOf(item.document_id) || idOf(textOf(metaOf(item, 'id')));
  if (!id) return null;
  // The profile iFinder names on the document; over all of the user's
  // profiles, that is the only way to tell where a document was found.
  const scope = accessProfile(item) || searchProfile;
  return {
    ...DOCUMENT,
    ref: { id, scope },
    ...(scope ? { scopeName: profileName(scope, scopeNames) } : {}),
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
 * @param {Object} [context]
 * @param {string} [context.searchProfile] - the conversation's search profile,
 *   for documents whose ACCESS link names none (or that have none)
 * @param {Map<string, string>|Object<string, string>} [context.scopeNames] -
 *   display names of the user's search profiles, by id
 * @param {Object} [context.scope] - the iAssistant scope the answer was
 *   produced with (`{ integrationId, id, name, action }`), recorded as the
 *   frame's `scopes`
 * @returns {{items: Array, scopes?: Array}|null} null when the payload lists nothing
 */
export function iAssistantSourceFrame(payload, { searchProfile, scopeNames, scope } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const context = { searchProfile, scopeNames };
  const items = [...resultItemSources(payload, context), ...referenceSources(payload, context)];
  if (!items.length) return null;
  return scope ? { items, scopes: [scope] } : { items };
}

/** The payload's result items as sources (marker `r:<position>`), titled ones only. */
function resultItemSources(payload, context) {
  const resultItems = Array.isArray(payload.resultItems) ? payload.resultItems : [];
  return resultItems
    .map((item, position) => iAssistantDocument(item, context, { markers: [`r:${position + 1}`] }))
    .filter(source => source?.title);
}

/** The payload's references as sources with their passage (marker `s:<index>`). */
function referenceSources(payload, context) {
  const references = Array.isArray(payload.references) ? payload.references : [];
  return references
    .map(reference => {
      const content = textOf(reference?.content);
      const marker = Number.isInteger(reference?.index) ? `s:${reference.index}` : undefined;
      return iAssistantDocument(reference, context, {
        passages: content ? [{ text: content, ...(marker ? { marker } : {}) }] : []
      });
    })
    .filter(source => source && (source.title || source.passages.length));
}

/** The definition and action of the iAssistant `ask` tool (`iassistant__ask`). */
const IASSISTANT_DEFINITION_ID = 'com.intrafind/iassistant';
const ASK_ACTION = 'ask';

/**
 * Source producer for the iAssistant `ask` action (#2973): the documents the
 * answer cites, as the tool reported them beside its result (renumbered to
 * this call's passage numbers, see `services/integrations/iAssistantAsk.js`),
 * and the iAssistant scope it asked, which the result names — the same frame
 * an iAssistant chat answer carries.
 */
export const iAssistantAskSourceProducer = {
  id: 'iassistant-ask',

  /** @param {{toolDef?: Object}} call */
  matches({ toolDef }) {
    const marker = toolDef?._integration;
    return marker?.definition === IASSISTANT_DEFINITION_ID && marker.action === ASK_ACTION;
  },

  /**
   * @param {{result: unknown, reported?: Array, failed?: boolean}} call
   * @returns {{items: Array, scopes?: Array}}
   */
  fromToolResult({ result, reported = [], failed }) {
    if (failed) return { items: [] };
    const parsed = parseResult(result);
    const scope = parsed && typeof parsed === 'object' ? parsed.scope : null;
    const scopes = scope && typeof scope === 'object' && scope.id ? [scope] : [];
    return { items: reported, ...(scopes.length ? { scopes } : {}) };
  }
};

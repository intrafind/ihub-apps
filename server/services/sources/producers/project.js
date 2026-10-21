// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Source producer for the project knowledge tools (#1036, spec 2 §5).
 *
 * `knowledge_search` and `knowledge_read` report their hits as `Source`s of
 * provider `project`, kind `document`, with `ref: { id: itemId, scope:
 * projectId }` — the handle the `project` source provider previews and
 * downloads through — and a `provenance` that the citation panel shows as
 * the "uploaded" or "picked" marker. Every project source is private: it
 * was found with the reader's membership, so a share never carries it.
 *
 * @module services/sources/producers/project
 */

const KNOWLEDGE_TOOLS = new Set(['knowledge_search', 'knowledge_read']);

const DOCUMENT = { provider: 'project', kind: 'document', private: true };

/** File type shown on the card, from the original content type or the name. */
function typeOf(item) {
  const contentType = item?.text?.original?.contentType || item?.ref?.contentType || '';
  if (/pdf/i.test(contentType)) return 'PDF';
  if (/wordprocessingml|msword/i.test(contentType)) return 'Word';
  if (/presentationml|powerpoint/i.test(contentType)) return 'PowerPoint';
  if (/spreadsheetml|excel/i.test(contentType)) return 'Excel';
  if (/markdown/i.test(contentType)) return 'Markdown';
  if (/html/i.test(contentType) || item?.kind === 'url' || item?.kind === 'page') return 'Page';
  if (item?.kind?.startsWith('ifinder')) return 'iFinder';
  const ext = /\.([a-z0-9]{1,5})$/i.exec(String(item?.name || ''));
  return ext ? ext[1].toUpperCase() : undefined;
}

/**
 * One project item as a source input.
 *
 * @param {Object} project
 * @param {Object|undefined} item
 * @param {Object} [fields] - snippet, passages, read
 * @returns {Object|null}
 */
export function projectSource(project, item, fields = {}) {
  if (!project?.id || !item?.id) return null;
  const name = typeof project.name === 'string' ? project.name : project.name?.en || project.id;
  const url = item.provenance?.source?.url || item.ref?.url || item.ref?.webUrl || undefined;
  return {
    ...DOCUMENT,
    ref: { id: item.id, scope: project.id },
    title: item.name,
    site: name,
    fileName: item.name,
    type: typeOf(item),
    ...(url ? { url } : {}),
    provenance: {
      origin: item.provenance?.origin || 'linked',
      kind: item.kind,
      ...(item.snapshotAt ? { at: item.snapshotAt } : {})
    },
    ...fields
  };
}

/** A tool result as an object: JSON text parsed, else null. */
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

export const projectSourceProducer = {
  id: 'project',

  /** @param {{toolId: string}} call */
  matches({ toolId }) {
    return KNOWLEDGE_TOOLS.has(String(toolId || '').toLowerCase());
  },

  /**
   * The tools put their sources into the result envelope already; this
   * producer only adds the query and keeps a failed call quiet.
   *
   * @param {{toolId: string, args?: Object, result: unknown, failed?: boolean}} call
   * @returns {{items: Array, queries: string[]}}
   */
  fromToolResult({ toolId, args, result, failed }) {
    if (failed) return { items: [], queries: [] };
    const parsed = parseResult(result);
    const items = Array.isArray(parsed?.sources) ? parsed.sources : [];
    const query =
      String(toolId).toLowerCase() === 'knowledge_search' &&
      typeof args?.query === 'string' &&
      args.query.trim()
        ? [args.query.trim()]
        : [];
    return { items, queries: query };
  }
};

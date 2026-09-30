/**
 * Sources a tool reports itself, in its result — the way any tool, MCP server
 * or app invoked as a tool tells the user "I have found this for you" without
 * code of its own on the platform:
 *
 *   - a `sources` array of source inputs next to the tool's data:
 *     `{ "results": […], "sources": [{ "title": "…", "url": "https://…" }] }`
 *     (see `shared/sources/source.js` for the fields);
 *   - MCP: `resource_link` content blocks (`{ type: 'resource_link', uri,
 *     name, title?, description?, mimeType? }`), `structuredContent.sources`,
 *     or a text block holding such a JSON object.
 *
 * What a tool reports is private unless it says otherwise per source
 * (`private: false`): the platform cannot tell whether a tool's hits are
 * public, and a share must never show a viewer what the owner found with
 * their own permissions.
 *
 * @module services/sources/producers/envelope
 */

function parseJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sourcesOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  if (Array.isArray(value.sources)) return value.sources;
  if (Array.isArray(value.structuredContent?.sources)) return value.structuredContent.sources;
  return [];
}

/** An MCP `resource_link` block as a source input. */
function resourceLinkSource(part) {
  const uri = typeof part.uri === 'string' ? part.uri : null;
  if (!uri) return null;
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType : '';
  const isWeb = /^https?:\/\//i.test(uri);
  return {
    // A non-web resource is identified by its URI; a web one by its link.
    ...(isWeb ? { url: uri } : { id: uri }),
    title: part.title || part.name,
    snippet: part.description,
    kind: !mimeType || mimeType === 'text/html' ? (isWeb ? 'page' : 'item') : 'document',
    ...(mimeType && mimeType !== 'text/html' ? { type: mimeType } : {})
  };
}

/**
 * @param {unknown} result - the tool's raw result (object, array, or JSON text)
 * @returns {{items: Array}|null} null when the result reports no sources
 */
export function envelopeSources(result) {
  const parsed = parseJson(result);
  const items = [];
  if (Array.isArray(parsed)) {
    // MCP content blocks.
    for (const part of parsed) {
      if (part?.type === 'resource_link') {
        const source = resourceLinkSource(part);
        if (source) items.push(source);
      } else if (part?.type === 'text' && typeof part.text === 'string') {
        items.push(...sourcesOf(parseJson(part.text)));
      }
    }
  } else {
    items.push(...sourcesOf(parsed));
  }
  const inputs = items.filter(item => item && typeof item === 'object' && !Array.isArray(item));
  return inputs.length ? { items: inputs } : null;
}

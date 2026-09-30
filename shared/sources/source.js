/**
 * A source: one thing an integration found for the user — a web page, a
 * document, a record — in the one shape the whole platform speaks.
 *
 * Every producer (web search, the page reader, provider grounding, iFinder,
 * iAssistant, a tool that returns `sources`, a tool definition that declares a
 * mapping, an MCP `resource_link`) hands over {@link SourceInput}s; everything
 * downstream — the loop, the wire, the stored answer, the share, the sources
 * panel, the inline citations and the actions — reads {@link Source}s.
 *
 * @typedef {'page'|'document'|'item'} SourceKind
 *   `page` a web page, `document` a file in a document system, `item` a record
 *   (a ticket, a person, a row).
 *
 * @typedef {Object} SourceInput
 * @property {string} [provider] - the system the source lives in (`web`,
 *   `ifinder`, a tool or integration id); it decides the source's actions
 * @property {SourceKind} [kind]
 * @property {string|number} [id] - the provider's own id, for sources without a `ref`
 * @property {string} [title]
 * @property {string} [url] - http(s) link that opens the source
 * @property {string} [site] - display host or source system ("example.com", "SharePoint")
 * @property {string} [favicon]
 * @property {string} [snippet] - excerpt; markup is stripped
 * @property {Array<string|{text: string, marker?: string}>} [passages] - cited or retrieved passages
 * @property {string} [publishedDate]
 * @property {string} [fileName]
 * @property {string} [type] - file type or application ("PDF")
 * @property {{id: string|number, scope?: string}} [ref] - handle for the
 *   provider's content actions (iFinder: document id and search profile)
 * @property {{ok: boolean, words?: number, truncated?: boolean}} [read] - a read of its content
 * @property {boolean} [cited] - the provider reports that the answer relies on it
 * @property {string[]} [markers] - provider inline markers that point at it (iAssistant `r:3`)
 * @property {boolean} [private] - found with the user's own permissions or
 *   network; never included in a share
 *
 * @typedef {SourceInput & {id: string, provider: string, kind: SourceKind, private: boolean}} Source
 *   `id` identifies the source within an answer: `provider:ref.id`, else
 *   `provider:id`, else `url:<urlKey>`.
 *
 * Pure functions only, no DOM and no Node APIs, so both sides import it.
 *
 * @module shared/sources/source
 */
import { httpUrl, urlKey } from './url.js';

export const SOURCE_KINDS = Object.freeze(['page', 'document', 'item']);

/** Most passages kept per source. */
export const MAX_PASSAGES = 10;
/** Most markers kept per source. */
const MAX_MARKERS = 20;

const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 400;
const MAX_PASSAGE_CHARS = 4000;
const MAX_FIELD_CHARS = 300;
const MAX_REF_ID_CHARS = 1024;
const MAX_SCOPE_CHARS = 256;

const PROVIDER = /^[\w.:-]{1,100}$/;
const MARKER = /^[\w.:-]{1,32}$/;

/** The first non-empty string of a value (integrations often send arrays). */
function firstString(value) {
  if (Array.isArray(value)) return value.find(entry => typeof entry === 'string' && entry.trim());
  return typeof value === 'string' ? value : undefined;
}

function text(value, max) {
  const candidate = firstString(value);
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Text without markup. Search engines mark the matched terms with HTML
 * (`<strong>`, `<em>`), and a source card shows text: everything from a `<`
 * to the next `>` is dropped, and neither bracket is ever kept, so a broken or
 * nested tag cannot leave markup behind.
 */
function stripTags(value) {
  let out = '';
  let inTag = false;
  for (const char of value) {
    if (char === '<') inTag = true;
    else if (char === '>') inTag = false;
    else if (!inTag) out += char;
  }
  return out;
}

function plain(value, max) {
  const candidate = firstString(value);
  return typeof candidate === 'string' ? text(stripTags(candidate), max) : null;
}

function idOf(value, max = MAX_REF_ID_CHARS) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const candidate = firstString(value);
  return typeof candidate === 'string' && candidate && candidate.length <= max ? candidate : null;
}

function dateOf(value) {
  const candidate = firstString(value);
  if (typeof candidate !== 'string' || candidate.length > 64) return null;
  const time = Date.parse(candidate);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function refOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = idOf(value.id);
  if (!id) return null;
  const scope = text(value.scope, MAX_SCOPE_CHARS);
  return scope ? { id, scope } : { id };
}

function readOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.ok !== true && value.ok !== false) return null;
  const read = { ok: value.ok };
  if (value.ok && Number.isInteger(value.words) && value.words >= 0) read.words = value.words;
  if (value.ok && value.truncated === true) read.truncated = true;
  return read;
}

function passagesOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const raw = typeof entry === 'string' ? entry : entry?.text;
    const passage = text(raw, MAX_PASSAGE_CHARS);
    if (!passage || out.some(known => known.text === passage)) continue;
    const marker =
      typeof entry?.marker === 'string' && MARKER.test(entry.marker) ? entry.marker : null;
    out.push(marker ? { text: passage, marker } : { text: passage });
    if (out.length >= MAX_PASSAGES) break;
  }
  return out;
}

function markersOf(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter(marker => typeof marker === 'string' && MARKER.test(marker)))
  ].slice(0, MAX_MARKERS);
}

/**
 * The identity of a source within an answer.
 *
 * @param {{provider: string, ref?: {id: string}, localId?: string|null, url?: string}} parts
 * @returns {string|null}
 */
function identity({ provider, ref, localId, url }) {
  if (ref) return `${provider}:${ref.id}`;
  if (localId) return `${provider}:${localId}`;
  const key = url ? urlKey(url) : null;
  return key ? `url:${key}` : null;
}

/**
 * A source as every consumer reads it: known fields only, each bounded and
 * checked (links are http(s) only, text carries no markup). Idempotent, so a
 * source that was normalized once (a stored answer, a wire frame) comes out
 * the same.
 *
 * @param {SourceInput} input
 * @param {{provider?: string, kind?: SourceKind, private?: boolean}} [defaults] -
 *   applied where the input names none
 * @returns {Source|null} null when the input identifies nothing (no ref, id or link)
 */
export function normalizeSource(input, defaults = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const providerValue = typeof input.provider === 'string' ? input.provider : defaults.provider;
  const provider =
    typeof providerValue === 'string' && PROVIDER.test(providerValue) ? providerValue : 'unknown';
  const url = httpUrl(firstString(input.url));
  const ref = refOf(input.ref);
  // A normalized source's own `id` is its identity, not a provider id.
  const ownId = idOf(input.id);
  const localId =
    ownId && ownId.startsWith(`${provider}:`) ? ownId.slice(provider.length + 1) : ownId;
  const id =
    ownId && ownId.startsWith('url:') && !ref
      ? identity({ provider, url })
      : identity({ provider, ref, localId, url });
  if (!id) return null;

  const kindValue = SOURCE_KINDS.includes(input.kind) ? input.kind : defaults.kind;
  const kind = SOURCE_KINDS.includes(kindValue)
    ? kindValue
    : ref
      ? 'document'
      : url
        ? 'page'
        : 'item';

  const source = { id, provider, kind };
  const title = text(input.title, MAX_TITLE_CHARS);
  if (title) source.title = title;
  if (url) source.url = url;
  const site = text(input.site, MAX_FIELD_CHARS);
  if (site) source.site = site;
  const favicon = httpUrl(firstString(input.favicon));
  if (favicon) source.favicon = favicon;
  const snippet = plain(input.snippet, MAX_SNIPPET_CHARS);
  if (snippet) source.snippet = snippet;
  const passages = passagesOf(input.passages);
  if (passages.length) source.passages = passages;
  const publishedDate = dateOf(input.publishedDate);
  if (publishedDate) source.publishedDate = publishedDate;
  const fileName = text(input.fileName, MAX_FIELD_CHARS);
  if (fileName) source.fileName = fileName;
  const type = text(input.type, 100);
  if (type) source.type = type;
  if (ref) source.ref = ref;
  const read = readOf(input.read);
  if (read) source.read = read;
  if (input.cited === true) source.cited = true;
  const markers = markersOf(input.markers);
  if (markers.length) source.markers = markers;
  // Always stated, so a source normalized once keeps its privacy whatever
  // defaults a later pass brings.
  source.private = typeof input.private === 'boolean' ? input.private : defaults.private === true;
  return source;
}

function mergeRead(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.ok && b.ok) {
    const read = { ok: true };
    const words = Math.max(a.words || 0, b.words || 0);
    if (a.words != null || b.words != null) read.words = words;
    if (a.truncated || b.truncated) read.truncated = true;
    return read;
  }
  return a.ok ? a : b;
}

/**
 * Two sightings of the same source as one: the first keeps its values, the
 * later one fills in what it lacks. A read that succeeded wins over one that
 * failed, a citation sticks, passages and markers add up. A source is private
 * only while every sighting was: a page a public web search returned stays
 * public when the page reader later read it too.
 *
 * @param {Source} known
 * @param {Source} seen - same `id`
 * @returns {Source}
 */
export function mergeSource(known, seen) {
  const merged = { ...seen, ...known };
  for (const [key, value] of Object.entries(known)) {
    if (value === undefined || value === null || value === '') merged[key] = seen[key];
  }
  if (known.ref && seen.ref && !known.ref.scope && seen.ref.scope) merged.ref = seen.ref;
  const passages = passagesOf([...(known.passages || []), ...(seen.passages || [])]);
  if (passages.length) merged.passages = passages;
  const markers = markersOf([...(known.markers || []), ...(seen.markers || [])]);
  if (markers.length) merged.markers = markers;
  const read = mergeRead(known.read, seen.read);
  if (read) merged.read = read;
  if (known.cited || seen.cited) merged.cited = true;
  merged.private = known.private === true && seen.private === true;
  return merged;
}

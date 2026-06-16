/**
 * Memory sections — tripartite long-term memory with per-entry source markers.
 *
 * Agent long-term memory is plain markdown organised into three canonical
 * `## ` sections so accumulated knowledge has somewhere structured to grow:
 *
 *   - **Semantic**   — durable facts, identifiers, stable preferences.
 *   - **Episodic**   — what happened on specific runs (dated observations).
 *   - **Procedural** — how-to knowledge: recurring steps, playbooks.
 *
 * Operators may also keep their own free-form `## ` sections (e.g. a corpus
 * map built via the admin "build memory from tool" flow). Those are preserved
 * untouched — only the three canonical sections are merged into by the agent.
 *
 * **Source markers & immutability.** Every list entry the agent writes carries
 * a trailing `<!-- src:agent -->` marker. Entries without an agent marker are
 * treated as human-authored and are IMMUTABLE to the agent: a `replace` from
 * the memory composer only drops the agent's own entries and always keeps
 * human entries (and any non-list prose). This lets the agent curate its own
 * notes across runs without ever clobbering what a person hand-edited.
 *
 * This module is pure (no I/O) so it can be unit-tested in isolation and
 * reused by both the deterministic memory-finalize executor and the admin
 * memory routes.
 *
 * @module agents/memory/memorySections
 */

export const TRIPARTITE_SECTIONS = ['Semantic', 'Episodic', 'Procedural'];

export const AGENT_MARKER = '<!-- src:agent -->';
export const HUMAN_MARKER = '<!-- src:human -->';

const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/;
const LIST_ITEM_RE = /^\s*[-*]\s+/;
const SOURCE_MARKER_RE = /<!--\s*src:(agent|human)\s*-->/gi;

/**
 * Split a memory body into a leading preamble and an ordered list of `## `
 * sections. Only h2 (`## `) headings are treated as section boundaries, which
 * matches the existing `removeMemorySection` convention in the admin routes.
 *
 * @param {string} body
 * @returns {{ preamble: string, sections: Array<{ heading: string, body: string }> }}
 */
export function splitBody(body) {
  const lines = String(body || '').split('\n');
  const preambleLines = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(SECTION_HEADING_RE);
    if (match) {
      current = { heading: match[1].trim(), bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  return {
    preamble: preambleLines.join('\n'),
    sections: sections.map(s => ({ heading: s.heading, body: s.bodyLines.join('\n') }))
  };
}

/**
 * Reassemble a preamble + sections back into a normalised markdown body.
 * Collapses runs of blank lines and ensures a single trailing newline.
 *
 * @param {string} preamble
 * @param {Array<{ heading: string, body: string }>} sections
 * @returns {string}
 */
export function assembleBody(preamble, sections) {
  const parts = [];
  const pre = String(preamble || '')
    .replace(/\n+$/, '')
    .trim();
  if (pre) parts.push(pre);
  for (const section of sections) {
    const inner = String(section.body || '')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
    parts.push(inner ? `## ${section.heading}\n\n${inner}` : `## ${section.heading}`);
  }
  const out = parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s*$/, '');
  return out.length > 0 ? `${out}\n` : '';
}

/**
 * Classify each line of a section body as a list `entry` (with a source) or an
 * `extra` (blank line / prose / continuation). Extras are always preserved.
 *
 * @param {string} sectionBody
 * @returns {Array<{ type: 'entry'|'extra', source?: 'agent'|'human', raw: string }>}
 */
export function parseItems(sectionBody) {
  return String(sectionBody || '')
    .split('\n')
    .map(line => {
      if (LIST_ITEM_RE.test(line)) {
        const source = line.includes(AGENT_MARKER) ? 'agent' : 'human';
        return { type: 'entry', source, raw: line };
      }
      return { type: 'extra', raw: line };
    });
}

/**
 * Format a piece of agent-authored text as a single-line, source-marked bullet.
 * Newlines are collapsed to spaces so the entry is a single line — this keeps
 * `replace` removal unambiguous (no orphaned continuation lines) and avoids
 * accidentally swallowing a following human line.
 *
 * @param {string} text
 * @returns {string|null} formatted bullet, or null when the text is empty
 */
export function formatAgentEntry(text) {
  const cleaned = stripSourceMarkers(String(text == null ? '' : text))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LIST_ITEM_RE, '');
  if (!cleaned) return null;
  return `- ${cleaned} ${AGENT_MARKER}`;
}

/**
 * Remove `<!-- src:* -->` markers from text (for display / prompt injection).
 * @param {string} text
 * @returns {string}
 */
export function stripSourceMarkers(text) {
  return String(text == null ? '' : text)
    .replace(SOURCE_MARKER_RE, '')
    .replace(/[ \t]+$/gm, '');
}

/**
 * Turn a composer section string (possibly a bullet list, possibly a single
 * paragraph) into an array of entry strings. Lines before the first bullet are
 * dropped; wrapped continuation lines are folded into the preceding entry.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseEntriesFromText(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return [];
  const lines = trimmed.split('\n');
  const hasBullets = lines.some(l => LIST_ITEM_RE.test(l));
  if (!hasBullets) return [trimmed];

  const entries = [];
  let current = null;
  for (const line of lines) {
    if (LIST_ITEM_RE.test(line)) {
      if (current !== null) entries.push(current);
      current = line.replace(LIST_ITEM_RE, '').trim();
    } else if (current !== null) {
      const extra = line.trim();
      if (extra) current += ` ${extra}`;
    }
  }
  if (current !== null) entries.push(current);
  return entries.map(e => e.trim()).filter(Boolean);
}

/**
 * Merge agent-authored entries into one section body, honouring source-marker
 * immutability.
 *
 *   - `append`  → keep everything, add the new agent entries at the end.
 *   - `replace` → drop the agent's OWN existing entries, keep human entries and
 *                 all prose, then add the new agent entries.
 *
 * @param {string} sectionBody
 * @param {string[]} newEntries raw agent text (one entry each)
 * @param {'append'|'replace'} mode
 * @returns {string}
 */
export function mergeSectionBody(sectionBody, newEntries, mode) {
  const items = parseItems(sectionBody);
  const kept =
    mode === 'replace'
      ? items.filter(it => !(it.type === 'entry' && it.source === 'agent'))
      : items.slice();

  const additions = (Array.isArray(newEntries) ? newEntries : [])
    .map(formatAgentEntry)
    .filter(Boolean);

  const lines = [...kept.map(it => it.raw), ...additions];
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Normalise a raw memory delta into `{ mode, sections: { Semantic: [...], ... } }`.
 *
 * Accepts canonical keys (`Semantic`) or lowercase keys (`semantic`), values as
 * strings or arrays, and a legacy flat `content` field (routed to `Semantic`).
 *
 * @param {object} delta
 * @returns {{ mode: 'append'|'replace', sections: Record<string,string[]> }}
 */
export function normalizeDelta(delta) {
  const out = { mode: delta?.mode === 'replace' ? 'replace' : 'append', sections: {} };
  const src = delta?.sections && typeof delta.sections === 'object' ? delta.sections : delta || {};

  for (const canonical of TRIPARTITE_SECTIONS) {
    const value = src[canonical] != null ? src[canonical] : src[canonical.toLowerCase()];
    if (value == null) continue;
    const entries = Array.isArray(value)
      ? value.flatMap(v => parseEntriesFromText(String(v)))
      : parseEntriesFromText(value);
    if (entries.length) out.sections[canonical] = entries;
  }

  // Backward compatibility: a legacy flat `{ content }` delta routes to Semantic.
  if (
    Object.keys(out.sections).length === 0 &&
    typeof delta?.content === 'string' &&
    delta.content.trim()
  ) {
    const entries = parseEntriesFromText(delta.content);
    if (entries.length) out.sections.Semantic = entries;
  }

  return out;
}

/**
 * Apply a normalised delta to a full memory body, merging into the three
 * canonical sections (creating them in canonical order when absent) and
 * leaving the preamble and any operator-authored sections untouched.
 *
 * @param {string} body
 * @param {{ mode: 'append'|'replace', sections: Record<string,string[]> }} normalized
 * @returns {string} the new body
 */
export function applyDeltaToBody(body, normalized) {
  const { preamble, sections } = splitBody(body);
  const mode = normalized.mode === 'replace' ? 'replace' : 'append';

  for (const canonical of TRIPARTITE_SECTIONS) {
    const entries = normalized.sections?.[canonical];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    let section = sections.find(s => s.heading.toLowerCase() === canonical.toLowerCase());
    if (!section) {
      section = { heading: canonical, body: '' };
      sections.push(section);
    }
    section.body = mergeSectionBody(section.body, entries, mode);
  }

  return assembleBody(preamble, sections);
}

export default {
  TRIPARTITE_SECTIONS,
  AGENT_MARKER,
  HUMAN_MARKER,
  splitBody,
  assembleBody,
  parseItems,
  formatAgentEntry,
  stripSourceMarkers,
  parseEntriesFromText,
  mergeSectionBody,
  normalizeDelta,
  applyDeltaToBody
};

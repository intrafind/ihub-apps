// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The library kit for HTML artifacts (#3822): a small, vetted, version-pinned
 * set of browser libraries that ships with iHub, so an artifact can use
 * Chart.js, D3 or Alpine.js without reaching a public CDN.
 *
 * An artifact asks for a library with a marker,
 *
 *     <script data-ihub-lib="chart.js"></script>
 *
 * and iHub replaces the marker with the library's source wherever the markup
 * leaves the store to run: the chat's preview, the share embed page, a
 * download and a ZIP. The stored file keeps the marker, so it stays small and
 * an edit of it never touches the library. The preview's Content Security
 * Policy stays as it is (`shared/artifactPreview.js`): the library is inline
 * script, and no origin is added.
 *
 * The files themselves live in `server/artifactLibraries/`, copied unchanged
 * from the npm package named here. `sha256` and `bytes` describe that file;
 * the server checks both before it hands a file out, and
 * `scripts/check-artifact-libraries.js` compares them with the package on
 * npm. A name is matched exactly against this list and never becomes a path.
 *
 * @module shared/artifactLibraries
 */

/** The attribute of a marker that asks for a kit library. */
export const ARTIFACT_LIBRARY_ATTRIBUTE = 'data-ihub-lib';

/** The attribute an inlined library carries instead, naming what was inlined. */
export const ARTIFACT_LIBRARY_INLINED_ATTRIBUTE = 'data-ihub-lib-inlined';

/**
 * Largest amount of library source one document gets inlined, in bytes. Each
 * library is inlined once however often it is asked for; the whole kit is
 * well below this, so the cap only guards a kit that grows.
 */
export const MAX_INLINED_LIBRARY_BYTES = 2 * 1024 * 1024;

/**
 * The kit. `id` is what a marker names; `global` is what the library defines
 * on `window`; `use` is what the model is told it is for.
 *
 * @type {ReadonlyArray<Readonly<{
 *   id: string, name: string, version: string, global: string, use: string,
 *   placement: 'anywhere'|'body', license: string, homepage: string,
 *   npm: { package: string, path: string }, file: string, bytes: number, sha256: string
 * }>>}
 */
export const ARTIFACT_LIBRARIES = Object.freeze(
  [
    {
      id: 'chart.js',
      name: 'Chart.js',
      version: '4.5.1',
      global: 'Chart',
      use: 'charts: line, bar, area, pie and doughnut, radar, polar area, scatter and bubble, with tooltips, legends and click events',
      placement: 'anywhere',
      license: 'MIT',
      homepage: 'https://www.chartjs.org',
      npm: { package: 'chart.js', path: 'dist/chart.umd.min.js' },
      file: 'chart.umd.min.js',
      bytes: 208522,
      sha256: '48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a'
    },
    {
      id: 'd3',
      name: 'D3',
      version: '7.9.0',
      global: 'd3',
      use: 'custom data visualizations in SVG: scales, axes, shapes, hierarchies (treemap, sunburst, tree), force layouts, Sankey-like flows built by hand, transitions',
      placement: 'anywhere',
      license: 'ISC',
      homepage: 'https://d3js.org',
      npm: { package: 'd3', path: 'dist/d3.min.js' },
      file: 'd3.min.js',
      bytes: 279706,
      sha256: 'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539'
    },
    {
      id: 'alpinejs',
      name: 'Alpine.js',
      version: '3.17.3',
      global: 'Alpine',
      use: 'declarative interactivity in the markup (x-data, x-model, x-show, x-for, @click) for forms, tabs, filters and small apps',
      placement: 'body',
      license: 'MIT',
      homepage: 'https://alpinejs.dev',
      npm: { package: 'alpinejs', path: 'dist/cdn.min.js' },
      file: 'alpinejs.cdn.min.js',
      bytes: 55886,
      sha256: '4d4b4bab885f9d2d4534099fe2bdc1234a30cf9dc6ee56869fc385f046cebd70'
    }
  ].map(library => Object.freeze({ ...library, npm: Object.freeze(library.npm) }))
);

const BY_ID = new Map(ARTIFACT_LIBRARIES.map(library => [library.id, library]));

/**
 * The kit library a marker value names, or why it names none. The value is
 * `id` or `id@version`, matched exactly (case-insensitive) against the kit: a
 * version must be the kit's own, since only that one ships.
 *
 * @param {unknown} ref - The marker's `data-ihub-lib` value.
 * @returns {{ library: object } | { error: 'unknown'|'version', id: string, version?: string }}
 */
export function resolveArtifactLibrary(ref) {
  const value = String(ref ?? '')
    .trim()
    .toLowerCase();
  const at = value.lastIndexOf('@');
  const id = at > 0 ? value.slice(0, at) : value;
  const version = at > 0 ? value.slice(at + 1) : null;
  const library = BY_ID.get(id);
  if (!library) return { error: 'unknown', id: value };
  if (version !== null && version !== library.version) {
    return { error: 'version', id, version };
  }
  return { library };
}

/** The kit library with this exact id, or null. */
export function artifactLibraryById(id) {
  return BY_ID.get(String(id ?? '')) || null;
}

// A marker: a <script> element with a data-ihub-lib attribute, its (empty) body
// and its end tag. The attribute value may be quoted either way or bare.
const MARKER_RE =
  /<script\b([^>]*?)\sdata-ihub-lib\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * Every library marker in a document, in order.
 *
 * @param {unknown} html
 * @returns {Array<{ start: number, end: number, ref: string, attributes: string,
 *   body: string, resolved: ReturnType<typeof resolveArtifactLibrary> }>}
 */
export function artifactLibraryMarkers(html) {
  const text = String(html ?? '');
  const markers = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const ref = match[2] ?? match[3] ?? match[4] ?? '';
    markers.push({
      start: match.index,
      end: match.index + match[0].length,
      ref,
      attributes: `${match[1]} ${match[5]}`.trim(),
      body: match[6],
      resolved: resolveArtifactLibrary(ref)
    });
  }
  return markers;
}

/** Whether a document asks for a kit library at all (cheap check before any work). */
export function hasArtifactLibraryMarker(html) {
  return String(html ?? '').includes(ARTIFACT_LIBRARY_ATTRIBUTE);
}

/**
 * The ids of the kit libraries a document asks for, each once, in order of
 * first use. Unknown names are left out.
 *
 * @param {unknown} html
 * @returns {string[]}
 */
export function requestedArtifactLibraries(html) {
  if (!hasArtifactLibraryMarker(html)) return [];
  const ids = [];
  for (const marker of artifactLibraryMarkers(html)) {
    const id = marker.resolved.library?.id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Make a library's source safe inside an inline `<script>` element: the HTML
 * parser ends the element at the first `</script`, whatever the JavaScript
 * around it. `<\/` means the same as `</` in a string, a template or a regular
 * expression, which is the only place the sequence occurs in valid code.
 *
 * @param {string} source
 * @returns {string}
 */
export function inlineScriptSource(source) {
  return String(source).replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Replace the library markers of a document with the libraries' source.
 *
 * - The first marker of a library gets its source; a later one for the same
 *   library is removed, so each library is inlined once.
 * - A marker naming nothing in the kit (or a version the kit does not ship)
 *   is removed: it would be an empty script anyway, and the tools report it
 *   when the artifact is written.
 * - Without a source for a known library (`sourceOf` returns nothing), or
 *   once `maxBytes` would be exceeded, the marker is removed as well and the
 *   library listed in `missing`.
 *
 * @param {unknown} html - The stored markup.
 * @param {(id: string) => string|null|undefined} sourceOf - A library's source by id.
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ html: string, inlined: string[], missing: string[] }}
 */
export function inlineArtifactLibraries(
  html,
  sourceOf,
  { maxBytes = MAX_INLINED_LIBRARY_BYTES } = {}
) {
  const text = String(html ?? '');
  if (!hasArtifactLibraryMarker(text)) return { html: text, inlined: [], missing: [] };
  const markers = artifactLibraryMarkers(text);
  if (!markers.length) return { html: text, inlined: [], missing: [] };
  const inlined = [];
  const missing = [];
  let used = 0;
  let out = '';
  let cursor = 0;
  for (const marker of markers) {
    out += text.slice(cursor, marker.start);
    cursor = marker.end;
    const library = marker.resolved.library;
    if (!library || inlined.includes(library.id) || missing.includes(library.id)) continue;
    const source = sourceOf(library.id);
    if (typeof source !== 'string' || !source || used + source.length > maxBytes) {
      missing.push(library.id);
      continue;
    }
    used += source.length;
    inlined.push(library.id);
    out +=
      `<script ${ARTIFACT_LIBRARY_INLINED_ATTRIBUTE}="${library.id}@${library.version}">` +
      `${inlineScriptSource(source)}\n</script>`;
  }
  out += text.slice(cursor);
  return { html: out, inlined, missing };
}

/**
 * How the kit is described to the model (tool description and findings): one
 * line per library with its marker, global and use.
 *
 * @returns {string}
 */
export function describeArtifactLibraries() {
  return ARTIFACT_LIBRARIES.map(
    library =>
      `${library.name} ${library.version} (<script ${ARTIFACT_LIBRARY_ATTRIBUTE}="${library.id}"></script>, defines ${library.global}): ${library.use}` +
      (library.placement === 'body' ? '; put its marker at the end of <body>' : '')
  ).join('; ');
}

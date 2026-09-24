/**
 * Release notes — the Markdown under `docs/releases/`.
 *
 * Layout (see `docs/releases/README.md`):
 *
 *   docs/releases/next/         entries that have not shipped in a tagged release yet
 *   docs/releases/<version>/    exactly what shipped in that release, frozen once published
 *
 * Every directory holds up to three files — `breaking-changes.md`, `features.md`, `fixes.md` —
 * and every file is one H1 title followed by `##` entries. This module is the single place that
 * knows that shape: the admin changelog endpoint, the release pipeline
 * (`scripts/finalize-release-notes.js`), the documentation export that feeds the iHub Support Bot
 * (`scripts/export-docs-markdown.js`) and their tests all read and write release notes through
 * it.
 *
 * Pure functions only. Nothing here touches the filesystem, so the release script can import it
 * from outside the server and the tests need no fixtures on disk.
 */

/** Directory name for entries that have not shipped yet. */
export const UNRELEASED_VERSION = 'next';

/** Human label used in the H1 of `next/` files in place of a version number. */
export const UNRELEASED_LABEL = 'Unreleased';

/**
 * The three sections of a release, in the order the changelog shows them. Breaking changes come
 * first because they are what an admin has to act on.
 */
export const RELEASE_SECTIONS = Object.freeze([
  Object.freeze({ key: 'breakingChanges', file: 'breaking-changes.md', title: 'Breaking Changes' }),
  Object.freeze({ key: 'features', file: 'features.md', title: 'Features' }),
  Object.freeze({ key: 'fixes', file: 'fixes.md', title: 'Fixes' })
]);

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Strip the `v` prefix release tags carry (`v5.5.7` → `5.5.7`).
 *
 * @param {string} tag
 * @returns {string}
 */
export function normalizeVersion(tag) {
  const value = String(tag ?? '').trim();
  return value.startsWith('v') || value.startsWith('V') ? value.slice(1) : value;
}

/**
 * Whether a directory name under `docs/releases/` is a release: `next` or a semver version with an
 * optional prerelease suffix (`5.4.0-RC1`). Anything else — a README, a stray folder — is ignored
 * by every reader, and the admin endpoint refuses it before touching the filesystem.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isReleaseVersionName(name) {
  return typeof name === 'string' && (name === UNRELEASED_VERSION || SEMVER_RE.test(name));
}

function comparePrereleaseIdentifiers(a, b) {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]) ? Number(pa[i]) : null;
    const nb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else if (na !== null) {
      return -1; // numeric identifiers sort before alphanumeric ones
    } else if (nb !== null) {
      return 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Semver-aware comparison, ascending: negative when `a` is the older version. A prerelease
 * (`5.4.0-RC1`) sorts before its release (`5.4.0`). Names that are not semver fall back to a plain
 * string comparison so the sort stays total.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const ma = SEMVER_RE.exec(normalizeVersion(a));
  const mb = SEMVER_RE.exec(normalizeVersion(b));
  if (!ma || !mb) {
    if (ma) return 1;
    if (mb) return -1;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) return diff;
  }
  if (ma[4] && !mb[4]) return -1;
  if (!ma[4] && mb[4]) return 1;
  if (ma[4] && mb[4]) return comparePrereleaseIdentifiers(ma[4], mb[4]);
  return 0;
}

/**
 * Order release directory names the way the changelog lists them: `next` first, then newest
 * release first.
 *
 * @param {string[]} names
 * @returns {string[]} a new array
 */
export function sortVersionsNewestFirst(names) {
  return [...names].sort((a, b) => {
    if (a === b) return 0;
    if (a === UNRELEASED_VERSION) return -1;
    if (b === UNRELEASED_VERSION) return 1;
    return compareVersions(b, a);
  });
}

/**
 * Turn an entry title into an anchor id: lower-case ASCII letters, digits and hyphens only.
 * Accents are folded, everything else becomes a hyphen. Never empty.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'entry';
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split one release-notes file into its entries.
 *
 * The file's first `# ` line is the title and is not an entry. Every top-level `## ` line starts an
 * entry whose body runs to the next one. Heading-looking lines inside fenced code blocks are
 * content, not headings. Text between the title and the first entry is kept as `preamble` so a
 * round trip through {@link renderReleaseNotes} loses nothing.
 *
 * Entry ids are unique within the file: a repeated title gets `-2`, `-3`, … appended.
 *
 * @param {string} markdown
 * @returns {{ title: string|null, preamble: string, entries: Array<{ id: string, title: string, body: string }> }}
 */
export function parseReleaseNotes(markdown) {
  const lines = String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  let title = null;
  const preambleLines = [];
  const rawEntries = [];
  let current = null;
  let openFence = null;

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!openFence) {
        openFence = fence[1];
      } else if (fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
        openFence = null;
      }
    } else if (!openFence) {
      if (line.startsWith('## ')) {
        current = { title: line.slice(3).trim(), lines: [] };
        rawEntries.push(current);
        continue;
      }
      if (!current && title === null && line.startsWith('# ')) {
        title = line.slice(2).trim();
        continue;
      }
    }
    if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  const seen = new Map();
  const entries = rawEntries.map(entry => {
    const base = slugify(entry.title);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return {
      id: count === 1 ? base : `${base}-${count}`,
      title: entry.title,
      body: entry.lines.join('\n').trim()
    };
  });

  return { title, preamble: preambleLines.join('\n').trim(), entries };
}

/**
 * Parse the three section files of one release directory.
 *
 * @param {Record<string, string>} filesByName file name (`features.md`, …) → Markdown; missing
 *   files may be absent or empty
 * @returns {Record<string, ReturnType<typeof parseReleaseNotes>>} keyed by section key
 */
export function parseReleaseSections(filesByName) {
  const sections = {};
  for (const section of RELEASE_SECTIONS) {
    sections[section.key] = parseReleaseNotes(filesByName?.[section.file] ?? '');
  }
  return sections;
}

/**
 * How many entries each section has, plus the total.
 *
 * @param {Record<string, { entries: unknown[] }>} sections as returned by {@link parseReleaseSections}
 * @returns {Record<string, number> & { total: number }}
 */
export function countEntries(sections) {
  const counts = { total: 0 };
  for (const section of RELEASE_SECTIONS) {
    const n = sections?.[section.key]?.entries?.length ?? 0;
    counts[section.key] = n;
    counts.total += n;
  }
  return counts;
}

/**
 * The H1 text of a release-notes file: `Features — 5.5.7`, or `Features — Unreleased` for `next`.
 *
 * @param {string} sectionTitle
 * @param {string} version
 * @returns {string}
 */
export function formatReleaseTitle(sectionTitle, version) {
  const label = version === UNRELEASED_VERSION ? UNRELEASED_LABEL : version;
  return `${sectionTitle} — ${label}`;
}

/**
 * Write a release-notes file back out: title, optional preamble, then one `##` entry per item,
 * each separated by a blank line. Output is normalised (one blank line between blocks, trailing
 * newline) so files the pipeline rewrites look like files people wrote.
 *
 * @param {{ sectionTitle: string, version: string, entries?: Array<{ title: string, body?: string }>, preamble?: string }} input
 * @returns {string}
 */
export function renderReleaseNotes({ sectionTitle, version, entries = [], preamble = '' }) {
  const blocks = [`# ${formatReleaseTitle(sectionTitle, version)}`];
  if (preamble && preamble.trim()) blocks.push(preamble.trim());
  for (const entry of entries) {
    const body = (entry.body ?? '').trim();
    blocks.push(body ? `## ${entry.title}\n\n${body}` : `## ${entry.title}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

const ATX_HEADING_RE = /^( {0,3})(#{1,6})(?=\s|$)/;

/**
 * Push every heading of a Markdown fragment down by `levels`, capped at `######`. Lines inside
 * fenced code blocks are content and stay as they are.
 *
 * @param {string} markdown
 * @param {number} levels
 * @returns {string}
 */
function demoteHeadings(markdown, levels) {
  let openFence = null;
  return String(markdown ?? '')
    .split('\n')
    .map(line => {
      const fence = FENCE_RE.exec(line);
      if (fence) {
        if (!openFence) {
          openFence = fence[1];
        } else if (fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
          openFence = null;
        }
        return line;
      }
      if (openFence) return line;
      return line.replace(ATX_HEADING_RE, (_, indent, hashes) => {
        return `${indent}${'#'.repeat(Math.min(hashes.length + levels, 6))}`;
      });
    })
    .join('\n');
}

const SECTION_NOUNS = Object.freeze({
  breakingChanges: ['breaking change', 'breaking changes'],
  features: ['feature', 'features'],
  fixes: ['fix', 'fixes']
});

/** `1 breaking change, 3 features, 2 fixes` — only the sections that have entries. */
function describeCounts(counts) {
  return RELEASE_SECTIONS.filter(section => counts[section.key] > 0)
    .map(section => {
      const [singular, plural] = SECTION_NOUNS[section.key];
      const n = counts[section.key];
      return `${n} ${n === 1 ? singular : plural}`;
    })
    .join(', ');
}

/**
 * Every release as one Markdown chapter, for the bundled "iHub Documentation" knowledge source
 * that `scripts/export-docs-markdown.js` builds. It is what lets the iHub Support Bot answer what a
 * release changed, fixed or broke, and what an upgrade across several releases brings in.
 *
 * Releases are listed the way the admin changelog lists them: `next` (not shipped in a tagged
 * release yet) first, then newest release first, and a release without a single entry is left
 * out. Each release is a `## ` heading, each section a `### `, each entry a `#### `; headings
 * inside an entry body are pushed down to stay beneath their entry.
 *
 * @param {Array<{ version: string, sections: Record<string, { entries: Array<{ title: string, body?: string }> }> }>} releases
 *   one item per release directory, `sections` as returned by {@link parseReleaseSections}; any
 *   order
 * @param {{ currentVersion?: string }} [options] the version this documentation ships with
 * @returns {string} the chapter, ending in a newline; '' when no release has an entry
 */
export function renderReleaseNotesChapter(releases, { currentVersion } = {}) {
  const byVersion = new Map((releases ?? []).map(release => [release.version, release]));
  const withEntries = sortVersionsNewestFirst([...byVersion.keys()])
    .map(version => ({
      ...byVersion.get(version),
      counts: countEntries(byVersion.get(version).sections)
    }))
    .filter(release => release.counts.total > 0);
  if (withEntries.length === 0) return '';

  const heading = release =>
    release.version === UNRELEASED_VERSION ? UNRELEASED_LABEL : `Version ${release.version}`;

  const intro = [
    'What every iHub Apps release changed — its breaking changes, new features and fixes — newest release first.',
    currentVersion ? `This documentation ships with version ${currentVersion}.` : null,
    'Upgrading brings in every release after the installed version, up to and including the target version: check the breaking changes of each of them before upgrading.'
  ]
    .filter(Boolean)
    .join(' ');

  const blocks = ['# Release Notes', intro];
  blocks.push(
    withEntries
      .map(release => `- ${heading(release)}: ${describeCounts(release.counts)}`)
      .join('\n')
  );

  for (const release of withEntries) {
    blocks.push(`## ${heading(release)}`);
    if (release.version === UNRELEASED_VERSION) {
      blocks.push('Changes that have not shipped in a tagged release yet.');
    }
    for (const section of RELEASE_SECTIONS) {
      const entries = release.sections[section.key]?.entries ?? [];
      if (entries.length === 0) continue;
      blocks.push(`### ${section.title}`);
      for (const entry of entries) {
        const body = demoteHeadings((entry.body ?? '').trim(), 2);
        blocks.push(body ? `#### ${entry.title}\n\n${body}` : `#### ${entry.title}`);
      }
    }
  }

  return `${blocks.join('\n\n')}\n`;
}

const normalizeTitle = title =>
  String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * The entries of `entries` whose title does not appear in `released`. Used when a release is
 * published from `next/`: what shipped moves under the tag, and only what landed afterwards stays
 * unreleased. Matching is by title, case- and whitespace-insensitively.
 *
 * @param {Array<{ title: string }>} entries
 * @param {Array<{ title: string }>} released
 * @returns {Array<{ title: string }>}
 */
export function subtractEntries(entries, released) {
  const gone = new Set((released ?? []).map(entry => normalizeTitle(entry.title)));
  return (entries ?? []).filter(entry => !gone.has(normalizeTitle(entry.title)));
}

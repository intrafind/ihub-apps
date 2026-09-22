/**
 * @jest-environment node
 */

/**
 * `server/utils/releaseNotes.js` is the one place that knows the shape of `docs/releases/`: the
 * admin changelog endpoint, the release pipeline and the page all rely on it splitting a file into
 * the right entries and ordering versions the way releases happened.
 */
import { describe, expect, test } from '@jest/globals';
import {
  RELEASE_SECTIONS,
  UNRELEASED_VERSION,
  compareVersions,
  countEntries,
  formatReleaseTitle,
  isReleaseVersionName,
  normalizeVersion,
  parseReleaseNotes,
  parseReleaseSections,
  renderReleaseNotes,
  slugify,
  sortVersionsNewestFirst,
  subtractEntries
} from '../../../server/utils/releaseNotes.js';

const FEATURES = `# Features — 5.5.7

## Artifacts: What a Run Produced, Kept

Every run keeps its artifacts.

- Downloadable from the run page
- Kept for 30 days

### Configuration

\`\`\`json
{ "artifacts": { "retentionDays": 30 } }
\`\`\`

## Grant \`tools\` to a Group

Groups can carry a \`tools\` permission.

\`\`\`markdown
## Not an entry — this heading is inside a code fence
\`\`\`

> Quoted error text
`;

describe('parseReleaseNotes', () => {
  test('splits a file into its title and ## entries, keeping ### and fenced headings in the body', () => {
    const parsed = parseReleaseNotes(FEATURES);

    expect(parsed.title).toBe('Features — 5.5.7');
    expect(parsed.preamble).toBe('');
    expect(parsed.entries.map(entry => entry.title)).toEqual([
      'Artifacts: What a Run Produced, Kept',
      'Grant `tools` to a Group'
    ]);
    expect(parsed.entries[0].body).toContain('### Configuration');
    expect(parsed.entries[0].body).toContain('"retentionDays": 30');
    expect(parsed.entries[1].body).toContain('## Not an entry');
    expect(parsed.entries[1].body).toContain('> Quoted error text');
    expect(parsed.entries[1].body.endsWith('\n')).toBe(false);
  });

  test('derives anchor ids from titles and keeps them unique within the file', () => {
    const parsed = parseReleaseNotes(
      '# Fixes\n\n## Footer Fits\n\na\n\n## Footer Fits\n\nb\n\n## Ünïcode & Co.\n'
    );

    expect(parsed.entries.map(entry => entry.id)).toEqual([
      'footer-fits',
      'footer-fits-2',
      'unicode-co'
    ]);
  });

  test('keeps text between the title and the first entry as preamble', () => {
    const parsed = parseReleaseNotes('# Fixes — next\n\nIntro line.\n\n## One\n\nbody\n');

    expect(parsed.preamble).toBe('Intro line.');
    expect(parsed.entries).toHaveLength(1);
  });

  test('handles CRLF, missing titles and empty input', () => {
    expect(parseReleaseNotes('## A\r\n\r\nline one\r\nline two\r\n').entries[0].body).toBe(
      'line one\nline two'
    );
    expect(parseReleaseNotes('## A\n\nbody\n').title).toBeNull();
    expect(parseReleaseNotes('').entries).toEqual([]);
    expect(parseReleaseNotes(undefined).entries).toEqual([]);
    expect(parseReleaseNotes('# Fixes — Unreleased\n').entries).toEqual([]);
  });
});

describe('version names and ordering', () => {
  test('accepts next and semver directory names only', () => {
    for (const name of ['next', '5.5.7', '5.4.0-RC1', '10.0.0-beta.2']) {
      expect(isReleaseVersionName(name)).toBe(true);
    }
    for (const name of ['README.md', '..', '.', '5.5', 'v5.5.7', 'next/', '5.5.7/../x', '', null]) {
      expect(isReleaseVersionName(name)).toBe(false);
    }
  });

  test('strips the tag prefix', () => {
    expect(normalizeVersion('v5.5.7')).toBe('5.5.7');
    expect(normalizeVersion(' 5.5.7 ')).toBe('5.5.7');
    expect(normalizeVersion(undefined)).toBe('');
  });

  test('compares numerically, with prereleases before their release', () => {
    expect(compareVersions('5.4.9', '5.4.10')).toBeLessThan(0);
    expect(compareVersions('5.4.0-RC1', '5.4.0')).toBeLessThan(0);
    expect(compareVersions('5.4.0-RC1', '5.4.0-RC2')).toBeLessThan(0);
    expect(compareVersions('5.4.0-beta.2', '5.4.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('v5.5.7', '5.5.7')).toBe(0);
    expect(compareVersions('5.5.7', '5.6.0')).toBeLessThan(0);
  });

  test('sorts next first, then newest release first', () => {
    expect(
      sortVersionsNewestFirst(['5.4.0', 'next', '5.5.7', '5.4.0-RC1', '5.4.10', '5.4.9'])
    ).toEqual(['next', '5.5.7', '5.4.10', '5.4.9', '5.4.0', '5.4.0-RC1']);
  });
});

describe('rendering and publishing helpers', () => {
  test('renders a file that parses back to the same entries', () => {
    const parsed = parseReleaseNotes(FEATURES);
    const rendered = renderReleaseNotes({
      sectionTitle: 'Features',
      version: '5.5.7',
      entries: parsed.entries
    });

    expect(rendered.startsWith('# Features — 5.5.7\n\n## Artifacts')).toBe(true);
    expect(rendered.endsWith('\n')).toBe(true);
    expect(parseReleaseNotes(rendered).entries).toEqual(parsed.entries);
  });

  test('labels next as Unreleased and keeps the preamble', () => {
    expect(formatReleaseTitle('Fixes', UNRELEASED_VERSION)).toBe('Fixes — Unreleased');
    const rendered = renderReleaseNotes({
      sectionTitle: 'Fixes',
      version: UNRELEASED_VERSION,
      entries: [{ title: 'Only Title' }],
      preamble: 'Intro'
    });
    expect(rendered).toBe('# Fixes — Unreleased\n\nIntro\n\n## Only Title\n');
  });

  test('subtracts released entries by title, ignoring case and whitespace', () => {
    const remaining = subtractEntries(
      [{ title: 'Kept' }, { title: 'Shipped  Feature' }, { title: 'also shipped' }],
      [{ title: 'shipped feature' }, { title: 'Also Shipped' }]
    );
    expect(remaining).toEqual([{ title: 'Kept' }]);
  });

  test('parses the section files of a release and counts entries', () => {
    const sections = parseReleaseSections({
      'features.md': FEATURES,
      'fixes.md': '# Fixes — 5.5.7\n\n## One Fix\n\nbody\n'
      // no breaking-changes.md
    });

    expect(Object.keys(sections)).toEqual(RELEASE_SECTIONS.map(section => section.key));
    expect(countEntries(sections)).toEqual({ total: 3, breakingChanges: 0, features: 2, fixes: 1 });
    expect(countEntries(parseReleaseSections({}))).toEqual({
      total: 0,
      breakingChanges: 0,
      features: 0,
      fixes: 0
    });
  });

  test('slugify never returns an empty id', () => {
    expect(slugify('!!!')).toBe('entry');
    expect(slugify('  `code` Title ')).toBe('code-title');
  });
});

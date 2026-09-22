/**
 * The release list of What's New groups releases the way they are numbered so a long-lived
 * installation does not get a sidebar of thirty patch versions. These are the pure functions
 * behind that: the tree itself, which groups start open, and the per-group cap.
 */
import {
  MAX_VISIBLE_RELEASES_PER_GROUP,
  buildReleaseTree,
  defaultExpandedGroups,
  visibleReleases
} from '../../../client/src/features/admin/utils/changelogReleaseTree';

/** The index as the server hands it over: newest first, unreleased ahead of the releases. */
const release = (version, extra = {}) => ({ version, unreleased: false, ...extra });

const INDEX = [
  { version: 'next', unreleased: true },
  release('5.6.0', { isNew: true }),
  release('5.5.2', { isNew: true }),
  release('5.5.1', { isNew: true, installed: true }),
  release('5.5.0'),
  release('5.4.2'),
  release('4.9.1')
];

describe('buildReleaseTree', () => {
  test('groups releases by major and minor, newest first, unreleased on its own', () => {
    const tree = buildReleaseTree(INDEX);

    expect(tree.unreleased.map(item => item.version)).toEqual(['next']);
    expect(tree.majors.map(major => major.key)).toEqual(['5', '4']);
    expect(tree.majors[0].minors.map(minor => minor.key)).toEqual(['5.6', '5.5', '5.4']);
    expect(tree.majors[0].minors[1].releases.map(item => item.version)).toEqual([
      '5.5.2',
      '5.5.1',
      '5.5.0'
    ]);
  });

  test('counts the releases and the new ones at both levels', () => {
    const [five, four] = buildReleaseTree(INDEX).majors;

    expect(five).toMatchObject({ count: 5, newCount: 3 });
    expect(five.minors.map(minor => [minor.key, minor.count, minor.newCount])).toEqual([
      ['5.6', 1, 1],
      ['5.5', 3, 2],
      ['5.4', 1, 0]
    ]);
    expect(four).toMatchObject({ count: 1, newCount: 0 });
  });

  test('keeps a version that is not major.minor rather than dropping it', () => {
    const tree = buildReleaseTree([release('nightly')]);

    expect(tree.majors.map(major => major.key)).toEqual(['nightly']);
    expect(tree.majors[0].minors[0].releases.map(item => item.version)).toEqual(['nightly']);
  });

  test('handles an empty index', () => {
    expect(buildReleaseTree([])).toEqual({ unreleased: [], majors: [] });
    expect(buildReleaseTree(undefined)).toEqual({ unreleased: [], majors: [] });
  });
});

describe('defaultExpandedGroups', () => {
  test('opens the groups holding the installed release and the selection', () => {
    const tree = buildReleaseTree(INDEX);

    expect([...defaultExpandedGroups(tree, { selected: '5.4.2' })].sort()).toEqual([
      '5',
      '5.4',
      '5.5'
    ]);
  });

  test('leaves a group of new releases shut — its header carries the count', () => {
    const tree = buildReleaseTree(INDEX);

    // 5.6.0 is new but neither installed nor selected, so 5.6.x stays closed.
    expect(defaultExpandedGroups(tree, { selected: '5.5.1' }).has('5.6')).toBe(false);
  });

  test('falls back to the newest group when nothing is installed or selected', () => {
    const tree = buildReleaseTree([release('5.5.0'), release('5.4.2'), release('4.9.1')]);

    expect([...defaultExpandedGroups(tree, { selected: null })].sort()).toEqual(['5', '5.5']);
  });

  test('opens nothing when there is nothing to open', () => {
    expect(defaultExpandedGroups(buildReleaseTree([])).size).toBe(0);
  });
});

describe('visibleReleases', () => {
  const many = Array.from({ length: 17 }, (_, i) => release(`5.4.${16 - i}`));
  const minor = buildReleaseTree(many).majors[0].minors[0];

  test('shows the newest ten and keeps the rest behind a count', () => {
    const { releases, hidden } = visibleReleases(minor);

    expect(releases).toHaveLength(MAX_VISIBLE_RELEASES_PER_GROUP);
    expect(releases[0].version).toBe('5.4.16');
    expect(hidden).toBe(7);
  });

  test('shows everything once asked', () => {
    expect(visibleReleases(minor, { showAll: true })).toEqual({
      releases: minor.releases,
      hidden: 0
    });
  });

  test('keeps the release being shown visible even when it sits below the cut', () => {
    const { releases, hidden } = visibleReleases(minor, { selected: '5.4.0' });

    expect(releases.map(item => item.version)).toContain('5.4.0');
    expect(releases).toHaveLength(MAX_VISIBLE_RELEASES_PER_GROUP + 1);
    expect(hidden).toBe(6);
  });

  test('leaves a short group alone', () => {
    const short = buildReleaseTree([release('5.5.1'), release('5.5.0')]).majors[0].minors[0];

    expect(visibleReleases(short)).toEqual({ releases: short.releases, hidden: 0 });
  });
});

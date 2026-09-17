/**
 * The release list of What's New, as a tree.
 *
 * A long-lived installation accumulates releases faster than a flat list can carry: 25 patch
 * releases scroll a sidebar past anything an admin can scan. The switcher therefore groups them
 * the way versions are numbered — `5.x` holds `5.5.x` holds `5.5.8` — and opens only the groups
 * that have something to say.
 *
 * Pure functions over the index the server returns (already sorted newest first, unreleased
 * ahead of the tagged releases); the order of that list is preserved at every level.
 */

/** How many releases one minor group shows before it offers to show the rest. */
export const MAX_VISIBLE_RELEASES_PER_GROUP = 10;

/**
 * The major and minor number of a release version. Returns `null` for anything that is not
 * `<major>.<minor>…` — the server only lists semver directories, but a hand-made `docs/releases/`
 * entry should not take the page down.
 *
 * @param {string} version
 * @returns {{ major: string, minor: string }|null}
 */
function parseSeries(version) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(String(version ?? ''));
  return match ? { major: match[1], minor: match[2] } : null;
}

/**
 * Group the release index into `unreleased` plus a major → minor → releases tree.
 *
 * Releases whose version is not `<major>.<minor>` keep their own single-release group rather than
 * disappearing.
 *
 * @param {Array<{ version: string, unreleased?: boolean, isNew?: boolean, installed?: boolean }>} versions
 * @returns {{ unreleased: Array<object>, majors: Array<{ key: string, major: string, count: number, newCount: number, minors: Array<{ key: string, major: string, minor: string, count: number, newCount: number, releases: Array<object> }> }> }}
 */
export function buildReleaseTree(versions) {
  const unreleased = [];
  const majors = [];
  const majorsByKey = new Map();

  for (const release of versions ?? []) {
    if (release.unreleased) {
      unreleased.push(release);
      continue;
    }

    const series = parseSeries(release.version);
    const majorKey = series ? series.major : release.version;
    const minorKey = series ? `${series.major}.${series.minor}` : release.version;

    let major = majorsByKey.get(majorKey);
    if (!major) {
      major = {
        key: majorKey,
        major: majorKey,
        count: 0,
        newCount: 0,
        minors: [],
        minorsByKey: new Map()
      };
      majorsByKey.set(majorKey, major);
      majors.push(major);
    }

    let minor = major.minorsByKey.get(minorKey);
    if (!minor) {
      minor = {
        key: minorKey,
        major: majorKey,
        minor: series ? series.minor : null,
        count: 0,
        newCount: 0,
        releases: []
      };
      major.minorsByKey.set(minorKey, minor);
      major.minors.push(minor);
    }

    minor.releases.push(release);
    minor.count += 1;
    major.count += 1;
    if (release.isNew) {
      minor.newCount += 1;
      major.newCount += 1;
    }
  }

  return {
    unreleased,
    majors: majors.map(({ minorsByKey: _ignored, ...major }) => major)
  };
}

/**
 * The groups that start open: the one holding the selected release, the one holding the installed
 * release, and — so the tree is never entirely shut — the newest one. Both the major and the minor
 * key of each are returned, because opening a minor group only helps when its major is open too.
 *
 * A group full of releases the last upgrade brought in is deliberately *not* opened: an upgrade
 * that spans two minor series would otherwise unfold into the same long list the tree exists to
 * replace. Its header carries the count of new releases instead, one click away.
 *
 * @param {ReturnType<typeof buildReleaseTree>} tree
 * @param {{ selected?: string|null }} [options]
 * @returns {Set<string>} group keys (`'5'`, `'5.5'`)
 */
export function defaultExpandedGroups(tree, { selected = null } = {}) {
  const expanded = new Set();
  const open = minor => {
    expanded.add(minor.major);
    expanded.add(minor.key);
  };

  let newest = null;
  for (const major of tree.majors) {
    for (const minor of major.minors) {
      if (!newest) newest = minor;
      if (minor.releases.some(release => release.installed || release.version === selected)) {
        open(minor);
      }
    }
  }
  if (expanded.size === 0 && newest) open(newest);
  return expanded;
}

/**
 * How many releases of a minor group to render: all of them once the group has been expanded past
 * the cap, the newest {@link MAX_VISIBLE_RELEASES_PER_GROUP} otherwise — except that a release the
 * page is showing stays visible even when it sits below the cut.
 *
 * @param {{ releases: Array<{ version: string }> }} minor
 * @param {{ showAll?: boolean, selected?: string|null }} [options]
 * @returns {{ releases: Array<object>, hidden: number }}
 */
export function visibleReleases(minor, { showAll = false, selected = null } = {}) {
  const all = minor.releases;
  if (showAll || all.length <= MAX_VISIBLE_RELEASES_PER_GROUP) {
    return { releases: all, hidden: 0 };
  }
  const releases = all.slice(0, MAX_VISIBLE_RELEASES_PER_GROUP);
  const selectedRelease = all.find(release => release.version === selected);
  if (selectedRelease && !releases.includes(selectedRelease)) releases.push(selectedRelease);
  return { releases, hidden: all.length - releases.length };
}

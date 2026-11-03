// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import semver from 'semver';

/**
 * Which version of a catalog item a registry offers this server (versioning
 * concept §5, phase 3): the registry's `channel` and the item's `pin`.
 *
 * A catalog item lists its current `version` and, optionally, the versions it
 * can still serve (`versions: [{ version, ref }]`). The registry config of
 * this server narrows that list:
 *
 * - `channel: 'stable'` (the default) offers no pre-release (`2.0.0-rc.1`);
 *   `'all'` offers every listed version;
 * - `pins['<type>:<name>']` is a semver range (`1.3.x`, `~1.3.0`, `<2`): only
 *   versions inside it are offered.
 *
 * The offered version is the newest listed version that passes both. Install
 * and update take it when no version is named, the update badge appears only
 * when it is newer than the installed one, and a named version must pass
 * both too. An item whose version is not semver (apps, prompts of older
 * catalogs) has no channel: its one version is offered unless it is pinned.
 *
 * Pure: no I/O.
 *
 * @module services/marketplace/versionPolicy
 */

/** The channels a registry can follow. */
export const REGISTRY_CHANNELS = Object.freeze(['stable', 'all']);

/** The channel a registry follows when its config names none. */
export const DEFAULT_CHANNEL = 'stable';

/**
 * The key of an item in a registry's `pins`: `<type>:<name>`, the same key
 * the installation manifest uses.
 *
 * @param {string} type
 * @param {string} name
 * @returns {string}
 */
export function pinKey(type, name) {
  return `${type}:${name}`;
}

/**
 * The channel and the pin a registry sets for one item.
 *
 * @param {{ channel?: string, pins?: Record<string, string> }|null|undefined} registry
 * @param {string} type
 * @param {string} name
 * @returns {{ channel: 'stable'|'all', pin: string|null }}
 */
export function versionPolicyFor(registry, type, name) {
  const channel = REGISTRY_CHANNELS.includes(registry?.channel)
    ? registry.channel
    : DEFAULT_CHANNEL;
  const pin = registry?.pins?.[pinKey(type, name)];
  return { channel, pin: typeof pin === 'string' && pin.trim() ? pin.trim() : null };
}

/**
 * Every version a catalog item lists, newest first, each once: its `version`
 * and those of `versions[]`. Versions that are not semver are kept only when
 * no listed version is (an item of an older catalog).
 *
 * @param {{ version?: string, versions?: Array<{ version?: string }> }} item
 * @returns {string[]}
 */
export function listedVersions(item) {
  const all = [
    item?.version,
    ...(Array.isArray(item?.versions) ? item.versions : []).map(v => v?.version)
  ]
    .filter(v => typeof v === 'string' && v)
    .filter((v, i, list) => list.indexOf(v) === i);
  const valid = all.filter(v => semver.valid(v));
  if (valid.length === 0) return all.slice(0, 1);
  return valid.sort((a, b) => semver.rcompare(a, b));
}

/**
 * Whether one version passes a registry's channel and pin.
 *
 * @param {string} version
 * @param {{ channel: string, pin: string|null }} policy
 * @returns {boolean}
 */
export function passesPolicy(version, { channel, pin }) {
  if (!semver.valid(version)) return !pin;
  const includePrerelease = channel === 'all';
  if (!includePrerelease && semver.prerelease(version)) return false;
  if (!pin) return true;
  if (semver.validRange(pin, { includePrerelease }) === null) return false;
  return semver.satisfies(version, pin, { includePrerelease });
}

/**
 * The version a registry offers of a catalog item: the newest listed one
 * that passes the channel and the pin, or null when none does.
 *
 * @param {object} item - catalog item
 * @param {{ channel?: string, pins?: Record<string, string> }|null|undefined} registry
 * @returns {string|null}
 */
export function offeredVersion(item, registry) {
  const policy = versionPolicyFor(registry, item?.type, item?.name);
  return listedVersions(item).find(version => passesPolicy(version, policy)) || null;
}

/**
 * The catalog fields the admin marketplace shows next to an item: the
 * version offered, the channel and the pin that decided it.
 *
 * @param {object} item - catalog item
 * @param {object|null|undefined} registry - registry config
 * @returns {{ offeredVersion: string|null, channel: string, pin: string|null, availableVersions: string[] }}
 */
export function versionPolicyFields(item, registry) {
  const policy = versionPolicyFor(registry, item?.type, item?.name);
  const available = listedVersions(item).filter(version => passesPolicy(version, policy));
  return {
    offeredVersion: available[0] || null,
    channel: policy.channel,
    pin: policy.pin,
    availableVersions: available
  };
}

/**
 * Whether a version is newer than another (semver when both are, otherwise
 * "differs"), for the update badge.
 *
 * @param {string|null|undefined} candidate
 * @param {string|null|undefined} installed
 * @returns {boolean}
 */
export function isUpdate(candidate, installed) {
  if (!candidate || !installed) return false;
  if (semver.valid(candidate) && semver.valid(installed)) return semver.gt(candidate, installed);
  return candidate !== installed;
}

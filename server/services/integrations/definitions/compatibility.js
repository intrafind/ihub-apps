// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import semver from 'semver';
import { getAppVersion } from '../../../utils/versionHelper.js';

/**
 * Compatibility of an integration definition (or a marketplace catalog item)
 * with the running iHub: `compatibility.ihub` is a semver range the server
 * version must satisfy (`">=5.7.0 <7"`). A catalog item may still carry the
 * older short form `minVersion`, read as `>=minVersion`.
 *
 * The server version comes from the root `package.json` (or `version.txt` in
 * a packaged build) through `getAppVersion`; prereleases compare with
 * `includePrerelease`, so `5.7.0-rc.1` satisfies `>=5.7.0-0` and a definition
 * that needs `>=5.7.0` is offered on the release candidate too.
 */

let cachedServerVersion;

/**
 * The server's version as a valid semver string, or null when it cannot be
 * parsed (a development checkout with an unusual `version.txt`).
 * @returns {string|null}
 */
export function serverVersion() {
  if (cachedServerVersion === undefined) {
    cachedServerVersion = normalizeVersion(getAppVersion());
  }
  return cachedServerVersion;
}

/** For tests: forget the cached server version. */
export function resetServerVersionCache() {
  cachedServerVersion = undefined;
}

/**
 * `5.7.0`, `v5.7.0`, `5.7.0-rc.1`, `5.7` → a valid semver string; null otherwise.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeVersion(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const direct = semver.valid(value.trim(), { loose: true });
  if (direct) return direct;
  const coerced = semver.coerce(value, { includePrerelease: true });
  return coerced ? coerced.version : null;
}

/**
 * The range a definition or catalog item requires, or null when it runs on
 * every version: `compatibility.ihub`, else `>=minVersion`.
 * @param {{ compatibility?: { ihub?: string }, minVersion?: string }} [subject]
 * @returns {string|null}
 */
export function requiredRange(subject) {
  const range = subject?.compatibility?.ihub;
  if (typeof range === 'string' && range.trim()) return range.trim();
  const minVersion = subject?.minVersion;
  if (typeof minVersion === 'string' && minVersion.trim()) {
    const normalized = normalizeVersion(minVersion);
    return normalized ? `>=${normalized}` : null;
  }
  return null;
}

/**
 * Whether `version` (the server's by default) satisfies `range`. No range
 * means compatible; an unparseable server version is treated as compatible,
 * since refusing every definition would help nobody. An invalid range is
 * incompatible: the definition asks for something this server cannot read.
 *
 * @param {string|null|undefined} range
 * @param {string|null} [version]
 * @returns {boolean}
 */
export function satisfiesRange(range, version = serverVersion()) {
  if (!range) return true;
  if (!version) return true;
  if (semver.validRange(range, { includePrerelease: true }) === null) return false;
  return semver.satisfies(version, range, { includePrerelease: true });
}

/**
 * The compatibility verdict for a definition or catalog item.
 *
 * @param {{ compatibility?: { ihub?: string }, minVersion?: string }} [subject]
 * @param {string|null} [version] - the server version (default: the running one)
 * @returns {{ requires: string|null, compatible: boolean, serverVersion: string|null }}
 */
export function checkCompatibility(subject, version = serverVersion()) {
  const requires = requiredRange(subject);
  return { requires, compatible: satisfiesRange(requires, version), serverVersion: version };
}

/**
 * One line for admins and error messages: "needs iHub >=6.0.0, this server runs 5.7.2".
 * @param {string} requires
 * @param {string|null} [version]
 * @returns {string}
 */
export function describeIncompatibility(requires, version = serverVersion()) {
  return `needs iHub ${requires}, this server runs ${version || 'an unknown version'}`;
}

/**
 * Whether `candidate` is a newer version than `current` (both semver; a
 * missing or unparseable side is never newer).
 * @param {string|null|undefined} candidate
 * @param {string|null|undefined} current
 * @returns {boolean}
 */
export function isNewerVersion(candidate, current) {
  const a = normalizeVersion(candidate);
  const b = normalizeVersion(current);
  if (!a || !b) return false;
  return semver.gt(a, b);
}

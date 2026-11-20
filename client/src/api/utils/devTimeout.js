// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A request timeout a development build may shorten for a test. Kept apart from
 * its one caller (`chatPostConfig` in `api/endpoints/apps.js`) so the rule can
 * be tested without a build: that caller reads `import.meta.env`.
 *
 * @module api/utils/devTimeout
 */

/**
 * The timeout to use instead of a client's own, or `undefined` to keep that.
 * Only a number of milliseconds greater than zero and below the client's own
 * timeout counts: the value can shorten a timeout, never lengthen or remove it
 * (axios reads `0` as "no timeout").
 *
 * @param {*} override - What the test set; anything else is ignored
 * @param {number} ceiling - The client's own timeout in milliseconds
 * @returns {number|undefined}
 *
 * @example
 * shortenedTimeout(3000, 300000); // 3000
 * shortenedTimeout(0, 300000); // undefined
 * shortenedTimeout(900000, 300000); // undefined
 */
export function shortenedTimeout(override, ceiling) {
  return Number.isFinite(override) && override > 0 && override < ceiling ? override : undefined;
}

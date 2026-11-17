// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { buildPath } from './runtimeBasePath';

/**
 * The absolute URL of a short link, including the deployment base path, e.g.
 * `https://host/ihub/s/abc` when iHub runs under `/ihub`.
 *
 * Use it wherever a short link is copied, opened or shown: a URL built from
 * `window.location.origin` alone leaves the base path out and 404s on a
 * subpath deployment.
 *
 * @param {string} code - The short code
 * @returns {string}
 */
export function shortLinkUrl(code) {
  return `${window.location.origin}${buildPath(`/s/${encodeURIComponent(code)}`)}`;
}

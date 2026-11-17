// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where a short link built from an app or a path leads, shared by the server
 * (which stores it as the link's `url`) and the admin editor (which shows it
 * as a preview before saving).
 *
 * The path is the link's `path`, else `/apps/{appId}`, else `/`. The link's
 * `params` become the query string when `includeParams` is on; empty values
 * are left out.
 *
 * @example
 * buildShortLinkTarget({ appId: 'chat', params: { prefill: 'Hi' }, includeParams: true });
 * // → '/apps/chat?prefill=Hi'
 *
 * @param {Object} link
 * @param {string} [link.appId] - The app the link opens
 * @param {string} [link.path] - A path on this server; wins over `appId`
 * @param {Object} [link.params] - Query parameters, e.g. `{ prefill: '…' }`
 * @param {boolean} [link.includeParams] - Whether `params` are added
 * @returns {string} A path on this server, without the deployment base path
 */
export function buildShortLinkTarget({ appId, path, params, includeParams } = {}) {
  const basePath = path || (appId ? `/apps/${appId}` : '/');
  const target = new URL('http://localhost');
  target.pathname = basePath;
  if (includeParams && params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        target.searchParams.set(key, String(value));
      }
    }
  }
  return target.pathname + (target.search ? `?${target.searchParams.toString()}` : '');
}

/**
 * Whether `params` holds at least one value that would reach the link.
 *
 * @param {unknown} params
 * @returns {boolean}
 */
export function hasShortLinkParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  return Object.values(params).some(v => v !== undefined && v !== null && v !== '');
}

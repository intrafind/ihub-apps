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

/**
 * Where a visitor of `/s/<code>` lands: a path on this server gets the
 * deployment base path in front (`/apps/chat` → `/ihub/apps/chat` under
 * `/ihub`), unless it already starts with it; a link to another host is left
 * as it is. Used by the server for the redirect and by the admin editor for
 * its "Opens:" preview, so both say the same.
 *
 * The base path `/` means none. The result never starts with `//`, which a
 * browser would read as another host.
 *
 * Because "already starts with the base path" is a plain prefix test, a
 * deployment base path that equals an iHub route (`/apps`, `/s`, `/pages`)
 * makes built targets under that route look prefixed; see docs/platform.md.
 *
 * @example
 * shortLinkLocation('/apps/chat', '/ihub'); // → '/ihub/apps/chat'
 * shortLinkLocation('/ihub/apps/chat', '/ihub'); // → '/ihub/apps/chat'
 * shortLinkLocation('/evil.com/x', '/'); // → '/evil.com/x'
 *
 * @param {string} target - The link's stored `url`
 * @param {string} basePath - The deployment base path, '' at the root
 * @returns {string}
 */
export function shortLinkLocation(target, basePath) {
  if (!basePath || basePath === '/' || !target.startsWith('/') || target.startsWith('//')) {
    return target;
  }
  const alreadyPrefixed =
    target === basePath ||
    target.startsWith(`${basePath}/`) ||
    target.startsWith(`${basePath}?`) ||
    target.startsWith(`${basePath}#`);
  const location = alreadyPrefixed ? target : `${basePath}${target}`;
  return location.startsWith('//') ? target : location;
}

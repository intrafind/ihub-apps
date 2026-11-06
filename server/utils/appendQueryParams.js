// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Add query parameters to a URL that may be relative and may carry a fragment.
 *
 * `${url}?a=b` goes wrong as soon as the URL has a `#fragment`: the parameters
 * land inside the fragment, where neither the server nor `location.search` sees
 * them. That is how a sign-in that started on `/page#section` came back as
 * `/page#section?oidc=success`, and the auth gate never noticed the sign-in.
 * The parameters go in front of the fragment instead, after whatever query the
 * URL already has.
 *
 * @param {string} url - Absolute (`https://host/path?x=1#y`) or relative (`/path#y`)
 * @param {Record<string, string>} params - Values are URL-encoded here
 * @returns {string}
 */
export function appendQueryParams(url, params) {
  const query = new URLSearchParams(params).toString();
  if (!query) return url;

  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);

  let separator = '?';
  if (beforeHash.includes('?')) {
    separator = beforeHash.endsWith('?') || beforeHash.endsWith('&') ? '' : '&';
  }
  return `${beforeHash}${separator}${query}${hash}`;
}

export default appendQueryParams;

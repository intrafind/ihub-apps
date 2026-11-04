// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The anchor mdBook gives a heading: lower-case, letters/digits/`_`/`-` kept, whitespace to `-`,
 * everything else dropped. The docs and the release notes link to `page.md#fragment` with these
 * fragments, so the server's search results and the admin docs viewer's heading ids both use it.
 *
 * @param {string} text heading text; inline Markdown links and HTML tags are reduced to their text
 * @returns {string}
 */
export function headingAnchor(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * A per-document anchor generator: the second heading with the same anchor gets `-1`, the third
 * `-2`, as in mdBook.
 *
 * @returns {(text: string) => string}
 */
export function createAnchorSequence() {
  const seen = new Map();
  return text => {
    const base = headingAnchor(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

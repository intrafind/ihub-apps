// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The YAML front-matter block a documentation page (`docs/*.md`) may start with: a `---` line, the
 * metadata, and a closing `---` line. The admin docs viewer reads it as page metadata; the mdBook
 * build and the Markdown export remove it, so it never shows up as text.
 */
export const DOCS_FRONT_MATTER_RE = /^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Split a page into its front-matter block (without the delimiters) and the body after it.
 *
 * @param {string} text
 * @returns {{ block: string|null, body: string }} `block` is `null` when the page has none
 */
export function splitDocsFrontMatter(text) {
  const source = String(text ?? '');
  const match = DOCS_FRONT_MATTER_RE.exec(source);
  if (!match) return { block: null, body: source };
  return {
    block: match[0].replace(/^﻿?---[ \t]*\r?\n/, '').replace(/---[ \t]*(?:\r?\n)?$/, ''),
    body: source.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '')
  };
}

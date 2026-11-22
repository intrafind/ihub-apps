// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Plain text of an HTML string, for previews and character counts.
 *
 * The HTML is parsed into an inert document (`DOMParser`: no script runs, no
 * resource loads) and its text content is read. A regular expression such as
 * `/<[^>]*>/g` cannot do this safely: `<<script>script>` leaves `<script>`
 * behind after one pass, and it mishandles `>` inside attribute values.
 *
 * `<script>` and `<style>` elements are dropped with their contents, as they
 * are no text a reader sees. The result is meant for display as text (React
 * escapes it), never to be written back as HTML.
 *
 * @param {unknown} html - HTML (for example the Quill editor's content).
 * @returns {string} The text content; '' for an empty or non-string value.
 */
export function htmlToPlainText(html) {
  if (typeof html !== 'string' || html === '') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach(element => element.remove());
  return doc.body?.textContent ?? '';
}

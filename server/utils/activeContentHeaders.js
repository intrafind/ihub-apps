// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Headers for serving a user-supplied file from the application's own origin.
 *
 * A file a user uploaded is served under the media type it was stored with. For
 * an HTML, XHTML, SVG or any other XML file (an XML document in the XHTML namespace
 * runs its script too) that type makes a browser run the document, with
 * script, on the origin of the application: whoever follows the link (a shared
 * chat's viewer, say) would run the uploader's code as themselves. `nosniff`
 * does not help, as the type is honest.
 *
 * The files are fetched and rendered by the client itself, so a document opened
 * on its own, through a link, is the only case to close. A `sandbox` content
 * security policy without `allow-scripts` does that: the document gets an opaque
 * origin and runs nothing, and a `fetch` of the same URL is not affected.
 */

/** Media types a browser opens as a document that can run script. */
const ACTIVE_DOCUMENT_TYPES = new Set(['text/html', 'text/xml', 'application/xml']);

/**
 * Whether a browser would run a document served under this `Content-Type`.
 *
 * @param {unknown} contentType - A `Content-Type` value, parameters allowed.
 * @returns {boolean}
 */
export function isActiveDocumentType(contentType) {
  if (typeof contentType !== 'string') return false;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  // Every `+xml` subtype is an XML media type, so a browser parses it as XML and runs XHTML
  // script in it (`application/xhtml+xml`, `image/svg+xml`, `text/example+xml`, ...).
  return ACTIVE_DOCUMENT_TYPES.has(mediaType) || mediaType.endsWith('+xml');
}

/**
 * Serve a file under its media type, without letting it run in the
 * application's origin. Sets `Content-Type` and `X-Content-Type-Options`, and
 * for a type a browser would run as a document, a sandboxing
 * `Content-Security-Policy`.
 *
 * @param {import('express').Response} res - The response, before its body is sent.
 * @param {string} contentType - The `Content-Type` to answer with.
 */
export function setUserFileContentType(res, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (isActiveDocumentType(contentType)) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
  }
}

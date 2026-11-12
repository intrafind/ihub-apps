// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files linked from websites (#3536): what a URL serves, and the download of
 * a document (PDF, Word, PowerPoint, Excel, OpenDocument, text, …) that is
 * stored in a project like an upload. Web pages are downloaded the same way
 * for their stored snapshot (#3622, `downloadWebPage`).
 *
 * Every request goes through the page reader's `fetchWebPage`: the SSRF
 * guard on every redirect hop, DNS pinned to the checked address, the proxy,
 * and certificate checks skipped only for hosts on `ssl.domainWhitelist`
 * (with `ssl.ignoreInvalidCertificates` on). A download is bounded by the
 * project's `maxFileBytes`: a declared length over it is refused before the
 * body is read, a body that grows past it is cut off and refused.
 *
 * @module services/projects/webFileDownload
 */
import path from 'node:path';
import { fetchWebPage } from '../pageReader/pageReader.js';
import { classifyBlockedResponse } from '../pageReader/botProtection.js';
import { ProjectError } from './projectErrors.js';
import { ACCEPTED_TYPES, HTML_MIME, acceptedTypeOf } from './extractText.js';

/** The throttle queue of project downloads: never the chat's `read_url` slots. */
export const DOWNLOAD_THROTTLE_ID = 'project_download';

/** The `Accept` of a download: documents first, a page as the last resort. */
const DOWNLOAD_ACCEPT =
  'application/pdf,application/vnd.openxmlformats-officedocument.*,application/vnd.oasis.opendocument.*,text/*;q=0.9,*/*;q=0.8';

/**
 * Extensions that name a document a project downloads (#3536): listed by the
 * site crawler, and trusted when an address cannot be checked when it is added.
 */
export const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp']);

/**
 * What an address that could not be checked is taken for, from its
 * extension alone: a document of {@link DOCUMENT_EXTENSIONS}, else nothing.
 *
 * @param {string} url
 * @returns {{type: 'file', contentType: string, name: string, size: null, finalUrl: string}|null}
 */
export function documentFromUrl(url) {
  const name = fileNameOf(null, url);
  const extension = path.extname(name).slice(1).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(extension)) return null;
  const contentType = acceptedTypeOf({ name });
  return contentType ? { type: 'file', contentType, name, size: null, finalUrl: url } : null;
}

/** Types a URL serves that are web pages (a `url` item), not files. */
const PAGE_TYPES = new Set([HTML_MIME, 'application/xhtml+xml']);

/** The `Accept` of a web page's snapshot: the page reader's. */
const PAGE_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8';

/** A longest file name kept from a response. */
const MAX_NAME_CHARS = 300;

function mimeOf(contentType) {
  return String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function dropBody(body) {
  if (!body) return;
  try {
    if (typeof body.destroy === 'function') body.destroy();
    else if (typeof body.cancel === 'function') void body.cancel().catch(() => {});
  } catch {
    // Already closed.
  }
}

/**
 * The file name a response gives (`Content-Disposition`), else the last
 * segment of the URL's path, decoded. Empty when neither has one.
 *
 * @param {string|null} disposition - The `Content-Disposition` header.
 * @param {string} url
 * @returns {string}
 */
export function fileNameOf(disposition, url) {
  const params = dispositionParams(disposition);
  let name = '';
  const extended = params.get('filename*');
  if (extended) {
    // RFC 5987: charset'language'percent-encoded value.
    const quote = extended.indexOf("'");
    const second = quote >= 0 ? extended.indexOf("'", quote + 1) : -1;
    try {
      name = decodeURIComponent(second >= 0 ? extended.slice(second + 1) : extended);
    } catch {
      name = '';
    }
  }
  if (!name) name = params.get('filename') || '';
  if (!name) {
    try {
      const segment = new URL(url).pathname.split('/').pop() || '';
      try {
        name = decodeURIComponent(segment);
      } catch {
        name = segment;
      }
    } catch {
      name = '';
    }
  }
  // Only the base name: a header must not name a path.
  return path.basename(name.replaceAll('\\', '/')).slice(0, MAX_NAME_CHARS);
}

/**
 * The parameters of a `Content-Disposition` header, by lower-case name, with
 * the quotes of a quoted value removed. Split by hand: a header is the
 * website's, and a backtracking pattern over it could be made slow.
 *
 * @param {string|null} header
 * @returns {Map<string, string>}
 */
function dispositionParams(header) {
  const params = new Map();
  for (const part of String(header || '')
    .slice(0, 2048)
    .split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    let value = part.slice(at + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (key && value && !params.has(key)) params.set(key, value);
  }
  return params;
}

/** The charset a response declares in its content type, or in the page's first bytes. */
function charsetOf(contentType, bytes) {
  const declared = /charset=["']?([\w.:-]+)/i.exec(String(contentType || '').replace(/\s/g, ''));
  if (declared) return declared[1];
  const head = bytes.subarray(0, 1024).toString('latin1');
  return /<meta[^>]{0,200}?charset=["']?([\w.:-]+)/i.exec(head)?.[1] || '';
}

/**
 * The text of an HTML page in the charset it declares; without one, UTF-8, or
 * Windows-1252 for bytes that are not UTF-8 (older pages). A character the
 * byte limit cut in half is dropped, not turned into the whole page's
 * fallback.
 *
 * @param {Buffer} bytes
 * @param {string} [contentType]
 * @returns {string}
 */
export function decodeHtml(bytes, contentType) {
  const label = charsetOf(contentType, bytes)
    .toLowerCase()
    .replace(/^utf8$/, 'utf-8');
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes, { stream: true });
    } catch {
      // A label TextDecoder does not know: guess below.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Whether a content type names a web page. */
export function isPageType(contentType) {
  return PAGE_TYPES.has(mimeOf(contentType));
}

/** The declared length of a response, or null. */
function declaredLength(response) {
  const value = Number(response.headers.get('content-length'));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * What a URL serves, decided by the response's content type (the extension
 * of the file name only as a hint, as for an upload):
 *
 *  - `page`: an HTML page (or a response that names no type and no known
 *    extension) — a `url` item, stored as a snapshot (#3622);
 *  - `file`: a type the upload extractors read — downloaded and stored;
 *  - `unsupported`: anything else (an image, an archive, a legacy Office file).
 *
 * A file's body is not read: it is downloaded by the ingest job. A page's
 * body is, with `keepPage`: the check is then the page's only fetch, and its
 * snapshot (`page`) goes to the ingest job instead of a second request.
 *
 * @param {string} url
 * @param {{signal?: AbortSignal, language?: string, fetchPage?: Function,
 *   keepPage?: {maxBytes: number}}} [options] - `fetchPage`: test seam for
 *   `fetchWebPage`. `keepPage`: read a page's body up to `maxBytes`.
 * @returns {Promise<{type: 'page', page?: Object}|{type: 'file', contentType: string, name: string,
 *   size: number|null, finalUrl: string}|{type: 'unsupported', contentType: string, name: string}|null>}
 *   `null` when the URL could not be read now (a page item then fetches it in
 *   its ingest job, which records the failure). `page` is what
 *   {@link downloadWebPage} returns, when the body was kept.
 */
export async function probeWebUrl(
  url,
  { signal, language, fetchPage = fetchWebPage, keepPage = null } = {}
) {
  let result;
  try {
    result = await fetchPage(url, { signal, language, throttleId: DOWNLOAD_THROTTLE_ID });
  } catch {
    return null;
  }
  const { response, finalUrl } = result;
  try {
    if (!response.ok) return null;
    const declared = mimeOf(response.headers.get('content-type'));
    const name = fileNameOf(response.headers.get('content-disposition'), String(finalUrl || url));
    const page = async () => {
      if (!keepPage) return { type: 'page' };
      const kept = await pageOf(response, String(finalUrl || url), {
        maxBytes: keepPage.maxBytes,
        signal
      }).catch(() => null);
      return kept ? { type: 'page', page: kept } : { type: 'page' };
    };
    if (PAGE_TYPES.has(declared)) return await page();
    const accepted = acceptedTypeOf({ contentType: declared, name });
    if (accepted === HTML_MIME) return await page();
    if (accepted) {
      return {
        type: 'file',
        contentType: accepted,
        name,
        size: declaredLength(response),
        finalUrl: String(finalUrl || url)
      };
    }
    // Nothing says what it is: read it as a page, as before.
    if (!declared && !path.extname(name)) return await page();
    return { type: 'unsupported', contentType: declared, name };
  } finally {
    dropBody(response.body);
  }
}

/**
 * The error an unsupported URL gets: the one an unsupported upload gets.
 *
 * @param {{contentType?: string, name?: string}} probe
 * @returns {ProjectError}
 */
export function unsupportedUrlError(probe) {
  return new ProjectError(
    'UNSUPPORTED_TYPE',
    `${probe.name || 'The file'} has an unsupported type ${probe.contentType || '(unknown)'}. Supported: ${ACCEPTED_TYPES.summary}.`,
    { accepted: ACCEPTED_TYPES }
  );
}

function tooLarge(size, maxBytes) {
  return new ProjectError(
    'QUOTA_FILE_BYTES',
    `A file may be at most ${Math.floor(maxBytes / (1024 * 1024))} MB`,
    { limit: maxBytes, ...(size !== null ? { size } : {}) }
  );
}

/**
 * Read a body up to `maxBytes`; past it the connection is dropped and the
 * download refused. `signal` aborts the read.
 *
 * @param {AsyncIterable<Uint8Array>|null} body
 * @param {{maxBytes: number, signal?: AbortSignal}} options
 * @returns {Promise<Buffer>}
 * @throws {ProjectError} `QUOTA_FILE_BYTES`, `SOURCE_TIMEOUT` (aborted)
 */
export async function readBodyWithin(body, { maxBytes, signal }) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  const onAbort = () => dropBody(body);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        dropBody(body);
        throw tooLarge(null, maxBytes);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    if (signal?.aborted) {
      throw signal.reason instanceof ProjectError
        ? signal.reason
        : new ProjectError('SOURCE_TIMEOUT', 'The download was cancelled');
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks);
}

/**
 * A page's response as the snapshot a `url` item stores: its body up to
 * `maxBytes`, an HTML page decoded in the charset it declares and handed on
 * as UTF-8 (the extraction reads UTF-8), with its version (ETag,
 * Last-Modified) for the next conditional request.
 *
 * @param {Object} response - An `ok` response, its body unread.
 * @param {string} finalUrl
 * @param {{maxBytes: number, signal?: AbortSignal}} options
 * @returns {Promise<{notModified: false, bytes: Buffer, contentType: string, name: string,
 *   etag: string|null, lastModified: string|null, finalUrl: string}>}
 * @throws {ProjectError} `QUOTA_FILE_BYTES`
 */
async function pageOf(response, finalUrl, { maxBytes, signal }) {
  const size = declaredLength(response);
  if (size !== null && size > maxBytes) {
    dropBody(response.body);
    throw tooLarge(size, maxBytes);
  }
  const raw = await readBodyWithin(response.body, { maxBytes, signal });
  const header = response.headers.get('content-type');
  const page = isPageType(header) || !mimeOf(header);
  return {
    notModified: false,
    bytes: page ? Buffer.from(decodeHtml(raw, header), 'utf8') : raw,
    contentType: page ? HTML_MIME : mimeOf(header),
    name: fileNameOf(response.headers.get('content-disposition'), finalUrl),
    etag: response.headers.get('etag') || null,
    lastModified: response.headers.get('last-modified') || null,
    finalUrl
  };
}

/**
 * One guarded, optionally conditional GET of a file or a page, with the
 * refusals both share: a `304` answers `notModified`, a missing source is
 * `SOURCE_GONE`, a refusal (a login, bot protection) `SOURCE_FORBIDDEN`.
 *
 * @returns {Promise<{notModified: true, etag: string|null, lastModified: string|null,
 *   finalUrl: string}|{response: Object, final: string}>}
 */
async function guardedGet(url, { what, accept, signal, etag, lastModified, fetchPage }) {
  const headers = { Accept: accept };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  const { response, finalUrl } = await fetchPage(url, {
    signal,
    headers,
    throttleId: DOWNLOAD_THROTTLE_ID
  });
  const final = String(finalUrl || url);
  if (response.status === 304) {
    dropBody(response.body);
    // The version this response is: a 304 may repeat it or not.
    return {
      notModified: true,
      etag: response.headers.get('etag') || etag || null,
      lastModified: response.headers.get('last-modified') || lastModified || null,
      finalUrl: final
    };
  }
  if (!response.ok) {
    const blocked = await classifyBlockedResponse(response, final).catch(() => null);
    dropBody(response.body);
    if (response.status === 404 || response.status === 410) {
      throw new ProjectError(
        'SOURCE_GONE',
        `The ${what} is no longer at ${url} (HTTP ${response.status})`
      );
    }
    if (blocked || response.status === 401 || response.status === 403) {
      throw new ProjectError(
        'SOURCE_FORBIDDEN',
        blocked?.message || `The website refused the download (HTTP ${response.status})`
      );
    }
    throw new ProjectError(
      'SOURCE_GONE',
      `The ${what} could not be downloaded from ${url} (HTTP ${response.status})`
    );
  }
  return { response, final };
}

/**
 * Download a file linked from a website.
 *
 * With `etag` or `lastModified` (a refresh), the request is conditional: a
 * source that answers `304 Not Modified` is not downloaded again.
 *
 * @param {string} url
 * @param {Object} options
 * @param {number} options.maxBytes - The project's `maxFileBytes`.
 * @param {AbortSignal} [options.signal] - The ingest job's deadline.
 * @param {string|null} [options.etag] - The version the stored text was taken from.
 * @param {string|null} [options.lastModified]
 * @param {Function} [options.fetchPage] - Test seam for `fetchWebPage`.
 * @returns {Promise<{notModified: true, etag: string|null, lastModified: string|null,
 *   finalUrl: string}|{notModified: false, bytes: Buffer, contentType: string, name: string,
 *   etag: string|null, lastModified: string|null, finalUrl: string}>}
 * @throws {ProjectError} `QUOTA_FILE_BYTES`, `SOURCE_GONE`, `SOURCE_FORBIDDEN`
 */
export async function downloadWebFile(
  url,
  { maxBytes, signal, etag = null, lastModified = null, fetchPage = fetchWebPage }
) {
  const got = await guardedGet(url, {
    what: 'file',
    accept: DOWNLOAD_ACCEPT,
    signal,
    etag,
    lastModified,
    fetchPage
  });
  if (got.notModified) return got;
  const { response, final } = got;
  if (isPageType(response.headers.get('content-type'))) {
    // A file link that now answers with a page (a sign-in redirect, a soft
    // 404): not the file. Refused, so a refresh keeps the text it had.
    dropBody(response.body);
    throw new ProjectError(
      'SOURCE_FORBIDDEN',
      'The website answered with a web page instead of the file (a sign-in or an error page)'
    );
  }
  const size = declaredLength(response);
  if (size !== null && size > maxBytes) {
    dropBody(response.body);
    throw tooLarge(size, maxBytes);
  }
  const bytes = await readBodyWithin(response.body, { maxBytes, signal });
  return {
    notModified: false,
    bytes,
    contentType: mimeOf(response.headers.get('content-type')),
    name: fileNameOf(response.headers.get('content-disposition'), final),
    etag: response.headers.get('etag') || null,
    lastModified: response.headers.get('last-modified') || null,
    finalUrl: final
  };
}

/**
 * Download a web page for its snapshot (#3622): the same guarded fetch as a
 * file (SSRF guard on every hop, proxy, certificates skipped only for hosts on
 * `ssl.domainWhitelist`), conditional on a refresh, the HTML handed on as
 * UTF-8. A page that now serves a document is taken as that document: the
 * extraction reads what it is.
 *
 * @param {string} url
 * @param {Object} options - As {@link downloadWebFile}.
 * @returns {Promise<Object>} As {@link downloadWebFile}.
 * @throws {ProjectError} `QUOTA_FILE_BYTES`, `SOURCE_GONE`, `SOURCE_FORBIDDEN`
 */
export async function downloadWebPage(
  url,
  { maxBytes, signal, etag = null, lastModified = null, fetchPage = fetchWebPage }
) {
  const got = await guardedGet(url, {
    what: 'page',
    accept: PAGE_ACCEPT,
    signal,
    etag,
    lastModified,
    fetchPage
  });
  if (got.notModified) return got;
  return pageOf(got.response, got.final, { maxBytes, signal });
}

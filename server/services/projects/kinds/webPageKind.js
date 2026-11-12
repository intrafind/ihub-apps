// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `url` kind: a web page, stored as a snapshot (#3622).
 *
 * A page is fetched by one worker, its ingest job, and converted from HTML to
 * Markdown once per version (the page reader's extraction, through
 * `extractText`); the text is stored encrypted like an upload's, scanned and
 * counted against the project's quotas. Every reader decrypts the stored text
 * and builds its search index locally: no reader fetches the page and none
 * parses HTML. The reconciler refreshes the snapshot when its refresh TTL ran
 * out (`refreshTtl.js`), asking with the stored ETag and Last-Modified, so an
 * unchanged page is neither downloaded nor converted again.
 *
 * Every request goes through the page reader's guarded fetch
 * (`webFileDownload.downloadWebPage`): the SSRF guard on every redirect hop,
 * DNS pinned, the proxy, and certificate checks skipped only for hosts on
 * `ssl.domainWhitelist`.
 *
 * What the address serves decides the item when it is added (#3536): a
 * document the upload extractors read is handed to the `web-file` kind, a type
 * nothing reads is refused, a web page stays a `url` item. The check that
 * finds out reads a page's body, and that response is the page's snapshot: the
 * ingest job stores it without asking the website again (`prefetched`). A page
 * a site crawl read is taken from the crawl (`crawlHandover.js`) and not
 * fetched at all.
 *
 * @module services/projects/kinds/webPageKind
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { isHttpUrl } from '../../../validators/common.js';
import configCache from '../../../configCache.js';
import { registerItemKind } from './registry.js';
import { projectSettings } from '../projectSettings.js';

export const WEB_PAGE_KIND = 'url';

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function maxPageBytes() {
  return projectSettings(configCache.getPlatform?.() || {}).limits.maxFileBytes;
}

/**
 * What the ingest pipeline takes from a download or a kept page: the bytes and
 * the version for the item's provenance.
 */
function snapshotOf(item, result) {
  const version = {
    site: hostOf(item.ref.url),
    url: item.ref.url,
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.lastModified ? { lastModified: result.lastModified } : {}),
    ...(result.finalUrl && result.finalUrl !== item.ref.url ? { finalUrl: result.finalUrl } : {})
  };
  if (result.notModified) return { notModified: true, etag: result.etag, source: version };
  // The page itself, for a page that names no version (no ETag, no
  // Last-Modified): the same bytes are the same page, and are not converted
  // again (`ProjectIngestService`, `previousSha256`).
  version.sha256 = crypto.createHash('sha256').update(result.bytes).digest('hex');
  return {
    bytes: result.bytes,
    contentType: result.contentType,
    name: item.name,
    lastModified: result.lastModified || null,
    etag: result.etag || null,
    source: version
  };
}

export const webPageKind = registerItemKind({
  id: WEB_PAGE_KIND,
  name: { en: 'Web page (URL)', de: 'Webseite (URL)' },
  icon: 'link',
  storage: { ihub: 'text' },
  credentials: 'none',
  picker: { type: 'url' },
  // The address of a page may change: the item then fetches the new page.
  refEditable: true,
  refSchema: z
    .object({
      url: z.string().trim().max(2048).refine(isHttpUrl, 'Only http(s) URLs are allowed'),
      // Read by the live link this kind was before (#3622); the snapshot
      // holds the whole page within the project's text limit. Accepted so
      // items and admin projects written before still validate.
      maxContentLength: z.number().int().positive().max(5_000_000).optional()
    })
    .strict(),
  describe: ref => ({ name: ref.url, url: ref.url, site: hostOf(ref.url) }),
  /**
   * @param {Object} ref
   * @param {{name?: string, kindChange?: boolean, user?: Object, crawlId?: string}} [ctx] -
   *   `kindChange: false` (an admin project created with its items) takes the
   *   address as a page without asking it; `crawlId`: the crawl that listed it.
   * @returns {Promise<Object|null>} `kind`/`ref`/`name` for a document; for a
   *   page `prefetched` (its snapshot, handed to the ingest job, never stored
   *   on the item) and `nameFromTitle` when the caller did not name it.
   */
  async prepare(ref, { name, kindChange = true, user, crawlId } = {}) {
    const nameFromTitle = !name;
    if (crawlId && user?.id) {
      const { takeCrawledPage } = await import('../crawlHandover.js');
      const kept = await takeCrawledPage({ ownerId: user.id, crawlId, url: ref.url });
      if (kept) return { prefetched: kept, nameFromTitle };
    }
    if (!kindChange) return nameFromTitle ? { nameFromTitle } : null;
    const { documentFromUrl, probeWebUrl, unsupportedUrlError } =
      await import('../webFileDownload.js');
    // An address that cannot be checked now (a timeout, a 429 or 503) and
    // names a document by its extension is still a file: its download
    // then fails on the item, which can be retried. Any other address is a
    // page, which its ingest job fetches (and records as failed when it
    // still cannot be read).
    const probe =
      (await probeWebUrl(ref.url, {
        language: user?.language,
        keepPage: { maxBytes: maxPageBytes() }
      })) || documentFromUrl(ref.url);
    if (probe?.type === 'unsupported') throw unsupportedUrlError(probe);
    if (probe?.type === 'file') {
      return {
        kind: 'web-file',
        ref: {
          url: ref.url,
          ...(probe.contentType ? { contentType: probe.contentType } : {}),
          ...(probe.name ? { fileName: probe.name } : {}),
          ...(Number.isFinite(probe.size) ? { size: probe.size } : {})
        },
        ...(!name && probe.name ? { name: probe.name } : {})
      };
    }
    return {
      ...(probe?.page ? { prefetched: probe.page } : {}),
      ...(nameFromTitle ? { nameFromTitle } : {})
    };
  },
  /**
   * Fetch the page: the snapshot `prepare` handed over (`ctx.prefetched`),
   * else a guarded download, conditional on a refresh of a stored text.
   */
  async fetch(item, ctx = {}) {
    if (ctx.prefetched) return snapshotOf(item, ctx.prefetched);
    const { downloadWebPage } = await import('../webFileDownload.js');
    const source = item.provenance?.source || {};
    // Conditional only on a refresh of a stored text: a first fetch (or a
    // retry of one that failed) must get the page.
    const conditional = ctx.purpose === 'refresh' && Boolean(item.text?.blobKey);
    const result = await downloadWebPage(item.ref.url, {
      maxBytes: maxPageBytes(),
      signal: ctx.signal,
      etag: conditional ? source.etag || null : null,
      lastModified: conditional ? source.lastModified || null : null
    });
    return snapshotOf(item, result);
  }
});

export default webPageKind;

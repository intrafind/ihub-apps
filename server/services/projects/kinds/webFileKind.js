// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `web-file` kind (#3536): a document linked from a website — PDF,
 * Word, PowerPoint, Excel, OpenDocument or any other type the upload
 * extractors read — downloaded and stored like an upload: scanned,
 * extracted, encrypted, within `maxFileBytes`, `maxProjectBytes` and
 * `maxFiles`, with the text limit of an upload and no character or token
 * cap of the page reader.
 *
 * It is a kind of its own, not a storage the `url` kind picks per item: the
 * registry's storage rule is a property of the kind, and everything that
 * treats link and text items differently (quotas, refresh, the edit rules,
 * copies) keys on it. The URL picker and the crawler keep sending `url`;
 * the `url` kind's `prepare` looks at what the address serves and hands a
 * document over to this kind (`ProjectService.addItem`).
 *
 * The source URL stays in the reference and in `provenance.source`, for the
 * item card, citations and refresh. The kind fetches with nobody's
 * credentials, so the reconciler refreshes an expired snapshot on its own
 * (see `refreshTtl.js`); a refresh asks with the stored ETag and
 * Last-Modified, and an unchanged file is neither downloaded nor extracted.
 *
 * Available while the `url` kind is: an admin who switches web pages off
 * (`platform.projects.kinds.url: false`) switches files from websites off too.
 *
 * @module services/projects/kinds/webFileKind
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { isHttpUrl } from '../../../validators/common.js';
import configCache from '../../../configCache.js';
import { registerItemKind } from './registry.js';
import { projectSettings } from '../projectSettings.js';
import { downloadWebFile, fileNameOf } from '../webFileDownload.js';

export const WEB_FILE_KIND = 'web-file';

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export const webFileKind = registerItemKind({
  id: WEB_FILE_KIND,
  name: { en: 'File from a website', de: 'Datei von einer Website' },
  icon: 'document',
  storage: { ihub: 'text' },
  credentials: 'none',
  picker: { type: 'url' },
  enabled: ({ platform }) => projectSettings(platform).kinds.url !== false,
  refSchema: z
    .object({
      url: z.string().trim().max(2048).refine(isHttpUrl, 'Only http(s) URLs are allowed'),
      // What the address served when it was added: its type, its file name
      // and its declared size (an early quota check).
      contentType: z.string().trim().max(200).optional(),
      fileName: z.string().trim().max(300).optional(),
      size: z.number().int().nonnegative().optional()
    })
    .strict(),
  describe: ref => ({
    name: ref.fileName || fileNameOf(null, ref.url) || ref.url,
    url: ref.url,
    site: hostOf(ref.url)
  }),
  async fetch(item, ctx = {}) {
    const { limits } = projectSettings(configCache.getPlatform?.() || {});
    const source = item.provenance?.source || {};
    // Conditional only on a refresh of a stored text: a first download (or
    // a retry of one that failed) must get the file.
    const conditional = ctx.purpose === 'refresh' && Boolean(item.text?.blobKey);
    const result = await downloadWebFile(item.ref.url, {
      maxBytes: limits.maxFileBytes,
      signal: ctx.signal,
      etag: conditional ? source.etag || null : null,
      lastModified: conditional ? source.lastModified || null : null
    });
    const version = {
      site: hostOf(item.ref.url),
      url: item.ref.url,
      ...(result.etag ? { etag: result.etag } : {}),
      ...(result.lastModified ? { lastModified: result.lastModified } : {}),
      ...(result.finalUrl && result.finalUrl !== item.ref.url ? { finalUrl: result.finalUrl } : {})
    };
    if (result.notModified) return { notModified: true, etag: result.etag, source: version };
    // The file itself, for a source that names no version: the same bytes are
    // not extracted again (#3622).
    version.sha256 = crypto.createHash('sha256').update(result.bytes).digest('hex');
    return {
      bytes: result.bytes,
      contentType: result.contentType || item.ref.contentType,
      // The file name decides the type with the bytes; the item keeps its own name.
      name: result.name || item.ref.fileName || item.name,
      lastModified: result.lastModified || null,
      etag: result.etag || null,
      source: version
    };
  }
});

export default webFileKind;

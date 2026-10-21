// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cloud document kinds: a file picked from OneDrive or SharePoint
 * (`office365`), Google Drive (`google-drive`) or Nextcloud (`nextcloud`).
 * The picker is the one the cloud-storage upload already has; the pick
 * downloads the file through the integration service with the **picking**
 * user's stored OAuth token and hands the bytes to the ingest pipeline, so
 * the text is a snapshot taken at pick time (spec 3 §4). A later refresh
 * downloads again with the same user's token.
 *
 * Each kind is available when `platform.cloudStorage.providers` holds an
 * enabled provider of its type.
 *
 * @module services/projects/kinds/cloudKinds
 */
import { z } from 'zod';
import { OAuthRefreshError } from '../../integrations/oauthRefreshError.js';
import { ProjectError } from '../projectErrors.js';
import { registerItemKind } from './registry.js';

const providerId = z.string().trim().min(1).max(100);
const optionalMeta = {
  name: z.string().trim().max(300).optional(),
  mimeType: z.string().trim().max(200).optional(),
  size: z.number().int().nonnegative().optional(),
  lastModified: z.string().max(64).optional(),
  url: z.string().trim().max(2048).optional()
};

function providerEnabled(type) {
  return ({ platform }) =>
    (platform?.cloudStorage?.providers || []).some(
      provider => provider?.type === type && provider.enabled !== false
    );
}

function translate(error, site) {
  if (error instanceof OAuthRefreshError) {
    return new ProjectError('SOURCE_FORBIDDEN', `Connect ${site} first: ${error.message}`);
  }
  const message = String(error?.message || 'download failed');
  if (/\b(404|410)\b|not found|gone/i.test(message)) {
    return new ProjectError('SOURCE_GONE', `The document is no longer at ${site}: ${message}`);
  }
  if (/\b(401|403)\b|forbidden|denied|reconnect|unauthori[sz]ed|authentication/i.test(message)) {
    return new ProjectError(
      'SOURCE_FORBIDDEN',
      `You have no access to this ${site} document: ${message}`
    );
  }
  return error;
}

function fetched(file, ref, site) {
  return {
    bytes: file.content,
    contentType: file.mimeType || ref.mimeType,
    name: file.name || ref.name,
    lastModified: file.lastModified || ref.lastModified || null,
    source: {
      site,
      ...(ref.url ? { url: ref.url } : {}),
      ...(file.lastModified ? { lastModified: file.lastModified } : {})
    }
  };
}

function requireUser(ctx, site) {
  const user = ctx?.user;
  if (!user?.id || user.id === 'anonymous') {
    throw new ProjectError('SOURCE_FORBIDDEN', `A signed-in user is needed to read from ${site}`);
  }
  return user;
}

export const office365Kind = registerItemKind({
  id: 'office365',
  name: { en: 'OneDrive / SharePoint', de: 'OneDrive / SharePoint' },
  icon: 'cloud',
  storage: { ihub: 'text' },
  credentials: 'picking-user',
  picker: { type: 'cloud', provider: 'office365' },
  enabled: providerEnabled('office365'),
  refSchema: z
    .object({
      providerId,
      fileId: z.string().trim().min(1).max(500),
      driveId: z.string().trim().max(500).optional(),
      ...optionalMeta
    })
    .strict(),
  describe: ref => ({ name: ref.name || ref.fileId, url: ref.url, site: 'OneDrive / SharePoint' }),
  async fetch(item, ctx) {
    const site = 'OneDrive / SharePoint';
    const user = requireUser(ctx, site);
    const { default: service } = await import('../../integrations/Office365Service.js');
    try {
      const file = await service.downloadFile(
        user.id,
        item.ref.fileId,
        item.ref.driveId || null,
        item.ref.providerId
      );
      return fetched(file, item.ref, site);
    } catch (error) {
      throw translate(error, site);
    }
  }
});

export const googleDriveKind = registerItemKind({
  id: 'google-drive',
  name: { en: 'Google Drive', de: 'Google Drive' },
  icon: 'cloud',
  storage: { ihub: 'text' },
  credentials: 'picking-user',
  picker: { type: 'cloud', provider: 'googledrive' },
  enabled: providerEnabled('googledrive'),
  refSchema: z
    .object({
      providerId,
      fileId: z.string().trim().min(1).max(500),
      ...optionalMeta
    })
    .strict(),
  describe: ref => ({ name: ref.name || ref.fileId, url: ref.url, site: 'Google Drive' }),
  async fetch(item, ctx) {
    const site = 'Google Drive';
    const user = requireUser(ctx, site);
    const { default: service } = await import('../../integrations/GoogleDriveService.js');
    try {
      const file = await service.downloadFile(user.id, item.ref.fileId, item.ref.providerId);
      return fetched(file, item.ref, site);
    } catch (error) {
      throw translate(error, site);
    }
  }
});

export const nextcloudKind = registerItemKind({
  id: 'nextcloud',
  name: { en: 'Nextcloud', de: 'Nextcloud' },
  icon: 'cloud',
  storage: { ihub: 'text' },
  credentials: 'picking-user',
  picker: { type: 'cloud', provider: 'nextcloud' },
  enabled: providerEnabled('nextcloud'),
  refSchema: z
    .object({
      providerId,
      path: z.string().trim().min(1).max(2048),
      ...optionalMeta
    })
    .strict(),
  describe: ref => ({
    name: ref.name || ref.path.split('/').filter(Boolean).pop(),
    url: ref.url,
    site: 'Nextcloud'
  }),
  async fetch(item, ctx) {
    const site = 'Nextcloud';
    const user = requireUser(ctx, site);
    const { default: service } = await import('../../integrations/NextcloudService.js');
    try {
      const file = await service.downloadFile(user.id, item.ref.path, item.ref.providerId);
      return fetched(file, item.ref, site);
    } catch (error) {
      throw translate(error, site);
    }
  }
});

/** Every cloud kind, for callers that register them explicitly. */
export const CLOUD_KINDS = Object.freeze([office365Kind, googleDriveKind, nextcloudKind]);

import { z } from 'zod';

// Helper to transform empty strings to undefined for optional URL fields
const optionalUrlField = z
  .string()
  .transform(val => (val === '' ? undefined : val))
  .pipe(z.string().url().optional());

// Office 365 provider configuration
export const office365ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  type: z.literal('office365'),
  enabled: z.boolean().default(true),
  tenantId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  siteUrl: optionalUrlField.optional(),
  driveId: z
    .string()
    .transform(val => (val === '' ? undefined : val))
    .optional(),
  redirectUri: optionalUrlField.optional(),
  sources: z
    .object({
      personalDrive: z.boolean().default(true),
      followedSites: z.boolean().default(true),
      teams: z.boolean().default(true)
    })
    .optional()
    .default({ personalDrive: true, followedSites: true, teams: true })
});

// Google Drive provider configuration
export const googleDriveProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  type: z.literal('googledrive'),
  enabled: z.boolean().default(true),
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: optionalUrlField.optional(),
  sources: z
    .object({
      myDrive: z.boolean().default(true),
      sharedDrives: z.boolean().default(true),
      sharedWithMe: z.boolean().default(true)
    })
    .optional()
    .default({ myDrive: true, sharedDrives: true, sharedWithMe: true })
});

// Nextcloud provider configuration.
//
// Note: Nextcloud only exposes a single source per user (their files
// root), so unlike Office 365 / Google Drive there is no `sources`
// toggle map. If Nextcloud ever surfaces shared/external-storage as
// a separate source we'd add it back as a discriminated field.
export const nextcloudProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  type: z.literal('nextcloud'),
  enabled: z.boolean().default(true),
  // The Nextcloud instance URL (e.g. https://nextcloud.example.com).
  // Used as the base for OAuth, OCS, and WebDAV endpoints.
  //
  // `z.string().url()` happily accepts `javascript:`, `data:`, `file:`,
  // etc., which would all eventually be passed to `res.redirect` when a
  // user clicks Connect. Require an http(s) scheme at the validation
  // boundary so a malicious or careless admin can't make iHub emit a
  // dangerous `Location` header.
  serverUrl: z
    .string()
    .url()
    .refine(
      value => {
        try {
          const proto = new URL(value).protocol;
          return proto === 'http:' || proto === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'serverUrl must use http or https' }
    ),
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: optionalUrlField.optional()
});

// Generic cloud storage provider (union of all provider types)
export const cloudStorageProviderSchema = z.discriminatedUnion('type', [
  office365ProviderSchema,
  googleDriveProviderSchema,
  nextcloudProviderSchema
]);

// Main cloud storage configuration
export const cloudStorageConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(cloudStorageProviderSchema).default([])
});

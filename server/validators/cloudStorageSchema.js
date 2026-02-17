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

// Google Drive provider configuration (for future extensibility)
export const googleDriveProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  type: z.literal('googledrive'),
  enabled: z.boolean().default(true),
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: optionalUrlField.optional()
});

// Generic cloud storage provider (union of all provider types)
export const cloudStorageProviderSchema = z.discriminatedUnion('type', [
  office365ProviderSchema,
  googleDriveProviderSchema
]);

// Main cloud storage configuration
export const cloudStorageConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(cloudStorageProviderSchema).default([])
});

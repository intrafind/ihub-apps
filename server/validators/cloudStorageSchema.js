import { z } from 'zod';

// SharePoint provider configuration
export const sharepointProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  type: z.literal('sharepoint'),
  enabled: z.boolean().default(true),
  tenantId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  siteUrl: z.string().url().optional(),
  driveId: z.string().optional(),
  redirectUri: z.string().url().optional()
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
  redirectUri: z.string().url().optional()
});

// Generic cloud storage provider (union of all provider types)
export const cloudStorageProviderSchema = z.discriminatedUnion('type', [
  sharepointProviderSchema,
  googleDriveProviderSchema
]);

// Main cloud storage configuration
export const cloudStorageConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(cloudStorageProviderSchema).default([])
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V212 — Seed the artifact sharing and embedding settings
 *
 * A single artifact can be shared as its own read-only link, and a public
 * artifact link can be embedded in an iframe on allowlisted sites:
 *
 * - `chats.sharing.allowArtifacts`      — links to a single artifact.
 * - `chats.sharing.embedEnabled`        — public artifact links may be embedded.
 * - `chats.sharing.embedAllowedOrigins` — sites that may embed them.
 *
 * Artifact sharing is on, as chat sharing is; embedding is off until an admin
 * names the sites that may embed.
 */

export const version = '212';
export const description = 'artifact_sharing_defaults';

export const ARTIFACT_SHARING_DEFAULTS = Object.freeze({
  allowArtifacts: true,
  embedEnabled: false,
  embedAllowedOrigins: []
});

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  for (const [key, value] of Object.entries(ARTIFACT_SHARING_DEFAULTS)) {
    ctx.setDefault(platform, `chats.sharing.${key}`, Array.isArray(value) ? [...value] : value);
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Added chats.sharing artifact defaults (allowArtifacts=true, embedEnabled=false, ' +
      'embedAllowedOrigins=[])'
  );
}

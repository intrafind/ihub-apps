// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V245 — CDN hosts for HTML artifacts
 *
 * The sandboxed preview of an HTML artifact (chat Artifacts panel, share
 * embed page) used to block every network request, so a model that reached
 * for Chart.js, D3 or Tailwind from a CDN produced a blank page. It now loads
 * scripts and stylesheets from the hosts in `artifacts.scriptHosts`:
 *
 * - `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com` by default;
 * - `[]` keeps the preview fully offline, as before (air-gapped sites).
 *
 * Everything else — fetch, images, fonts, frames — stays blocked. Seeded
 * here so the key is visible and editable in Admin → Platform Configuration;
 * a list an installation already set is kept.
 */

export const version = '245';
export const description = 'add_artifact_script_hosts';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'artifacts.scriptHosts', [
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'unpkg.com'
  ]);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added artifacts.scriptHosts (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com)');
}

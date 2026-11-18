// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V258 — library kit for HTML artifacts (#3822)
 *
 * iHub now ships a small, vetted set of browser libraries (Chart.js, D3,
 * Alpine.js; see shared/artifactLibraries.js). An HTML artifact asks for one
 * with `<script data-ihub-lib="chart.js"></script>`, and iHub inlines the
 * library in the preview, on the share embed page and in every download, so
 * charts work with `artifacts.scriptHosts: []` and no internet access.
 *
 * Seeded on, so the switch is visible in Admin → Artifacts; a value an
 * installation already set is kept.
 */

export const version = '258';
export const description = 'add_artifact_library_kit';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'artifacts.libraryKit.enabled', true);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added artifacts.libraryKit.enabled (true)');
}

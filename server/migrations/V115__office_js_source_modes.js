/**
 * Migration V115 — replace `officeIntegration.useLocalOfficejs` with an
 * Office.js source mode and URLs.
 *
 * The boolean only chose between Microsoft's CDN and the bundled
 * `@microsoft/office-js` snapshot. That snapshot is frozen at whatever the
 * (no longer maintained) npm package shipped, so installations that turned it
 * on stopped receiving Office.js updates entirely.
 *
 * The replacement is a mode plus the URLs it needs:
 *
 * - `officeJsMode`       cdn | proxy | bundled | custom
 * - `officeJsCdnUrl`     upstream for `cdn` and `proxy`
 * - `officeJsCustomUrl`  used by `custom`
 *
 * `useLocalOfficejs: true` becomes `bundled`, which is exactly what it did
 * before — the migration changes no behaviour. Operators can then move to
 * `proxy` (this server caches the CDN; clients never reach Microsoft) or
 * `custom` (their own CDN or artifact proxy) from the admin UI.
 *
 * Existing installations keep the CDN host they were already using,
 * `appsforoffice.microsoft.com`, rather than inheriting the new default. A
 * migration must not silently change which external host a deployment
 * contacts: a customer who allowlisted that exact FQDN would find the add-in
 * broken after an upgrade they were told changed nothing. Fresh installations
 * get Microsoft's current documented host,
 * `officeapis.public.onecdn.static.microsoft`, from `server/defaults/`.
 *
 * Switching is one field in the admin UI, and worth doing on a blocked
 * network: the newer host is not under `microsoft.com`, so a suffix block on
 * that domain does not catch it.
 */

export const version = '115';
export const description = 'office_js_source_modes';

/**
 * The CDN URL the add-in HTML hard-coded before this change. Existing
 * installations keep it; `server/defaults/config/platform.json` carries the
 * newer host for fresh ones.
 */
const PREVIOUS_CDN_URL = 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const office = platform?.officeIntegration;

  // Nothing to migrate for an installation that has no Office block at all;
  // the schema defaults cover it and initial setup copies server/defaults/.
  if (!office || typeof office !== 'object' || Array.isArray(office)) {
    ctx.log('No officeIntegration block present, nothing to migrate');
    return;
  }

  // Preserve the existing choice: the bundled copy is what `true` selected.
  const usedLocal = office.useLocalOfficejs === true;
  ctx.setDefault(platform, 'officeIntegration.officeJsMode', usedLocal ? 'bundled' : 'cdn');
  ctx.setDefault(platform, 'officeIntegration.officeJsCdnUrl', PREVIOUS_CDN_URL);
  ctx.setDefault(platform, 'officeIntegration.officeJsCustomUrl', '');

  ctx.removeKey(platform, 'officeIntegration.useLocalOfficejs');

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    `Migrated officeIntegration.useLocalOfficejs (${usedLocal}) to officeJsMode=${
      usedLocal ? 'bundled' : 'cdn'
    }`
  );
}

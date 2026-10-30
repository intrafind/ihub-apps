// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V189 — iFinder search profile settings (#3050)
 *
 * Users can now pick the iFinder search profile per chat. The iFinder search
 * settings get their own keys next to the shared connection in
 * `platform.iFinder`, separate from iAssistant's (`platform.iAssistant`):
 *
 *  - `iFinder.defaultSearchProfile` — the profile a chat searches until the
 *    user picks another. iHub read this key before, but it was missing from
 *    the shipped defaults.
 *  - `iFinder.allowedSearchProfiles: []` — which of the user's profiles may be
 *    offered; empty offers all of them, as before.
 *  - `iFinder.allowUserSearchProfileChange: true` — whether users may change
 *    the profile at all.
 *
 * Nothing changes for an existing installation: the default profile is only
 * written when the section has none, with the value iHub used without it.
 * When `IFINDER_SEARCH_PROFILE` is set it is left out, because a value in
 * platform.json would win over the environment variable.
 *
 * Only an existing `iFinder` section is extended; installations without one
 * keep running on the code defaults.
 *
 * The shipped iFinder Search app (`apps/ifinder-search.json`) gets the search
 * profile picker in the chat input (`integrations.ifinder.scopePicker:
 * "inline"`), unless the app already says where to show it.
 */

export const version = '189';
export const description = 'ifinder_search_profile_settings';

/** What `iFinderService.getConfig()` falls back to without a configured profile. */
const CODE_DEFAULT_SEARCH_PROFILE = 'searchprofile-standard';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

const IFINDER_SEARCH_APP = 'apps/ifinder-search.json';

export async function up(ctx) {
  await addSearchAppPicker(ctx);

  const platform = await ctx.readJson('config/platform.json');
  if (!platform.iFinder || typeof platform.iFinder !== 'object') {
    ctx.log('No iFinder section; nothing to add');
    return;
  }

  const configured = platform.iFinder.defaultSearchProfile;
  if (typeof configured !== 'string' || !configured) {
    if (process.env.IFINDER_SEARCH_PROFILE) {
      ctx.log(
        'iFinder.defaultSearchProfile left unset: IFINDER_SEARCH_PROFILE names the default profile'
      );
    } else {
      platform.iFinder.defaultSearchProfile = CODE_DEFAULT_SEARCH_PROFILE;
    }
  }
  ctx.setDefault(platform, 'iFinder.allowedSearchProfiles', []);
  ctx.setDefault(platform, 'iFinder.allowUserSearchProfileChange', true);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Added iFinder.defaultSearchProfile, iFinder.allowedSearchProfiles and iFinder.allowUserSearchProfileChange'
  );
}

async function addSearchAppPicker(ctx) {
  if (!(await ctx.fileExists(IFINDER_SEARCH_APP))) return;
  const app = await ctx.readJson(IFINDER_SEARCH_APP);
  if (!app || typeof app !== 'object' || app.integrations?.ifinder?.scopePicker) return;
  ctx.setDefault(app, 'integrations.ifinder.scopePicker', 'inline');
  await ctx.writeJson(IFINDER_SEARCH_APP, app);
  ctx.log('Added the inline search profile picker to the iFinder Search app');
}

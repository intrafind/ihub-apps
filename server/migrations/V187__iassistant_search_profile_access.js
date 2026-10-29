// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V187 — The iAssistant search profile is checked against the user's
 * search profiles, not read from the conversation profile
 *
 * iHub used to read the iAssistant *conversation* profile before creating a
 * conversation, looking for a search profile published there
 * (`iAssistant.resolveSearchProfileFromProfile`). iFinder never published one:
 * a conversation profile selects a workflow and its tuning, not a corpus. The
 * lookup only ever cost a request.
 *
 * It is replaced by a check that does matter: iHub now reads the search
 * profiles the user has in iFinder and uses the user's default profile when
 * they lack the configured one (`iAssistant.verifySearchProfileAccess`). The
 * keys are renamed so platform.json says what is in force:
 *
 *  - `iAssistant.resolveSearchProfileFromProfile` → `iAssistant.verifySearchProfileAccess`
 *    (the value is kept: an admin who switched the extra request off keeps it off)
 *  - `iAssistant.profileCacheTtlMs` → `iAssistant.searchProfileCacheTtlMs`
 *
 * The `iFinder_listProfiles` tool reads the same per-user list now instead of
 * deriving profiles from the iAssistants. Its description told the model that
 * a deployment without iAssistants reports only the default; that text is
 * replaced where it is still the shipped one, and kept where an admin edited it.
 */

export const version = '187';
export const description = 'iassistant_search_profile_access';

/** The `listProfiles` descriptions this release replaces, as they shipped. */
const OLD_LIST_PROFILES_DESCRIPTIONS = {
  en: 'List the iFinder search profiles this user can reach, derived from the iAssistants the deployment exposes plus the configured default profile. Use it when a question names a corpus ("the legal documents") rather than a profile id. A deployment without iAssistants reports only the configured default — that is the upstream API’s limit, not an error.',
  de: 'Die für diesen Benutzer erreichbaren iFinder-Suchprofile auflisten, abgeleitet aus den iAssistants der Installation plus dem konfigurierten Standardprofil. Nützlich, wenn eine Frage einen Korpus benennt („die juristischen Dokumente“) statt einer Profil-ID. Eine Installation ohne iAssistants meldet nur das konfigurierte Standardprofil — eine Grenze der Upstream-API, kein Fehler.'
};

export async function precondition(ctx) {
  return (
    (await ctx.fileExists('config/platform.json')) || (await ctx.fileExists('tools/iFinder.json'))
  );
}

export async function up(ctx) {
  if (await ctx.fileExists('config/platform.json')) await renamePlatformKeys(ctx);
  if (await ctx.fileExists('tools/iFinder.json')) await refreshListProfilesDescription(ctx);
}

/**
 * Rename the iAssistant search-profile keys, keeping their values.
 *
 * @param {object} ctx - migration context
 */
async function renamePlatformKeys(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const iAssistant = platform.iAssistant;
  if (!iAssistant || typeof iAssistant !== 'object') return;

  let changed = false;

  if (iAssistant.verifySearchProfileAccess === undefined) {
    changed =
      ctx.renameKey(
        platform,
        'iAssistant.resolveSearchProfileFromProfile',
        'iAssistant.verifySearchProfileAccess'
      ) || changed;
  } else if (iAssistant.resolveSearchProfileFromProfile !== undefined) {
    ctx.removeKey(platform, 'iAssistant.resolveSearchProfileFromProfile');
    changed = true;
  }

  if (iAssistant.searchProfileCacheTtlMs === undefined) {
    changed =
      ctx.renameKey(
        platform,
        'iAssistant.profileCacheTtlMs',
        'iAssistant.searchProfileCacheTtlMs'
      ) || changed;
  } else if (iAssistant.profileCacheTtlMs !== undefined) {
    ctx.removeKey(platform, 'iAssistant.profileCacheTtlMs');
    changed = true;
  }

  if (platform.iAssistant.verifySearchProfileAccess === undefined) {
    ctx.setDefault(platform, 'iAssistant.verifySearchProfileAccess', true);
    changed = true;
  }

  if (changed) {
    await ctx.writeJson('config/platform.json', platform);
    ctx.log(
      `iAssistant search profiles are checked against the user's profiles ` +
        `(verifySearchProfileAccess: ${platform.iAssistant.verifySearchProfileAccess})`
    );
  }
}

/**
 * Replace the shipped `listProfiles` description, language by language, where
 * it was not edited.
 *
 * @param {object} ctx - migration context
 */
async function refreshListProfilesDescription(ctx) {
  const tool = await ctx.readJson('tools/iFinder.json');
  const description = tool?.functions?.listProfiles?.description;
  if (!description || typeof description !== 'object') return;

  let shipped;
  try {
    shipped = await ctx.readDefaultJson('tools/iFinder.json');
  } catch {
    ctx.warn('Shipped iFinder tool default not found — keeping the listProfiles description');
    return;
  }
  const current = shipped?.functions?.listProfiles?.description || {};

  const replaced = [];
  for (const [language, oldText] of Object.entries(OLD_LIST_PROFILES_DESCRIPTIONS)) {
    if (description[language] === oldText && typeof current[language] === 'string') {
      description[language] = current[language];
      replaced.push(language);
    }
  }

  if (replaced.length > 0) {
    await ctx.writeJson('tools/iFinder.json', tool);
    ctx.log(`Updated the iFinder listProfiles description (${replaced.join(', ')})`);
  }
}

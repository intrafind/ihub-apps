// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V235 — remove the NTLM settings that never did anything
 *
 * express-ntlm checks the NTLM sign-in by relaying it to `domainController`
 * and returns the user name, domain and workstation. It reads no option for
 * user details or groups, so these settings were passed to it and ignored:
 * - `ntlmAuth.getUserInfo`
 * - `ntlmAuth.getGroups`
 * - `ntlmAuth.domainControllerUser`
 * - `ntlmAuth.domainControllerPasswordRef` (and a leftover plaintext
 *   `domainControllerPassword`, which V061 normally moved to the store)
 *
 * NTLM users got only `ntlmAuth.defaultGroups` unless
 * `ntlmAuth.ldapGroupLookupProvider` names an LDAP provider; that stays the
 * only way to give them directory groups. Removing the keys changes nobody's
 * groups. The credential profile the password reference pointed to is left in
 * the credential store; an admin can reuse it for an LDAP provider or delete
 * it.
 */

export const version = '235';
export const description = 'remove_dead_ntlm_settings';

const DEAD_KEYS = [
  'getUserInfo',
  'getGroups',
  'domainControllerUser',
  'domainControllerPasswordRef',
  'domainControllerPassword'
];

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const ntlm = platform?.ntlmAuth;
  if (!ntlm || typeof ntlm !== 'object') {
    ctx.log('No ntlmAuth block — nothing to remove');
    return;
  }

  const present = DEAD_KEYS.filter(key => key in ntlm);
  if (present.length === 0) {
    ctx.log('No unused ntlmAuth settings — nothing to remove');
    return;
  }

  const hadCredentials = Boolean(
    ntlm.domainControllerUser || ntlm.domainControllerPasswordRef || ntlm.domainControllerPassword
  );
  const passwordRef = ntlm.domainControllerPasswordRef;
  for (const key of present) ctx.removeKey(platform, `ntlmAuth.${key}`);
  await ctx.writeJson('config/platform.json', platform);

  ctx.log(`Removed unused ntlmAuth settings: ${present.join(', ')}`);
  if (hadCredentials && !ntlm.ldapGroupLookupProvider) {
    ctx.warn(
      'ntlmAuth had domain controller credentials, which were never used for groups. ' +
        'NTLM users get only ntlmAuth.defaultGroups; to give them directory groups, ' +
        'configure an LDAP provider and set ntlmAuth.ldapGroupLookupProvider' +
        (passwordRef ? ` (the password is still in the credential store as "${passwordRef}")` : '')
    );
  }
}

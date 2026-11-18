// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V257 — remove `ntlmAuth.generateJwtToken`
 *
 * Windows sign-in (NTLM) now runs its handshake only on
 * `/api/auth/ntlm/login`, which always issues the session cookie; every other
 * request is signed in by that cookie, as with local, LDAP and OIDC sign-in.
 * `generateJwtToken: false` used to mean "sign in every request with NTLM
 * instead", which no longer exists, so the setting is removed.
 */

export const version = '257';
export const description = 'remove_ntlm_generate_jwt_token';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const ntlm = platform?.ntlmAuth;
  if (!ntlm || typeof ntlm !== 'object' || !('generateJwtToken' in ntlm)) {
    ctx.log('No ntlmAuth.generateJwtToken — nothing to remove');
    return;
  }

  const wasOff = ntlm.generateJwtToken === false;
  ctx.removeKey(platform, 'ntlmAuth.generateJwtToken');
  await ctx.writeJson('config/platform.json', platform);

  ctx.log('Removed ntlmAuth.generateJwtToken');
  if (wasOff) {
    ctx.warn(
      'ntlmAuth.generateJwtToken was false: Windows sign-in now always issues a session cookie ' +
        'and no longer signs in every request with NTLM'
    );
  }
}

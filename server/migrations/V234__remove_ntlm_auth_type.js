// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V234 — remove `ntlmAuth.type`
 *
 * `ntlmAuth.type` offered "ntlm" or "negotiate". Only "ntlm" ever worked:
 * express-ntlm accepts nothing but `Authorization: NTLM …` and relays it to
 * the domain controller, so it cannot verify a Kerberos ticket. With
 * "negotiate", iHub challenged with `WWW-Authenticate: Negotiate`, the browser
 * answered with Kerberos (or SPNEGO-wrapped NTLM), and every Windows sign-in
 * failed with 400. The setting is gone and iHub always challenges with NTLM,
 * so this removes the leftover key. An installation that had "negotiate" set
 * signs in with NTLM from now on.
 */

export const version = '234';
export const description = 'remove_ntlm_auth_type';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const type = platform?.ntlmAuth?.type;
  if (type === undefined) {
    ctx.log('ntlmAuth.type not set — nothing to remove');
    return;
  }

  ctx.removeKey(platform, 'ntlmAuth.type');
  await ctx.writeJson('config/platform.json', platform);
  if (type === 'negotiate') {
    ctx.warn(
      'Removed ntlmAuth.type "negotiate": Kerberos/Negotiate was never supported, Windows sign-in now uses NTLM'
    );
  } else {
    ctx.log(`Removed ntlmAuth.type ("${type}"); Windows sign-in always uses NTLM`);
  }
}

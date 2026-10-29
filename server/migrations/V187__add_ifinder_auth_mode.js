// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V187 — iFinder authentication mode (#3029)
 *
 * iHub can now get iFinder tokens from an OIDC provider it shares with iFinder
 * (token exchange) instead of signing them itself. This writes the defaults of
 * the new settings so they are visible and editable in platform.json:
 *
 *  - `iFinder.authMode: "ihubSigned"` — iHub keeps signing the tokens, as before
 *  - `iFinder.tokenExchange` — provider, grant type, client override, audience
 *    and scope map of the exchange; all empty, so nothing changes until an
 *    admin selects the `oidcTokenExchange` mode
 *
 * Only an existing `iFinder` section is extended; installations without one
 * keep running on the code defaults.
 */

export const version = '187';
export const description = 'add_ifinder_auth_mode';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  if (!platform.iFinder || typeof platform.iFinder !== 'object') {
    ctx.log('No iFinder section; nothing to add');
    return;
  }
  ctx.setDefault(platform, 'iFinder.authMode', 'ihubSigned');
  ctx.setDefault(platform, 'iFinder.tokenExchange.oidcProvider', '');
  ctx.setDefault(platform, 'iFinder.tokenExchange.grantType', 'tokenExchange');
  ctx.setDefault(platform, 'iFinder.tokenExchange.clientId', '');
  ctx.setDefault(platform, 'iFinder.tokenExchange.clientSecretRef', '');
  ctx.setDefault(platform, 'iFinder.tokenExchange.audience', '');
  ctx.setDefault(platform, 'iFinder.tokenExchange.scopeMap', {
    fa_index_read: '',
    fa_iassistant: '',
    fi_smartcollections: ''
  });
  ctx.setDefault(platform, 'iFinder.tokenExchange.extraScopes', []);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added iFinder.authMode ("ihubSigned") and iFinder.tokenExchange defaults');
}

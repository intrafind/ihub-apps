export const version = '109';
export const description = 'migrate_ifinder_legacy_private_key';

/**
 * Migration V109 — migrate stray platform.json iFinder.privateKey values
 *
 * V061 (centralize_credentials) moved `iFinder.privateKey` out of
 * platform.json into the central credential store, replacing it with
 * `iFinder.privateKeyRef`. The admin UI's "Private Key (PEM)" field was never
 * updated to match: until it was fixed, saving the iFinder config from
 * Admin > Integrations > iFinder kept writing the pasted key straight back
 * into the plaintext `iFinder.privateKey` field — a field
 * `getIFinderPrivateKey()` (server/utils/iFinderJwt.js) never reads, so the
 * key silently had no effect at runtime.
 *
 * This migration re-runs that one V061 clause to catch any `privateKey`
 * value re-introduced by the broken UI after V061 already ran once:
 *   - If `privateKeyRef` is not already set, the plaintext key is moved into
 *     a new `secret` credential and `privateKeyRef` is set to point at it.
 *   - If `privateKeyRef` is already set, the stray plaintext field is simply
 *     removed (the credential it points to is untouched).
 * Either way `iFinder.privateKey` is removed from platform.json afterwards.
 */

// Snapshot of sanitizeId()/addSecret() as of V061 (2026-xx-xx).
// Do NOT replace with an import — migrations must be self-contained.
const sanitizeId = raw =>
  String(raw || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'default';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const legacyKey = platform.iFinder?.privateKey;

  if (!legacyKey) {
    ctx.log('No stray iFinder.privateKey found, nothing to migrate');
    return;
  }

  if (!platform.iFinder.privateKeyRef) {
    let store;
    if (await ctx.fileExists('config/credentials.json')) {
      store = await ctx.readJson('config/credentials.json');
    } else {
      store = { credentials: {} };
    }
    if (!store.credentials || typeof store.credentials !== 'object') store.credentials = {};

    const usedIds = new Set(Object.keys(store.credentials));
    let id = sanitizeId('ifinder');
    let n = 2;
    while (usedIds.has(id)) id = `${sanitizeId('ifinder')}_${n++}`;

    store.credentials[id] = { id, name: 'iFinder Private Key', type: 'secret', value: legacyKey };
    platform.iFinder.privateKeyRef = id;

    await ctx.writeJson('config/credentials.json', store);
    ctx.log(`Moved stray iFinder.privateKey into credentials.json as "${id}"`);
  } else {
    ctx.log('iFinder.privateKeyRef already set; discarding the stray plaintext privateKey field');
  }

  delete platform.iFinder.privateKey;
  await ctx.writeJson('config/platform.json', platform);
}

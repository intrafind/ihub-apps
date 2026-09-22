/**
 * Migration V114 — drop the `proxy` block V110 seeded into platform.json
 *
 * V110 wrote a full `proxy` block into every installation so the new admin page
 * would open on something rather than on nothing. That was the wrong call. The
 * schema already prefaults every field, so the page renders identically with no
 * block at all — and the block V110 wrote says `"enabled": true` in a file the
 * operator never touched. Fresh installations got it too, because initial setup
 * copies `server/defaults/` before the migrations run, so a brand-new
 * `platform.json` came with an outbound proxy that looked switched on and
 * configured (the admin UI reports its provenance as "From platform.json") while
 * nothing was proxied at all: no URL was set, and without one there is nothing
 * to route through.
 *
 * So remove the block again — but only where it still carries no decision:
 *
 * - `enabled: false` stays. Absent means enabled, so an explicit `false` is the
 *   only way to say "do not proxy, whatever HTTP_PROXY says in the
 *   environment". Deleting it would silently switch egress back on.
 * - Any proxy URL, bypass entry or URL pattern stays, with the whole block.
 * - A block carrying keys this migration does not know about stays untouched,
 *   because it cannot tell whether they mean anything.
 *
 * What is left is exactly the no-op block V110 produced, which removing changes
 * nothing about: `getProxyConfig()` treats an absent block and an all-empty
 * `enabled: true` block the same way, down to still honouring
 * `HTTP_PROXY`/`HTTPS_PROXY` from the environment.
 */

export const version = '114';
export const description = 'Remove the no-op proxy block seeded by V110';

/** Keys V110 seeded. A block holding anything else is not V110's and is kept. */
const SEEDED_KEYS = new Set(['enabled', 'http', 'https', 'noProxy', 'urlPatterns']);

/** Is this value an empty proxy URL — absent, blank, or whitespace only? */
function isBlankUrl(value) {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

/** Is this bypass list empty in either accepted shape (string or array)? */
function isBlankNoProxy(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) {
    return value.every(entry => typeof entry !== 'string' || entry.trim() === '');
  }
  return false;
}

/**
 * Does this `proxy` block hold nothing an operator could have meant?
 *
 * @param {*} proxy - The `proxy` block from platform.json
 * @returns {boolean} True when removing it cannot change any behaviour
 */
export function isSeededNoOpProxyBlock(proxy) {
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) return false;
  if (!Object.keys(proxy).every(key => SEEDED_KEYS.has(key))) return false;
  // `false` is a decision; `true` and absent are the same thing.
  if (proxy.enabled !== undefined && proxy.enabled !== true) return false;
  if (!isBlankUrl(proxy.http) || !isBlankUrl(proxy.https)) return false;
  if (!isBlankNoProxy(proxy.noProxy)) return false;
  if (proxy.urlPatterns !== undefined && !Array.isArray(proxy.urlPatterns)) return false;
  if (Array.isArray(proxy.urlPatterns) && proxy.urlPatterns.length > 0) return false;
  return true;
}

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  if (!platform || typeof platform !== 'object') {
    ctx.warn('platform.json could not be read — skipping');
    return;
  }

  if (platform.proxy === undefined) {
    ctx.log('platform.json has no proxy block — nothing to remove');
    return;
  }

  if (!isSeededNoOpProxyBlock(platform.proxy)) {
    ctx.log('Proxy block is configured — leaving it untouched');
    return;
  }

  delete platform.proxy;
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Removed the empty proxy block seeded by V110');
}

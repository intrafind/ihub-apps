// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// server/migrations/V238__short_link_hosts_to_ssrf_allowlist.js
export const version = '238';
export const description = 'short_link_hosts_to_ssrf_allowlist';

/**
 * Short links no longer have a list of their own: an absolute target's host
 * must be on the SSRF allowlist (`ssrf.allowedHosts`), the one list admins
 * edit in Admin → Security. This moves what short links allowed onto it:
 *
 * - every entry of `shortLinks.allowedHosts` (V145) that the SSRF list can
 *   express — a hostname, `*.domain` or `.domain`; `/regex/` entries and IPv6
 *   addresses cannot be and are logged as skipped;
 * - the host of every stored, unexpired short link to an absolute http(s) URL,
 *   so links that redirect today keep redirecting.
 *
 * Each host added is logged with where it came from, so the list can be
 * reviewed: an SSRF entry also lets outbound calls reach the host when it
 * resolves to an internal address. `shortLinks.allowedHosts` is then removed.
 */

const PLATFORM_FILE = 'config/platform.json';
const LINKS_FILE = 'data/shortlinks.json';

/** What `PUT /api/admin/ssrf/config` accepts (routes/admin/ssrf.js). */
const SSRF_PATTERN =
  /^(\*\.|\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

export async function precondition(ctx) {
  return await ctx.fileExists(PLATFORM_FILE);
}

/** The hosts of the stored, unexpired links to absolute http(s) URLs, with their link counts. */
async function storedLinkHosts(ctx) {
  const hosts = new Map();
  if (!(await ctx.fileExists(LINKS_FILE))) return hosts;
  const data = await ctx.readJson(LINKS_FILE);
  const links = Array.isArray(data?.links) ? data.links : [];
  const now = Date.now();
  for (const link of links) {
    if (link?.expiresAt && new Date(link.expiresAt).getTime() <= now) continue;
    if (typeof link?.url !== 'string') continue;
    let url;
    try {
      url = new URL(link.url);
    } catch {
      continue; // A path on this server.
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (!url.hostname) continue;
    hosts.set(url.hostname, (hosts.get(url.hostname) || 0) + 1);
  }
  return hosts;
}

export async function up(ctx) {
  const platform = await ctx.readJson(PLATFORM_FILE);
  const configured = platform?.shortLinks?.allowedHosts;
  const linkHosts = await storedLinkHosts(ctx);

  const ssrfHosts = Array.isArray(platform.ssrf?.allowedHosts)
    ? platform.ssrf.allowedHosts.filter(entry => typeof entry === 'string')
    : [];
  const listed = new Set(ssrfHosts.map(entry => entry.trim().toLowerCase()));
  let added = 0;

  const add = (entry, origin) => {
    const host = entry.trim();
    if (!host) return;
    if (!SSRF_PATTERN.test(host)) {
      ctx.warn(
        `Skipped ${JSON.stringify(host)} (${origin}): not a host the SSRF allowlist can hold`
      );
      return;
    }
    if (listed.has(host.toLowerCase())) return;
    listed.add(host.toLowerCase());
    ssrfHosts.push(host.toLowerCase());
    added += 1;
    ctx.log(`Added ${host.toLowerCase()} to ssrf.allowedHosts (${origin})`);
  };

  if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry === 'string') add(entry, 'shortLinks.allowedHosts');
    }
  }
  for (const [host, count] of linkHosts) {
    add(host, `${count} stored short link${count === 1 ? '' : 's'}`);
  }

  if (added > 0) {
    platform.ssrf = { ...(platform.ssrf || {}), allowedHosts: ssrfHosts };
  }
  if (platform.shortLinks && typeof platform.shortLinks === 'object') {
    delete platform.shortLinks.allowedHosts;
    if (Object.keys(platform.shortLinks).length === 0) delete platform.shortLinks;
  }

  await ctx.writeJson(PLATFORM_FILE, platform);
  ctx.log(
    `Short links now use ssrf.allowedHosts; added ${added} host(s), removed shortLinks.allowedHosts`
  );
}

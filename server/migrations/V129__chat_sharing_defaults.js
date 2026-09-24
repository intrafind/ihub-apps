/**
 * Migration V129 — Seed the platform `chats.sharing` section
 *
 * Chat sharing hands out read-only links onto stored chats. The feature
 * itself ships dark behind `features.chatSharing`; the settings seeded here
 * are what it reads once an admin turns it on, and what
 * Admin → Observability → Chat History edits:
 *
 * - `chats.sharing.enabled`            — second switch under the feature flag.
 * - `chats.sharing.allowUsers`         — links addressed to picked users.
 * - `chats.sharing.allowAuthenticated` — links for anyone signed in.
 * - `chats.sharing.allowPublic`        — links that open without a sign-in.
 * - `chats.sharing.defaultExpiryDays`  — expiry a new link gets when its
 *                                        owner picks none; <= 0 means none.
 * - `chats.sharing.maxExpiryDays`      — longest expiry an owner may pick;
 *                                        <= 0 removes the cap.
 * - `chats.sharing.maxViewsCap`        — most views an owner may allow a
 *                                        link; <= 0 removes the cap.
 *
 * Every value is the built-in default, so an upgrade changes nothing on its
 * own — the section just becomes visible and editable instead of appearing
 * out of nowhere the first time an admin saves the page. Nothing here touches
 * `features.json`: whether chats may be shared at all is the admin's call.
 */

export const version = '129';
export const description = 'chat_sharing_defaults';

export const SHARING_DEFAULTS = Object.freeze({
  enabled: true,
  allowUsers: true,
  allowAuthenticated: true,
  allowPublic: true,
  defaultExpiryDays: 0,
  maxExpiryDays: 0,
  maxViewsCap: 0
});

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  for (const [key, value] of Object.entries(SHARING_DEFAULTS)) {
    ctx.setDefault(platform, `chats.sharing.${key}`, value);
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Added chats.sharing defaults (enabled=true, allowUsers=true, allowAuthenticated=true, ' +
      'allowPublic=true, defaultExpiryDays=0, maxExpiryDays=0, maxViewsCap=0)'
  );
}

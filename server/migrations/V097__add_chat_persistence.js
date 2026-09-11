/**
 * Migration V097 — Seed the platform `chats` section and carry the chat
 * history preview flag over to durable chats
 *
 * Durable chats store a conversation server-side (through the storage
 * abstraction seeded by V094) instead of only in the browser. The feature
 * ships dark behind `features.chatPersistence`; the settings seeded here are
 * what it reads once an admin turns it on:
 *
 * - `chats.enabled`          — master switch for the stored-chat write path.
 * - `chats.retentionDays`    — age after which a chat is swept; <= 0 keeps
 *                              chats forever.
 * - `chats.maxChatsPerUser`  — chats kept per owner; <= 0 removes the cap.
 * - `chats.maxMessagesPerChat` — messages kept in one chat; <= 0 removes the
 *                              cap. Enforced at write time rather than by the
 *                              daily sweep: a transcript that has already
 *                              grown too large to read back is not something a
 *                              nightly job can undo for the person typing into
 *                              it now.
 *
 * Every value is the built-in default, so an upgrade changes nothing on its
 * own — the section just becomes visible and editable in
 * Admin → Platform Configuration instead of appearing out of nowhere later.
 *
 * The second half deliberately carries nothing over. `chatHistoryPreview`
 * gated a sidebar list and a `/chats` page drawn from `mockChats.js` — its own
 * registry description said "currently uses sample data" — so enabling it was
 * a decision to look at fixtures, not a decision about where real
 * conversations are stored. `chatPersistence` is the single switch
 * `isChatPersistenceConfigured` checks, and the other two conditions are
 * already met on a fresh install: `chats.enabled` is seeded true just above,
 * and the filesystem provider needs no configuration, so `isStorageReady()` is
 * true out of the box. Promoting the old flag would therefore mean that from
 * the first boot after an upgrade, every authenticated user's prompts and
 * model answers are written to disk and kept for 90 days — because somebody
 * once ticked a preview to see sample data. An admin has to ask for that.
 *
 * So an install that had the preview on gets a warning naming the switch, and
 * durable chats stay off until someone turns them on. The cost is a sidebar
 * that goes quiet on upgrade; it was showing fixtures, and the warning says
 * where the real thing lives.
 *
 * The old key is left in `features.json`. It no longer does anything — this
 * release removed its last reader, and it is not in the feature registry, so
 * Admin → Features does not show it. Removing a key an admin set is not this
 * migration's business, and residue cannot turn anything on.
 */

export const version = '097';
export const description = 'add_chat_persistence';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'chats.enabled', true);
  ctx.setDefault(platform, 'chats.retentionDays', 90);
  ctx.setDefault(platform, 'chats.maxChatsPerUser', 200);
  ctx.setDefault(platform, 'chats.maxMessagesPerChat', 2000);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Added chats defaults (enabled=true, retentionDays=90, maxChatsPerUser=200, ' +
      'maxMessagesPerChat=2000)'
  );

  // features.json is a sparse override map and only exists once something has
  // been toggled — an install that never touched a feature has nothing to say.
  // Read only: nothing below writes it, because nothing below decides anything
  // on the admin's behalf.
  if (!(await ctx.fileExists('config/features.json'))) {
    ctx.log('No features.json; durable chats stay off until an admin turns them on');
    return;
  }

  const features = await ctx.readJson('config/features.json');
  if (features.chatHistoryPreview !== true) return;

  ctx.warn(
    'chatHistoryPreview was enabled and is gone in this release. Durable chats are NOT ' +
      'turned on automatically: storing real conversations server-side is a decision the ' +
      'preview never asked for. Enable Durable Chats in Admin → Features when you want it.'
  );
}

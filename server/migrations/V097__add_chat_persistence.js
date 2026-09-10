/**
 * Migration V095 — Seed the platform `chats` section and carry the chat
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
 *
 * Every value is the built-in default, so an upgrade changes nothing on its
 * own — the section just becomes visible and editable in
 * Admin → Platform Configuration instead of appearing out of nowhere later.
 *
 * The second half is the flag carry-over. `chatHistoryPreview` gated the
 * sidebar chat list while it was still drawn from sample data; the same UI is
 * now backed by real stored chats behind `chatPersistence`. An admin who
 * enabled the preview asked for chat history, so their `true` is carried over
 * rather than silently turning the UI off under them. `setDefault` is what
 * makes this safe to re-run and makes an explicit `chatPersistence` choice
 * win: a value already in `features.json` is never overwritten. The old key is
 * left in place — it still gates the preview UI in this release.
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

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added chats defaults (enabled=true, retentionDays=90, maxChatsPerUser=200)');

  // features.json is a sparse override map and only exists once something has
  // been toggled — an install that never touched a feature has nothing to
  // carry over.
  if (!(await ctx.fileExists('config/features.json'))) {
    ctx.log('No features.json; nothing to carry over to chatPersistence');
    return;
  }

  const features = await ctx.readJson('config/features.json');
  if (features.chatHistoryPreview !== true) return;
  if (Object.prototype.hasOwnProperty.call(features, 'chatPersistence')) {
    ctx.log('chatPersistence is already configured; leaving that choice alone');
    return;
  }

  ctx.setDefault(features, 'chatPersistence', true);
  await ctx.writeJson('config/features.json', features);
  ctx.log('Carried chatHistoryPreview=true over to chatPersistence');
}

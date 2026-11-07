// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V232 — background chat titles (#2314)
 *
 * After the first answer of a kept chat, one small model call can replace the
 * derived title (the first message, cut) with a headline. It is off until an
 * admin switches it on, because it sends the first exchange of every chat to a
 * model. This writes the two settings' defaults next to the other chat
 * settings so the admin Chat History page and `platform.json` show them:
 * - `chats.titles.enabled` — false;
 * - `chats.titles.modelId` — empty, which means the chat's own model.
 *
 * Nothing changes for an installation that does not touch them.
 */

export const version = '232';
export const description = 'chat_titles_setting';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'chats.titles.enabled', false);
  ctx.setDefault(platform, 'chats.titles.modelId', '');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Chat titles are off (chats.titles.enabled = false); modelId empty = the chat model');
}

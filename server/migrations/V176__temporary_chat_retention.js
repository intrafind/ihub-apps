// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V176 — Every chat is stored; temporary chats expire (#2947)
 *
 * The browser no longer holds a chat: an incognito chat, an anonymous
 * visitor's and every chat of an installation without chat history are stored
 * as temporary chats — never listed, and deleted
 * `chats.temporaryRetentionHours` after their last activity. This writes that
 * setting's default next to the other chat retention settings so the admin
 * Chat History page shows it.
 */

export const version = '176';
export const description = 'temporary_chat_retention';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'chats.temporaryRetentionHours', 24);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Temporary chats are kept for chats.temporaryRetentionHours (24) after their last activity'
  );
}

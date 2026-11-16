// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V251 — chat evidence record settings (#3687)
 *
 * Every stored answer gets an evidence record: what went into each model call
 * and each tool call of the turn. This writes the two settings' defaults next
 * to the other chat settings so the admin Chat History page and
 * `platform.json` show them:
 * - `chats.evidence.enabled` — true;
 * - `chats.evidence.maxContentBytes` — 10 MB per item.
 */

export const version = '251';
export const description = 'chat_evidence_settings';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'chats.evidence.enabled', true);
  ctx.setDefault(platform, 'chats.evidence.maxContentBytes', 10 * 1024 * 1024);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Chat evidence record on (chats.evidence.enabled = true, maxContentBytes = 10 MB)');
}

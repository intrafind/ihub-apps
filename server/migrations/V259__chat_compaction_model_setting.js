// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V259 — the model that condenses a long chat turn (#3819)
 *
 * When a chat turn with many tool calls fills half the model's context, older
 * tool results are condensed into notes by a model call. By default the
 * chat's own model writes them; `chats.compaction.modelId` names another
 * model for every chat (a small, fast one). This writes the default next to
 * the other chat settings so the admin Chat History page and
 * `platform.json` show it:
 * - `chats.compaction.modelId` — empty, which means the chat's own model.
 *
 * Nothing changes for an installation that does not touch it.
 */

export const version = '259';
export const description = 'chat_compaction_model_setting';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'chats.compaction.modelId', '');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Chat compaction model: empty = the chat model (chats.compaction.modelId)');
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V173 — Add the project knowledge tool
 *
 * Projects (#1036) reach the model through three tools, `knowledge_search`,
 * `knowledge_read` and `knowledge_list`, defined once in
 * `tools/knowledge.json` and added to a request automatically whenever a
 * project is in its scope. A fresh installation gets the file from
 * `server/defaults/tools/`; an upgraded one gets it here. A file that is
 * already there — an admin may have localized or disabled it — is left as
 * it is.
 */

export const version = '173';
export const description = 'add_knowledge_tool';

const TOOL_FILE = 'tools/knowledge.json';

export async function precondition(ctx) {
  return !(await ctx.fileExists(TOOL_FILE));
}

export async function up(ctx) {
  const tool = await ctx.readDefaultJson(TOOL_FILE);
  if (!tool || typeof tool !== 'object' || tool.id !== 'knowledge') {
    ctx.warn('The shipped tools/knowledge.json is missing — nothing to add');
    return;
  }
  await ctx.writeJson(TOOL_FILE, tool);
  ctx.log('Added tools/knowledge.json (knowledge_search, knowledge_read, knowledge_list)');
}

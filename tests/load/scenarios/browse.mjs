// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Background API traffic of an open UI: app list, chat history, projects.
 * Gives the non-LLM latency (`http.browse.*`) that users feel on every click.
 */

export default async function browse(ctx) {
  const { client } = ctx;
  const steps = [
    ['browse.apps', '/api/apps'],
    ['browse.chats', '/api/chats?limit=20'],
    ['browse.projects', '/api/projects?scope=all'],
    ['browse.projectConfig', '/api/projects/_config']
  ];
  const own = ctx.projects.own[0] || ctx.projects.shared[0];
  if (own) steps.push(['browse.project', `/api/projects/${own.id}`]);
  for (const [name, path] of steps) {
    await client.request('GET', path, { name });
    await ctx.sleep(ctx.between([1, 4]) * 1000);
  }
}

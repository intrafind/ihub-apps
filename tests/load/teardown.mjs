#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Removes what load tests left behind on an instance:
 *   - chats whose id starts with "chat-lt-" (kept chats; temporary ones expire)
 *   - "LT-build …" projects (left over when a run was aborted)
 *   - with --projects also the "LT-chat …" projects from setup
 *   - with --users also the lt-NNNN users (admin API)
 *
 *   node tests/load/teardown.mjs --users 300 [--projects] [--delete-users]
 */

import { loadConfig, userName } from './lib/config.mjs';
import { login } from './lib/http.mjs';
import { listProjects, deleteProject } from './lib/projects.mjs';
import { mapLimit, withRetry, log } from './lib/util.mjs';

const cfg = loadConfig();
const flags = cfg.args;
let chats = 0;
let projects = 0;

const indexes = Array.from({ length: cfg.users.count }, (_, i) => i);
await mapLimit(indexes, cfg.loginConcurrency, async i => {
  const username = userName(cfg, i);
  let client;
  try {
    ({ client } = await withRetry(
      () => login({ baseUrl: cfg.baseUrl, username, password: cfg.users.password }),
      { label: username }
    ));
  } catch (err) {
    log(`skip ${username}: ${err.message}`);
    return;
  }
  for (const p of await listProjects(client).catch(() => [])) {
    if (!p.permissions?.isOwner) continue;
    if (
      p.name.startsWith('LT-build') ||
      (flags.projects === 'true' && p.name.startsWith('LT-chat'))
    ) {
      await deleteProject(client, p.id).catch(err => log(`project ${p.id}: ${err.message}`));
      projects += 1;
    }
  }
  let cursor = null;
  do {
    const res = await client.get(
      `/api/chats?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    );
    if (res.status !== 200) break;
    for (const c of res.body.items || []) {
      const id = c.id || c.chatId;
      if (id?.startsWith('chat-lt-')) {
        await client.delete(`/api/chats/${encodeURIComponent(id)}`);
        chats += 1;
      }
    }
    cursor = res.body.nextCursor;
  } while (cursor);
});
log(`deleted ${chats} chats, ${projects} projects`);

if (flags['delete-users'] === 'true') {
  const { client: admin } = await login({
    baseUrl: cfg.baseUrl,
    username: cfg.admin.username,
    password: cfg.admin.password
  });
  const res = await admin.get('/api/admin/auth/users');
  const list = Array.isArray(res.body) ? res.body : res.body?.items || res.body?.users || [];
  let n = 0;
  for (const u of list) {
    if (String(u.username).startsWith(cfg.users.prefix)) {
      await admin.delete(`/api/admin/auth/users/${encodeURIComponent(u.id)}`);
      n += 1;
    }
  }
  log(`deleted ${n} users`);
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET/PUT /api/admin/projects/_settings`: who users may share their projects
 * with — users, groups, everyone signed in and the catalog. Full admins only;
 * a save changes only the fields sent and keeps the rest of platform.json.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let scratch;
let configCache;
let route;

const ROOT = { id: 'user-root', name: 'Root', groups: ['admins'] };
const EDITOR = { id: 'user-editor', name: 'Editor', groups: ['editors'] };

async function drive(handlers, { body = {}, user } = {}) {
  const req = { params: {}, query: {}, body, headers: {}, user, ip: '127.0.0.1', method: 'PUT' };
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-project-settings-'));
  process.env.CONTENTS_DIR = scratch;
  await fs.mkdir(path.join(scratch, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(scratch, 'config', 'platform.json'),
    JSON.stringify({
      defaultLanguage: 'en',
      projects: { limits: { maxFiles: 10 }, sharing: { allowUsers: true } }
    }),
    'utf8'
  );
  ({ default: configCache } = await import('../configCache.js'));
  const { resolveGroupInheritance } = await import('../utils/authorization.js');
  configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
        editors: { id: 'editors', name: 'Editors', permissions: { contentAdmin: true } }
      }
    })
  );
  await configCache.refreshCacheEntry('config/platform.json');
  const { default: register } = await import('../routes/admin/projects.js');
  const routes = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: () => {}
  });
  const find = method =>
    routes.find(entry => entry.method === method && entry.routePath.endsWith('/_settings'))
      .handlers;
  route = { get: find('get'), put: find('put') };
});

after(async () => {
  delete process.env.CONTENTS_DIR;
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('project sharing settings', () => {
  it('reads the effective audiences, the catalog off by default', async () => {
    const res = await drive(route.get, { user: ROOT });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.sharing, {
      allowUsers: true,
      allowGroups: true,
      allowEveryone: false,
      allowCatalog: false
    });
  });

  it('writes only the fields sent and keeps the rest of the file', async () => {
    const res = await drive(route.put, {
      user: ROOT,
      body: { sharing: { allowCatalog: true, allowEveryone: true } }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.sharing.allowCatalog, true);
    assert.equal(res.body.sharing.allowEveryone, true);
    const stored = JSON.parse(
      await fs.readFile(path.join(scratch, 'config', 'platform.json'), 'utf8')
    );
    assert.deepEqual(stored.projects, {
      limits: { maxFiles: 10 },
      sharing: { allowUsers: true, allowCatalog: true, allowEveryone: true }
    });
    assert.equal(configCache.getPlatform().projects.sharing.allowCatalog, true);
  });

  it('refuses unknown fields and anyone but a full admin', async () => {
    const unknown = await drive(route.put, { user: ROOT, body: { sharing: { allowAll: true } } });
    assert.equal(unknown.statusCode, 400);
    const editor = await drive(route.put, {
      user: EDITOR,
      body: { sharing: { allowCatalog: false } }
    });
    assert.equal(editor.statusCode, 403);
    assert.equal((await drive(route.get, { user: EDITOR })).statusCode, 403);
  });
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET/PUT /api/admin/projects/_settings`: who users may share their projects
 * with — users, groups, everyone signed in and the catalog — the tier policy,
 * the default app and the limits of user projects. Full admins only;
 * a save changes only the fields sent and keeps the rest of platform.json.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { answerWithError } from './helpers/answerError.js';
import { MAX_FILES_CEILING } from '../services/projects/projectConstants.js';

let scratch;
let configCache;
let route;

const ROOT = {
  id: 'user-root',
  name: 'Root',
  isAdmin: true,
  isContentAdmin: true,
  groups: ['admins']
};
const EDITOR = { id: 'user-editor', name: 'Editor', groups: ['editors'] };

async function drive(handlers, { body = {}, user } = {}) {
  const req = { params: {}, query: {}, body, headers: {}, user, ip: '127.0.0.1', method: 'PUT' };
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
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
    let refusal = null;
    try {
      await handler(req, res, error => {
        // `next(error)` is what Express hands to the global handler, not a step forward.
        if (error) refusal = error;
        else advanced = true;
      });
      if (refusal) throw refusal;
    } catch (error) {
      // What the error middleware would answer.
      answerWithError(res, error);
      break;
    }
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
    assert.equal(res.body.tierPolicy, 'ihub');
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

  it('writes the tier policy alone and keeps the sharing block', async () => {
    const res = await drive(route.put, { user: ROOT, body: { tierPolicy: 'both' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.tierPolicy, 'both');
    const stored = JSON.parse(
      await fs.readFile(path.join(scratch, 'config', 'platform.json'), 'utf8')
    );
    assert.equal(stored.projects.tierPolicy, 'both');
    assert.deepEqual(stored.projects.limits, { maxFiles: 10 });
    assert.equal(stored.projects.sharing.allowCatalog, true);
    assert.equal(configCache.getPlatform().projects.tierPolicy, 'both');
  });

  it('writes the default app of project chats, and clears it', async () => {
    assert.equal((await drive(route.get, { user: ROOT })).body.defaultAppId, '');
    const set = await drive(route.put, { user: ROOT, body: { defaultAppId: 'chat' } });
    assert.equal(set.statusCode, 200, JSON.stringify(set.body));
    assert.equal(set.body.defaultAppId, 'chat');
    const stored = JSON.parse(
      await fs.readFile(path.join(scratch, 'config', 'platform.json'), 'utf8')
    );
    assert.equal(stored.projects.defaultAppId, 'chat');
    assert.equal(stored.projects.tierPolicy, 'both', 'the other settings stay');
    const { projectsClientConfig } = await import('../services/projects/projectSettings.js');
    assert.equal(
      projectsClientConfig({}, configCache.getPlatform()).defaultAppId,
      'chat',
      'the client reads it from the platform config'
    );
    const cleared = await drive(route.put, { user: ROOT, body: { defaultAppId: '' } });
    assert.equal(cleared.body.defaultAppId, '');
    const invalid = await drive(route.put, { user: ROOT, body: { defaultAppId: '../x' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.headers['content-type'], 'application/problem+json');
    assert.equal(invalid.body.code, 'BAD_REQUEST');
  });

  it('reads the limits and the ceiling of the item count', async () => {
    const res = await drive(route.get, { user: ROOT });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.limits, {
      maxFiles: 10,
      maxFileBytes: 20 * 1024 * 1024,
      maxProjectBytes: 500 * 1024 * 1024,
      maxProjectsPerUser: 20
    });
    assert.equal(res.body.maxFilesCeiling, MAX_FILES_CEILING);
  });

  it('writes only the limits sent, and they apply without a restart', async () => {
    const res = await drive(route.put, {
      user: ROOT,
      body: { limits: { maxFiles: 150, maxProjectsPerUser: 0 } }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.limits.maxFiles, 150);
    assert.equal(res.body.limits.maxProjectsPerUser, 0);
    assert.equal(res.body.limits.maxFileBytes, 20 * 1024 * 1024, 'the default stays');
    const stored = JSON.parse(
      await fs.readFile(path.join(scratch, 'config', 'platform.json'), 'utf8')
    );
    assert.deepEqual(stored.projects.limits, { maxFiles: 150, maxProjectsPerUser: 0 });
    assert.equal(stored.projects.tierPolicy, 'both', 'the other settings stay');
    const { projectSettings, projectsClientConfig } =
      await import('../services/projects/projectSettings.js');
    // What the services and the upload route read on each request.
    assert.equal(projectSettings(configCache.getPlatform()).limits.maxFiles, 150);
    assert.equal(projectsClientConfig({}, configCache.getPlatform()).limits.maxFiles, 150);

    const bytes = await drive(route.put, {
      user: ROOT,
      body: { limits: { maxFileBytes: 50 * 1024 * 1024, maxProjectBytes: 1024 * 1024 * 1024 } }
    });
    assert.equal(bytes.statusCode, 200, JSON.stringify(bytes.body));
    assert.equal(bytes.body.limits.maxFiles, 150, 'an earlier limit stays');
    assert.equal(bytes.body.limits.maxProjectBytes, 1024 * 1024 * 1024);
  });

  it('refuses limits out of range or unknown', async () => {
    for (const limits of [
      { maxFiles: MAX_FILES_CEILING + 1 },
      { maxFiles: 0 },
      { maxFiles: 2.5 },
      { maxFileBytes: 0 },
      { maxProjectBytes: -1 },
      { maxProjectsPerUser: -1 },
      { maxFiles: '30' },
      { maxItems: 30 }
    ]) {
      const res = await drive(route.put, { user: ROOT, body: { limits } });
      assert.equal(res.statusCode, 400, JSON.stringify(limits));
      assert.equal(res.headers['content-type'], 'application/problem+json');
    }
    assert.equal(configCache.getPlatform().projects.limits.maxFiles, 150, 'nothing written');
  });

  it('refuses an unknown tier policy and an empty body', async () => {
    const unknown = await drive(route.put, { user: ROOT, body: { tierPolicy: 'cloud' } });
    assert.equal(unknown.statusCode, 400);
    const empty = await drive(route.put, { user: ROOT, body: {} });
    assert.equal(empty.statusCode, 400);
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

  it('reads and writes the cache settings, null going back to the built-in budget (#3650)', async () => {
    const read = await drive(route.get, { user: ROOT });
    assert.deepEqual(read.body.indexCache, { maxEntries: 32, maxHeapShare: null });
    assert.deepEqual(read.body.textCache, { maxHeapShare: null });

    const set = await drive(route.put, {
      user: ROOT,
      body: { indexCache: { maxEntries: 100, maxHeapShare: 0.2 }, textCache: { maxHeapShare: 0.1 } }
    });
    assert.equal(set.statusCode, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.indexCache, { maxEntries: 100, maxHeapShare: 0.2 });
    assert.deepEqual(set.body.textCache, { maxHeapShare: 0.1 });
    const platform = () =>
      fs.readFile(path.join(scratch, 'config', 'platform.json'), 'utf8').then(JSON.parse);
    assert.deepEqual((await platform()).projects.indexCache, {
      maxEntries: 100,
      maxHeapShare: 0.2
    });

    // Only what is sent changes; null removes the share and keeps the entries.
    const cleared = await drive(route.put, {
      user: ROOT,
      body: { indexCache: { maxHeapShare: null } }
    });
    assert.deepEqual(cleared.body.indexCache, { maxEntries: 100, maxHeapShare: null });
    assert.deepEqual((await platform()).projects.indexCache, { maxEntries: 100 });
    assert.deepEqual((await platform()).projects.textCache, { maxHeapShare: 0.1 });
  });

  it('refuses cache settings out of range or unknown (#3650)', async () => {
    for (const body of [
      { indexCache: { maxEntries: 0 } },
      { indexCache: { maxEntries: 10001 } },
      { indexCache: { maxEntries: 1.5 } },
      { indexCache: { maxHeapShare: 0.9 } },
      { textCache: { maxHeapShare: 0 } },
      { textCache: { maxEntries: 5 } }
    ]) {
      const res = await drive(route.put, { user: ROOT, body });
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
  });
});

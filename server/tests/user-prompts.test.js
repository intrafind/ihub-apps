/**
 * User prompts in the prompt library (#2519), driven through the real route
 * chains.
 *
 * Everything below the handlers is real: a filesystem storage provider over
 * `mkdtemp`, the prompt repository, the access policy and the settings. The
 * middleware in front of each route runs as registered — `requireFeature`
 * reads the feature cache, `authenticatedOnly` reads `req.user`.
 *
 * What is pinned here is what the library promises:
 *
 *  - a prompt is private until shared, and a share reaches exactly the users,
 *    groups (inheritance resolved) or everyone it names;
 *  - *can use* and *can edit* are enforced on the server, editors may share
 *    further, only the owner and admins delete;
 *  - revoking a share removes the prompt from the recipient at once;
 *  - a prompt whose owner is gone stays usable but read-only;
 *  - every save is a revision that can be restored;
 *  - anonymous callers and third-party tokens never see a user prompt;
 *  - favorites and recents live on the server.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { resolveGroupInheritance } from '../utils/authorization.js';
import { locateConfigFile } from '../utils/configFileLocation.js';
import {
  USER_PROMPT_SHARES_NAMESPACE,
  getUserPromptRepository,
  isUserPromptId,
  mergeRecents,
  shareMarkerKey
} from '../services/prompts/UserPromptRepository.js';
import {
  effectiveGroups,
  sharePermissionFor,
  userPromptPermissions
} from '../services/prompts/userPromptAccess.js';
import { userPromptSettings, allowedShareTargets } from '../services/prompts/userPromptSettings.js';
import { promptConfigSchema } from '../validators/promptConfigSchema.js';
import registerPromptRoutes from '../routes/promptRoutes.js';
import registerAdminPromptsRoutes, {
  globalPromptFromUserPrompt,
  slugifyPromptId
} from '../routes/admin/prompts.js';

const ADA = { id: 'user-ada', name: 'Ada Lovelace', groups: ['authenticated'] };
const GRACE = { id: 'user-grace', name: 'Grace Hopper', groups: ['authenticated'] };
const CAROL = { id: 'user-carol', name: 'Carol Shaw', groups: ['engineers'] };
const DAN = { id: 'user-dan', name: 'Dan Former', groups: ['authenticated'] };
const ROOT = { id: 'user-root', name: 'Root', groups: ['admins'] };
const THIRD_PARTY = { ...GRACE, authMode: 'oauth_authorization_code' };

let baseDir;
let platform;

function captureRoutes(register) {
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
  return routes;
}

const promptRoutes = captureRoutes(registerPromptRoutes);
const adminRoutes = captureRoutes(registerAdminPromptsRoutes);

function handlersFor(routes, method, suffix) {
  const route = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(route, `${method.toUpperCase()} ${suffix} must be registered`);
  return route.handlers;
}

function makeResponse() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.end = () => res;
  res.send = value => {
    res.body = value;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  return res;
}

async function drive(handlers, { params = {}, query = {}, body = {}, user, headers = {} } = {}) {
  // A fresh copy per request, the way the auth middleware builds one: the
  // routes attach resolved permissions to `req.user`.
  const req = {
    params,
    query,
    body,
    headers,
    user: user ? { ...user, groups: [...(user.groups || [])] } : undefined,
    ip: '127.0.0.1',
    method: 'GET',
    url: '/'
  };
  const res = makeResponse();
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

const route = {
  list: handlersFor(promptRoutes, 'get', '/api/prompts'),
  create: handlersFor(promptRoutes, 'post', '/api/prompts'),
  get: handlersFor(promptRoutes, 'get', '/api/prompts/:promptId'),
  update: handlersFor(promptRoutes, 'put', '/api/prompts/:promptId'),
  remove: handlersFor(promptRoutes, 'delete', '/api/prompts/:promptId'),
  shares: handlersFor(promptRoutes, 'put', '/api/prompts/:promptId/shares'),
  owner: handlersFor(promptRoutes, 'put', '/api/prompts/:promptId/owner'),
  duplicate: handlersFor(promptRoutes, 'post', '/api/prompts/:promptId/duplicate'),
  versions: handlersFor(promptRoutes, 'get', '/api/prompts/:promptId/versions'),
  restore: handlersFor(promptRoutes, 'post', '/api/prompts/:promptId/versions/:revision/restore'),
  usage: handlersFor(promptRoutes, 'post', '/api/prompts/:promptId/usage'),
  preferences: handlersFor(promptRoutes, 'get', '/api/prompts/preferences'),
  savePreferences: handlersFor(promptRoutes, 'put', '/api/prompts/preferences'),
  targets: handlersFor(promptRoutes, 'get', '/api/prompts/share-targets'),
  variables: handlersFor(promptRoutes, 'get', '/api/prompts/variables'),
  adminList: handlersFor(adminRoutes, 'get', '/api/admin/prompts')
};

async function list(user, scope) {
  const res = await drive(route.list, { user, query: scope ? { scope } : {} });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

async function create(user, body = {}) {
  const res = await drive(route.create, {
    user,
    body: { name: 'Email helper', prompt: 'Write a {{tone}} email to {{recipient}}.', ...body }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body;
}

async function share(user, promptId, shares) {
  return drive(route.shares, { user, params: { promptId }, body: { shares } });
}

function ids(items) {
  return items.map(item => item.id);
}

function setUserPromptSettings(overrides = {}) {
  platform.userPrompts = {
    enabled: true,
    maxPromptsPerUser: 0,
    maxVersions: 50,
    ...overrides,
    sharing: {
      allowUsers: true,
      allowGroups: true,
      allowEveryone: true,
      restrictToGroups: [],
      ...(overrides.sharing || {})
    }
  };
  configCache.setCacheEntry('config/platform.json', platform);
}

async function writeUsers(overrides = {}) {
  const users = {
    [ADA.id]: { ...ADA, username: 'ada', email: 'ada@example.com', active: true },
    [GRACE.id]: { ...GRACE, username: 'grace', email: 'grace@example.com', active: true },
    [CAROL.id]: { ...CAROL, username: 'carol', email: 'carol@example.com', active: true },
    [DAN.id]: { ...DAN, username: 'dan', email: 'dan@example.com', active: true },
    [ROOT.id]: { ...ROOT, username: 'root', active: true },
    ...overrides
  };
  const usersFile = path.join(baseDir, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  // The user database is read through the config cache; replace the cached copy.
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  return usersFile;
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-user-prompts-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  const usersFile = await writeUsers();
  platform = {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
    globalPromptVariables: { context: '', variables: { company: 'ACME' } }
  };
  setUserPromptSettings();
  configCache.setCacheEntry('config/features.json', { promptsLibrary: true });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        admins: {
          id: 'admins',
          name: 'Admins',
          permissions: { apps: ['*'], prompts: ['*'], models: ['*'], adminAccess: true }
        },
        engineers: {
          id: 'engineers',
          name: 'Engineers',
          inherits: ['authenticated'],
          permissions: { apps: ['*'], prompts: ['*'], models: ['*'] }
        },
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          inherits: ['anonymous'],
          permissions: { apps: ['*'], prompts: ['*'], models: ['*'] }
        },
        anonymous: {
          id: 'anonymous',
          name: 'Anonymous',
          permissions: { apps: ['chat'], prompts: ['summarize'], models: ['*'] }
        }
      }
    })
  );
  configCache.setCacheEntry('config/prompts.json', [
    {
      id: 'summarize',
      name: { en: 'Summarize', de: 'Zusammenfassen' },
      description: { en: 'Summarize text', de: 'Text zusammenfassen' },
      prompt: { en: 'Summarize: {{content}}', de: 'Fasse zusammen: {{content}}' },
      enabled: true
    },
    {
      id: 'internal',
      name: { en: 'Internal' },
      description: { en: 'Only for staff' },
      prompt: { en: 'Internal {{topic}}' },
      enabled: true
    }
  ]);
  configCache.setCacheEntry('config/apps.json', [{ id: 'chat', name: { en: 'Chat' } }]);
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(async () => {
  setUserPromptSettings();
  await writeUsers();
});

describe('creating and listing', () => {
  it('keeps a new prompt private to its owner', async () => {
    const prompt = await create(ADA, { name: 'Private one' });
    assert.ok(isUserPromptId(prompt.id));
    assert.equal(prompt.scope, 'mine');
    assert.equal(prompt.revision, 1);
    assert.equal(prompt.createdBy, 'Ada Lovelace');
    assert.deepEqual(prompt.permissions, {
      canEdit: true,
      canShare: true,
      canDelete: true,
      canTransfer: true,
      canDuplicate: true
    });

    assert.ok(ids(await list(ADA, 'mine')).includes(prompt.id));
    assert.ok(!ids(await list(GRACE)).includes(prompt.id));
    const direct = await drive(route.get, { user: GRACE, params: { promptId: prompt.id } });
    assert.equal(direct.statusCode, 404, 'an unshared prompt does not confirm it exists');
  });

  it('lists global prompts with their scope next to the user prompts', async () => {
    const items = await list(ADA);
    const global = items.find(item => item.id === 'summarize');
    assert.equal(global.scope, 'global');
    assert.equal(global.permissions.canEdit, false);
    assert.equal(global.permissions.canDuplicate, true);
    assert.ok(items.every(item => ['global', 'mine', 'shared'].includes(item.scope)));
    assert.ok((await list(ADA, 'global')).every(item => item.scope === 'global'));
  });

  it('refuses anonymous callers and third-party tokens', async () => {
    const anonymous = await drive(route.create, { body: { name: 'x', prompt: 'y' } });
    assert.equal(anonymous.statusCode, 401);
    const thirdParty = await drive(route.create, {
      user: THIRD_PARTY,
      body: { name: 'x', prompt: 'y' }
    });
    assert.equal(thirdParty.statusCode, 403);
  });

  it('gives anonymous visitors only the global prompts their group allows', async () => {
    const prompt = await create(ADA, { name: 'For everyone' });
    assert.equal(
      (await share(ADA, prompt.id, [{ type: 'everyone', permission: 'use' }])).statusCode,
      200
    );
    const items = await list(undefined);
    assert.deepEqual(ids(items), ['summarize']);
  });

  it('validates what it stores', async () => {
    const empty = await drive(route.create, { user: ADA, body: { name: '', prompt: 'x' } });
    assert.equal(empty.statusCode, 400);
    const badVariable = await drive(route.create, {
      user: ADA,
      body: { name: 'x', prompt: 'y', variables: [{ name: '1bad' }] }
    });
    assert.equal(badVariable.statusCode, 400);
    const unknownApp = await drive(route.create, {
      user: ADA,
      body: { name: 'x', prompt: 'y', appId: 'nope' }
    });
    assert.equal(unknownApp.statusCode, 400);
    const extra = await drive(route.create, {
      user: ADA,
      body: { name: 'x', prompt: 'y', ownerId: GRACE.id }
    });
    assert.equal(extra.statusCode, 400, 'the owner is the caller, never the body');
  });

  it('enforces the per-user limit', async () => {
    setUserPromptSettings({ maxPromptsPerUser: 1 });
    await create(CAROL, { name: 'first' });
    const second = await drive(route.create, {
      user: CAROL,
      body: { name: 'second', prompt: 'x' }
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.body.details.code, 'PROMPT_LIMIT_REACHED');
  });

  it('answers 403 when user prompts are switched off, and keeps global prompts listed', async () => {
    setUserPromptSettings({ enabled: false });
    const res = await drive(route.create, { user: ADA, body: { name: 'x', prompt: 'y' } });
    assert.equal(res.statusCode, 403);
    const items = await list(ADA);
    assert.ok(items.length > 0 && items.every(item => item.scope === 'global'));
  });

  it('lets prompt admins look after existing prompts while user prompts are off', async () => {
    const prompt = await create(ADA, { name: 'Left behind' });
    await share(ADA, prompt.id, [{ type: 'group', id: 'engineers', permission: 'use' }]);
    setUserPromptSettings({ enabled: false });
    const params = { promptId: prompt.id };

    const owner = await drive(route.get, { user: ADA, params });
    assert.equal(owner.statusCode, 403, 'users do not reach their prompts while it is off');
    assert.equal(owner.body.details.code, 'USER_PROMPTS_DISABLED');

    assert.equal((await drive(route.get, { user: ROOT, params })).statusCode, 200);
    assert.equal((await drive(route.versions, { user: ROOT, params })).statusCode, 200);
    const unshared = await share(ROOT, prompt.id, []);
    assert.equal(unshared.statusCode, 200, JSON.stringify(unshared.body));
    const removed = await drive(route.remove, { user: ROOT, params });
    assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));

    const created = await drive(route.create, { user: ROOT, body: { name: 'x', prompt: 'y' } });
    assert.equal(created.statusCode, 403, 'nobody creates new ones, admins included');
  });
});

describe('sharing', () => {
  it('shares with a user as "can use": listed and usable, not editable', async () => {
    const prompt = await create(ADA);
    const res = await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.shares, [
      { type: 'user', id: GRACE.id, name: 'Grace Hopper', permission: 'use' }
    ]);

    const shared = (await list(GRACE, 'shared')).find(item => item.id === prompt.id);
    assert.ok(shared, 'Grace sees the prompt under "shared with me"');
    assert.equal(shared.scope, 'shared');
    assert.equal(shared.owner.name, 'Ada Lovelace');
    assert.equal(shared.owner.id, undefined, 'a recipient learns the owner by name only');
    assert.equal(shared.shares, undefined, 'and not who else it is shared with');
    assert.equal(shared.permissions.canEdit, false);

    const edit = await drive(route.update, {
      user: GRACE,
      params: { promptId: prompt.id },
      body: { name: 'Hijacked', prompt: 'x' }
    });
    assert.equal(edit.statusCode, 403);
    const reshare = await share(GRACE, prompt.id, []);
    assert.equal(reshare.statusCode, 403);
    const del = await drive(route.remove, { user: GRACE, params: { promptId: prompt.id } });
    assert.equal(del.statusCode, 403);
  });

  it('lets "can edit" change the prompt and share it further, but not delete it', async () => {
    const prompt = await create(ADA);
    await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'edit' }]);

    const edited = await drive(route.update, {
      user: GRACE,
      params: { promptId: prompt.id },
      body: { name: 'Email helper v2', prompt: 'Write to {{recipient}}.', expectedRevision: 1 }
    });
    assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.revision, 2);
    assert.equal(edited.body.updatedBy, 'Grace Hopper');
    assert.equal(edited.body.createdBy, 'Ada Lovelace');

    const stale = await drive(route.update, {
      user: ADA,
      params: { promptId: prompt.id },
      body: { name: 'Old tab', prompt: 'x', expectedRevision: 1 }
    });
    assert.equal(stale.statusCode, 409, 'a save from an outdated editor does not overwrite');

    const reshare = await share(GRACE, prompt.id, [
      { type: 'user', id: GRACE.id, permission: 'edit' },
      { type: 'user', id: CAROL.id, permission: 'use' }
    ]);
    assert.equal(reshare.statusCode, 200, JSON.stringify(reshare.body));
    assert.ok(ids(await list(CAROL)).includes(prompt.id));

    const del = await drive(route.remove, { user: GRACE, params: { promptId: prompt.id } });
    assert.equal(del.statusCode, 403);
  });

  it('reaches a group and every group that inherits it', async () => {
    const prompt = await create(ADA);
    const res = await share(ADA, prompt.id, [
      { type: 'group', id: 'authenticated', permission: 'use' }
    ]);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    // Carol is in `engineers`, which inherits `authenticated`.
    assert.ok(ids(await list(CAROL)).includes(prompt.id));
    assert.ok(ids(await list(GRACE)).includes(prompt.id));
    assert.ok(!ids(await list(ROOT)).includes(prompt.id), 'admins does not inherit it');
  });

  it('reaches every signed-in user with "everyone", never an anonymous one', async () => {
    const prompt = await create(ADA);
    await share(ADA, prompt.id, [{ type: 'everyone', permission: 'use' }]);
    assert.ok(ids(await list(ROOT)).includes(prompt.id));
    assert.ok(ids(await list(CAROL)).includes(prompt.id));
    assert.ok(!ids(await list(undefined)).includes(prompt.id));
    assert.equal((await drive(route.get, { params: { promptId: prompt.id } })).statusCode, 404);
  });

  it('removes a revoked prompt from the recipient at once', async () => {
    const prompt = await create(ADA);
    await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    assert.ok(ids(await list(GRACE)).includes(prompt.id));
    const revoke = await share(ADA, prompt.id, []);
    assert.equal(revoke.statusCode, 200);
    assert.ok(!ids(await list(GRACE)).includes(prompt.id));
    assert.equal(
      (await drive(route.get, { user: GRACE, params: { promptId: prompt.id } })).statusCode,
      404
    );
  });

  it('stops a write whose access was revoked while it waited for the lock', async () => {
    const prompt = await create(ADA);
    await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'edit' }]);
    const repo = getUserPromptRepository();

    // Hold Grace's save at the lock, after the route has checked her access
    // on the prompt it read, and revoke her share in that gap.
    let reachedLock;
    const reached = new Promise(resolve => (reachedLock = resolve));
    let openGate;
    const gate = new Promise(resolve => (openGate = resolve));
    repo._withLock = (promptId, fn) => {
      delete repo._withLock;
      reachedLock();
      return gate.then(() => repo._withLock(promptId, fn));
    };
    try {
      const pending = drive(route.update, {
        user: GRACE,
        params: { promptId: prompt.id },
        body: { name: 'Too late', prompt: 'Changed after the revoke' }
      });
      await reached;
      assert.equal((await share(ADA, prompt.id, [])).statusCode, 200);
      openGate();
      const late = await pending;
      assert.equal(late.statusCode, 403, JSON.stringify(late.body));
      assert.equal(late.body.details.code, 'PROMPT_ACCESS_CHANGED');
    } finally {
      delete repo._withLock;
      openGate();
    }
    const stored = await repo.get(prompt.id);
    assert.equal(stored.revision, 1, 'the revoked editor wrote nothing');
    assert.notEqual(stored.name, 'Too late');
  });

  it('never lets a marker the prompt does not back grant access', async () => {
    const prompt = await create(ADA);
    const repo = getUserPromptRepository();
    // A marker filed under Grace, as a lost write could leave behind.
    await repo.documents.put(
      USER_PROMPT_SHARES_NAMESPACE,
      shareMarkerKey(prompt.id, `user:${GRACE.id}`),
      { promptId: prompt.id, target: `user:${GRACE.id}` },
      { ownerId: `user:${GRACE.id}` }
    );
    assert.ok(!ids(await list(GRACE)).includes(prompt.id));
    assert.ok(!ids(await list(ROOT)).includes(prompt.id), 'not even for an admin');
  });

  it('refuses unknown targets, the anonymous group and disabled audiences', async () => {
    const prompt = await create(ADA);
    const unknown = await share(ADA, prompt.id, [
      { type: 'user', id: 'nobody', permission: 'use' }
    ]);
    assert.equal(unknown.statusCode, 400);
    assert.deepEqual(unknown.body.details.unknown, ['nobody']);
    const anon = await share(ADA, prompt.id, [
      { type: 'group', id: 'anonymous', permission: 'use' }
    ]);
    assert.equal(anon.statusCode, 400);

    setUserPromptSettings({ sharing: { allowEveryone: false } });
    const everyone = await share(ADA, prompt.id, [{ type: 'everyone', permission: 'use' }]);
    assert.equal(everyone.statusCode, 403);
    assert.equal(everyone.body.details.code, 'SHARE_TARGET_NOT_ALLOWED');

    setUserPromptSettings({ sharing: { restrictToGroups: ['engineers'] } });
    const group = await share(ADA, prompt.id, [
      { type: 'group', id: 'engineers', permission: 'use' }
    ]);
    assert.equal(group.statusCode, 403, 'only engineers may share with groups now');
    const carolPrompt = await create(CAROL);
    const allowed = await share(CAROL, carolPrompt.id, [
      { type: 'group', id: 'engineers', permission: 'use' }
    ]);
    assert.equal(allowed.statusCode, 200, JSON.stringify(allowed.body));
    const user = await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    assert.equal(user.statusCode, 200, 'sharing with named users stays open');
  });

  it('keeps an existing broad share when an editor without broad rights saves', async () => {
    const prompt = await create(CAROL);
    await share(CAROL, prompt.id, [
      { type: 'everyone', permission: 'use' },
      { type: 'user', id: GRACE.id, permission: 'edit' }
    ]);
    setUserPromptSettings({ sharing: { restrictToGroups: ['engineers'] } });
    const res = await share(GRACE, prompt.id, [
      { type: 'everyone', permission: 'use' },
      { type: 'user', id: GRACE.id, permission: 'edit' },
      { type: 'user', id: ADA.id, permission: 'use' }
    ]);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });

  it('never stores a share to the owner', async () => {
    const prompt = await create(ADA);
    const res = await share(ADA, prompt.id, [{ type: 'user', id: ADA.id, permission: 'edit' }]);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.shares, []);
  });

  it('looks up share targets without the caller and never the anonymous group', async () => {
    const res = await drive(route.targets, { user: ADA, query: { q: 'ra' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.users.map(user => user.id),
      [GRACE.id],
      '"ra" matches Grace only'
    );
    const self = await drive(route.targets, { user: ADA, query: { q: 'ada' } });
    assert.deepEqual(self.body.users, [], 'the caller is never offered to themselves');
    const all = await drive(route.targets, { user: ADA, query: {} });
    assert.deepEqual(all.body.users, [], 'users need a search of two characters');
    assert.ok(!all.body.groups.some(group => group.id === 'anonymous'));
    assert.ok(all.body.groups.some(group => group.id === 'engineers'));
  });

  it('offers at most ten groups, whatever the directory holds', async () => {
    const original = configCache.getGroups().data;
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => {
        const id = `team-${String(i).padStart(2, '0')}`;
        return [id, { id, name: `Team ${i}`, permissions: { apps: ['*'] } }];
      })
    );
    configCache.setCacheEntry(
      'config/groups.json',
      resolveGroupInheritance({ groups: { ...original.groups, ...many } })
    );
    try {
      const res = await drive(route.targets, { user: ADA, query: { q: 'team' } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.groups.length, 10);
      assert.ok(res.body.groups.every(group => group.id.startsWith('team-')));
      const narrow = await drive(route.targets, { user: ADA, query: { q: 'team 3' } });
      assert.deepEqual(
        narrow.body.groups.map(group => group.id),
        [
          'team-03',
          'team-30',
          'team-31',
          'team-32',
          'team-33',
          'team-34',
          'team-35',
          'team-36',
          'team-37',
          'team-38'
        ],
        'a narrower search finds the rest'
      );
    } finally {
      configCache.setCacheEntry('config/groups.json', original);
    }
  });
});

describe('ownership', () => {
  it('only the owner deletes, and deleting takes the markers along', async () => {
    const prompt = await create(ADA);
    await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'edit' }]);
    const res = await drive(route.remove, { user: ADA, params: { promptId: prompt.id } });
    assert.equal(res.statusCode, 200);
    assert.ok(!ids(await list(GRACE)).includes(prompt.id));
    const marker = await getUserPromptRepository().documents.get(
      USER_PROMPT_SHARES_NAMESPACE,
      shareMarkerKey(prompt.id, `user:${GRACE.id}`)
    );
    assert.equal(marker, null);
  });

  it('keeps a prompt whose owner is gone usable but read-only', async () => {
    const prompt = await create(DAN);
    await share(DAN, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'edit' }]);
    await writeUsers({ [DAN.id]: { ...DAN, username: 'dan', active: false } });

    const seen = (await list(GRACE)).find(item => item.id === prompt.id);
    assert.ok(seen, 'still shared');
    assert.equal(seen.readOnly, true);
    assert.equal(seen.owner.active, false);
    assert.equal(seen.permissions.canEdit, false);
    const edit = await drive(route.update, {
      user: GRACE,
      params: { promptId: prompt.id },
      body: { name: 'x', prompt: 'y' }
    });
    assert.equal(edit.statusCode, 403);

    const admin = await drive(route.update, {
      user: ROOT,
      params: { promptId: prompt.id },
      body: { name: 'Fixed by admin', prompt: 'y' }
    });
    assert.equal(admin.statusCode, 200, 'an admin still can');
  });

  it('hands a prompt to another user', async () => {
    const prompt = await create(ADA);
    await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    const denied = await drive(route.owner, {
      user: GRACE,
      params: { promptId: prompt.id },
      body: { ownerId: GRACE.id }
    });
    assert.equal(denied.statusCode, 403);
    const res = await drive(route.owner, {
      user: ADA,
      params: { promptId: prompt.id },
      body: { ownerId: GRACE.id }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const mine = (await list(GRACE, 'mine')).find(item => item.id === prompt.id);
    assert.ok(mine, 'Grace owns it now');
    assert.deepEqual(mine.shares, [], 'the share to the new owner went');
    assert.ok(!ids(await list(ADA)).includes(prompt.id));
  });

  it('keeps the per-user limit when handing a prompt over', async () => {
    const prompt = await create(ADA);
    await create(GRACE, { name: 'Grace already has one' });
    setUserPromptSettings({ maxPromptsPerUser: (await list(GRACE, 'mine')).length });
    const res = await drive(route.owner, {
      user: ADA,
      params: { promptId: prompt.id },
      body: { ownerId: GRACE.id }
    });
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.details.code, 'PROMPT_LIMIT_REACHED');
    assert.ok(ids(await list(ADA, 'mine')).includes(prompt.id), 'it stays with Ada');
  });
});

describe('versions', () => {
  it('saves each change as a revision and restores an old one', async () => {
    const prompt = await create(ADA, { name: 'v1', prompt: 'first' });
    await drive(route.update, {
      user: ADA,
      params: { promptId: prompt.id },
      body: { name: 'v2', prompt: 'second' }
    });
    const same = await drive(route.update, {
      user: ADA,
      params: { promptId: prompt.id },
      body: { name: 'v2', prompt: 'second' }
    });
    assert.equal(same.body.revision, 2, 'a save that changes nothing is no revision');

    const history = await drive(route.versions, { user: ADA, params: { promptId: prompt.id } });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(
      history.body.versions.map(v => [v.revision, v.prompt]),
      [
        [2, 'second'],
        [1, 'first']
      ]
    );

    const restored = await drive(route.restore, {
      user: ADA,
      params: { promptId: prompt.id, revision: '1' }
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.body.revision, 3);
    assert.equal(restored.body.prompt, 'first');
  });

  it('keeps history from those who may only use the prompt', async () => {
    const prompt = await create(ADA);
    await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    const res = await drive(route.versions, { user: GRACE, params: { promptId: prompt.id } });
    assert.equal(res.statusCode, 403);
  });

  it('prunes the oldest revisions past the cap', async () => {
    setUserPromptSettings({ maxVersions: 2 });
    const prompt = await create(ADA, { prompt: 'r1' });
    for (const text of ['r2', 'r3', 'r4']) {
      await drive(route.update, {
        user: ADA,
        params: { promptId: prompt.id },
        body: { name: 'n', prompt: text }
      });
    }
    const history = await drive(route.versions, { user: ADA, params: { promptId: prompt.id } });
    assert.deepEqual(
      history.body.versions.map(v => v.revision),
      [4, 3]
    );
  });
});

describe('duplicating', () => {
  it('copies a global prompt into "My prompts" in the chosen language', async () => {
    const res = await drive(route.duplicate, {
      user: GRACE,
      params: { promptId: 'summarize' },
      body: { language: 'de' }
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.scope, 'mine');
    assert.equal(res.body.name, 'Zusammenfassen');
    assert.equal(res.body.prompt, 'Fasse zusammen: {{content}}');
    assert.deepEqual(res.body.copiedFrom, { scope: 'global', id: 'summarize' });
  });

  it('copies a shared prompt, and nothing that is not visible', async () => {
    const prompt = await create(ADA, { name: 'Original' });
    const hidden = await drive(route.duplicate, {
      user: GRACE,
      params: { promptId: prompt.id },
      body: {}
    });
    assert.equal(hidden.statusCode, 404);
    await share(ADA, prompt.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    const copy = await drive(route.duplicate, {
      user: GRACE,
      params: { promptId: prompt.id },
      body: { name: 'My copy' }
    });
    assert.equal(copy.statusCode, 201);
    assert.equal(copy.body.name, 'My copy');
    assert.equal(copy.body.permissions.canEdit, true);
  });

  it('refuses to edit a global prompt through the user API', async () => {
    const res = await drive(route.update, {
      user: ROOT,
      params: { promptId: 'summarize' },
      body: { name: 'x', prompt: 'y' }
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.details.code, 'GLOBAL_PROMPT_READ_ONLY');
  });
});

describe('favorites, recents and variables', () => {
  it('stores favorites and recents on the server', async () => {
    const empty = await drive(route.preferences, { user: CAROL });
    assert.equal(empty.body.stored, false);
    const saved = await drive(route.savePreferences, {
      user: CAROL,
      body: { favorites: ['summarize', 'summarize', '../etc'] }
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.body.favorites, ['summarize']);
    await drive(route.usage, { user: CAROL, params: { promptId: 'summarize' } });
    const after = await drive(route.preferences, { user: CAROL });
    assert.equal(after.body.stored, true);
    assert.deepEqual(
      after.body.recents.map(entry => entry.id),
      ['summarize']
    );
    const favorites = await list(CAROL, 'favorites');
    assert.deepEqual(ids(favorites), ['summarize']);
  });

  it('merges recents newest first and drops what is not an id', () => {
    const merged = mergeRecents(
      [{ id: 'a', at: '2026-09-01T00:00:00Z' }],
      [
        { id: 'b', at: '2026-09-02T00:00:00Z' },
        { id: 'a', at: '2026-09-03T00:00:00Z' },
        { id: '../x', at: '2026-09-04T00:00:00Z' }
      ]
    );
    assert.deepEqual(
      merged.map(entry => entry.id),
      ['a', 'b']
    );
  });

  it('resolves the global variables a prompt fills in by itself', async () => {
    const res = await drive(route.variables, { user: ADA });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.values.user_name, 'Ada Lovelace');
    assert.equal(res.body.values.company, 'ACME');
    assert.ok(res.body.autoNames.includes('company'));
    assert.ok(res.body.autoNames.includes('date'));
    assert.ok(!res.body.autoNames.includes('tone'));
  });
});

describe('the admin view', () => {
  it('lists user prompts shared with groups or everyone, and only those', async () => {
    const broad = await create(ADA, { name: 'Broad' });
    await share(ADA, broad.id, [{ type: 'group', id: 'engineers', permission: 'use' }]);
    const narrow = await create(ADA, { name: 'Narrow' });
    await share(ADA, narrow.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    const res = await drive(route.adminList, { user: ROOT, query: { scope: 'user' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const listed = ids(res.body.prompts);
    assert.ok(listed.includes(broad.id));
    assert.ok(!listed.includes(narrow.id));
    const entry = res.body.prompts.find(item => item.id === broad.id);
    assert.equal(entry.owner.id, ADA.id);
    assert.equal(entry.permissions.canDelete, true);
  });

  it('bounds the scan by documents read, not by prompts kept', async () => {
    await create(ADA, { name: 'Scan one' });
    await create(ADA, { name: 'Scan two' });
    await create(ADA, { name: 'Scan three' });
    const repo = getUserPromptRepository();
    const none = await repo.scan({ filter: () => false, maxScanned: 2 });
    assert.deepEqual(none, { prompts: [], truncated: true });
    const capped = await repo.scan({ max: 1 });
    assert.equal(capped.prompts.length, 1);
    assert.equal(capped.truncated, true);
    const all = await repo.scan();
    assert.equal(all.truncated, false);
    assert.equal((await repo.scan({ maxScanned: all.prompts.length })).truncated, false);
  });

  it('is closed to everyone else', async () => {
    const res = await drive(route.adminList, { user: GRACE, query: { scope: 'user' } });
    assert.equal(res.statusCode, 403);
  });

  it('builds a valid global prompt from a user prompt, keeping the author', () => {
    const globalPrompt = globalPromptFromUserPrompt(
      {
        id: 'upr_x',
        name: 'Weekly report',
        description: '',
        prompt: 'Report for {{team}}',
        ownerId: ADA.id,
        ownerName: 'Ada Lovelace',
        createdBy: { id: ADA.id, name: 'Ada Lovelace' },
        createdAt: '2026-09-01T00:00:00.000Z',
        variables: [
          {
            name: 'team',
            label: 'Team',
            type: 'select',
            predefinedValues: [{ label: 'Core', value: 'core' }]
          }
        ]
      },
      {
        id: 'weekly-report',
        language: 'en',
        enabled: true,
        promotedBy: 'Root',
        now: '2026-09-29T00:00:00.000Z'
      }
    );
    const parsed = promptConfigSchema.safeParse(globalPrompt);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(globalPrompt.createdBy, 'Ada Lovelace');
    assert.equal(globalPrompt.updatedBy, 'Root');
    assert.equal(globalPrompt.sourcePromptId, 'upr_x');
    assert.deepEqual(globalPrompt.description, { en: 'Weekly report' });
    assert.deepEqual(globalPrompt.variables[0].label, { en: 'Team' });
    assert.equal(slugifyPromptId('Wöchentlicher Bericht!'), 'wochentlicher-bericht');
    assert.equal(slugifyPromptId('!!!'), 'prompt');
  });
});

describe('the access policy', () => {
  const prompt = {
    ownerId: ADA.id,
    shares: [
      { type: 'group', id: 'authenticated', permission: 'use' },
      { type: 'user', id: GRACE.id, permission: 'edit' }
    ]
  };

  it('takes the strongest share that reaches the caller', () => {
    assert.equal(sharePermissionFor(prompt, GRACE, ['authenticated']), 'edit');
    assert.equal(sharePermissionFor(prompt, CAROL, ['engineers', 'authenticated']), 'use');
    assert.equal(sharePermissionFor(prompt, CAROL, ['engineers']), null);
    assert.equal(sharePermissionFor(prompt, { id: 'anonymous' }, ['authenticated']), null);
  });

  it('resolves inherited groups transitively', () => {
    const groups = effectiveGroups(CAROL, {
      groups: {
        engineers: { inherits: ['authenticated'] },
        authenticated: { inherits: ['anonymous'] },
        anonymous: {}
      }
    });
    assert.deepEqual(groups.sort(), ['anonymous', 'authenticated', 'engineers']);
  });

  it('lets only owners and admins delete or hand over', () => {
    const editor = userPromptPermissions(prompt, GRACE, { groups: ['authenticated'] });
    assert.equal(editor.canEdit, true);
    assert.equal(editor.canShare, true);
    assert.equal(editor.canDelete, false);
    assert.equal(editor.canTransfer, false);
    const admin = userPromptPermissions(prompt, ROOT, { isAdmin: true });
    assert.equal(admin.canDelete, true);
    assert.equal(admin.access, 'admin');
    const stranger = userPromptPermissions(prompt, DAN, { groups: [] });
    assert.equal(stranger.canView, false);
  });

  it('reads the settings block with every default filled in', () => {
    const settings = userPromptSettings({ userPrompts: { maxVersions: 0, sharing: {} } });
    assert.equal(settings.enabled, true);
    assert.equal(settings.maxVersions, 50, 'history is always kept');
    assert.deepEqual(allowedShareTargets(settings, []), {
      user: true,
      group: true,
      everyone: true
    });
    const restricted = userPromptSettings({
      userPrompts: { sharing: { restrictToGroups: ['engineers'] } }
    });
    assert.deepEqual(allowedShareTargets(restricted, ['users']), {
      user: true,
      group: false,
      everyone: false
    });
  });
});

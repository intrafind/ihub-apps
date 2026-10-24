// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The projects API driven through the real route chains (#1036, spec 1 §5,
 * §6.4, §7): `requireFeature`, `authenticatedOnly` and
 * `projectAccessRequired` run as registered over a filesystem storage
 * provider in a scratch directory (whose parent is the config view, so admin
 * projects land in `<scratch>/projects/`).
 *
 * What is pinned here:
 *
 *  - a project is private until shared; an editor may change it, a user may
 *    only use it; only the owner deletes; a stranger gets a 404;
 *  - the `projects` and `projectSharing` group permissions gate creating and
 *    sharing; the platform's sharing audiences are enforced;
 *  - an admin project is readable by whoever may use an app that links it,
 *    editable by content admins, and cannot be deleted while linked;
 *  - a full admin lists every user project for compliance; a content admin
 *    does not;
 *  - a chat moves into a project and the project lists it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { enhanceUserWithPermissions, resolveGroupInheritance } from '../utils/authorization.js';
import { locateConfigFile } from '../utils/configFileLocation.js';
import registerProjectRoutes from '../routes/projectRoutes.js';
import registerAdminProjectsRoutes from '../routes/admin/projects.js';
import registerChatRoutes from '../routes/chats.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { authorizeChat } from '../services/chat/chatAccess.js';
import { getProjectRepository } from '../services/projects/ProjectRepository.js';
import { getProjectService } from '../services/projects/ProjectService.js';
import { cleanUpProjectsOfUser } from '../services/projects/projectUserCleanup.js';
import { resolveChatProjects } from '../services/knowledge/chatProjects.js';
import { content as projectSourceContent } from '../services/sources/providers/project.js';
import { listSnapshots } from '../services/ChangeHistoryService.js';

const ADA = { id: 'user-ada', name: 'Ada Lovelace', groups: ['authenticated'] };
const GRACE = { id: 'user-grace', name: 'Grace Hopper', groups: ['authenticated'] };
const CAROL = { id: 'user-carol', name: 'Carol Shaw', groups: ['engineers'] };
const EDITOR = { id: 'user-editor', name: 'Content Editor', groups: ['editors'] };
const ROOT = { id: 'user-root', name: 'Root', groups: ['admins'] };
const NOBODY = { id: 'user-nobody', name: 'No Projects', groups: ['readers'] };
const SOLO = { id: 'user-solo', name: 'Keeps To Herself', groups: ['solo'] };
const RUNNER = { id: 'user-runner', name: 'Workflow Runner', groups: ['runners'] };
const THIRD_PARTY = { ...GRACE, authMode: 'oauth_authorization_code' };

let scratch;
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

const projectRoutes = captureRoutes(registerProjectRoutes);
const adminRoutes = captureRoutes(registerAdminProjectsRoutes);
const chatRoutes = captureRoutes(registerChatRoutes);

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

async function drive(handlers, { params = {}, query = {}, body = {}, user } = {}) {
  const req = {
    params,
    query,
    body,
    headers: {},
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
  config: handlersFor(projectRoutes, 'get', '/api/projects/_config'),
  targets: handlersFor(projectRoutes, 'get', '/api/projects/share-targets'),
  list: handlersFor(projectRoutes, 'get', '/api/projects'),
  create: handlersFor(projectRoutes, 'post', '/api/projects'),
  get: handlersFor(projectRoutes, 'get', '/api/projects/:projectId'),
  update: handlersFor(projectRoutes, 'patch', '/api/projects/:projectId'),
  remove: handlersFor(projectRoutes, 'delete', '/api/projects/:projectId'),
  items: handlersFor(projectRoutes, 'get', '/api/projects/:projectId/items'),
  addItem: handlersFor(projectRoutes, 'post', '/api/projects/:projectId/items'),
  removeItem: handlersFor(projectRoutes, 'delete', '/api/projects/:projectId/items/:itemId'),
  members: handlersFor(projectRoutes, 'put', '/api/projects/:projectId/members'),
  transfer: handlersFor(projectRoutes, 'post', '/api/projects/:projectId/transfer'),
  chats: handlersFor(projectRoutes, 'get', '/api/projects/:projectId/chats'),
  catalog: handlersFor(projectRoutes, 'get', '/api/projects/_catalog'),
  publish: handlersFor(projectRoutes, 'put', '/api/projects/:projectId/catalog'),
  subscribe: handlersFor(projectRoutes, 'post', '/api/projects/:projectId/subscription'),
  unsubscribe: handlersFor(projectRoutes, 'delete', '/api/projects/:projectId/subscription'),
  estimate: handlersFor(projectRoutes, 'post', '/api/projects/:projectId/estimate'),
  adminEstimate: handlersFor(adminRoutes, 'post', '/api/admin/projects/:id/estimate'),
  adminList: handlersFor(adminRoutes, 'get', '/api/admin/projects'),
  adminCreate: handlersFor(adminRoutes, 'post', '/api/admin/projects'),
  adminGet: handlersFor(adminRoutes, 'get', '/api/admin/projects/:id'),
  adminPatch: handlersFor(adminRoutes, 'patch', '/api/admin/projects/:id'),
  adminDelete: handlersFor(adminRoutes, 'delete', '/api/admin/projects/:id'),
  adminDeps: handlersFor(adminRoutes, 'get', '/api/admin/projects/_dependencies/:id'),
  adminToggle: handlersFor(adminRoutes, 'post', '/api/admin/projects/_toggle'),
  adminAddItem: handlersFor(adminRoutes, 'post', '/api/admin/projects/:id/items'),
  adminPut: handlersFor(adminRoutes, 'put', '/api/admin/projects/:id'),
  adminMove: handlersFor(adminRoutes, 'post', '/api/admin/projects/_move'),
  adminCopy: handlersFor(adminRoutes, 'post', '/api/admin/projects/_copy'),
  adminMerge: handlersFor(adminRoutes, 'post', '/api/admin/projects/_merge'),
  chatPatch: handlersFor(chatRoutes, 'patch', '/api/chats/:chatId'),
  chatDelete: handlersFor(chatRoutes, 'delete', '/api/chats/:chatId')
};

async function create(user, body = {}) {
  const res = await drive(route.create, { user, body: { name: 'Case 2026-114', ...body } });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body;
}

async function setMembers(user, projectId, members) {
  return drive(route.members, { user, params: { projectId }, body: { members } });
}

/**
 * Put a stored chat into a project the way a chat started there is: its
 * `projectId` and the project's marker follow together. A chat is never moved
 * through the API, so the tests set it up directly.
 */
async function joinProject(chat, projectId, ownerId = ADA.id) {
  const { moved } = await getChatRepository().moveProjectIf(chat.id, null, projectId, {
    settle: () => getProjectService().attachChat(projectId, chat.id, { ownerId })
  });
  assert.equal(moved, true, `chat ${chat.id} joins ${projectId}`);
}

function setProjectSettings(overrides = {}) {
  platform.projects = {
    limits: { maxFiles: 25, maxFileBytes: 1000, maxProjectBytes: 10000, maxProjectsPerUser: 0 },
    ...overrides,
    sharing: {
      allowUsers: true,
      allowGroups: true,
      allowEveryone: false,
      ...(overrides.sharing || {})
    }
  };
  configCache.setCacheEntry('config/platform.json', platform);
}

function setFeatures(overrides = {}) {
  configCache.setCacheEntry('config/features.json', {
    projects: true,
    userProjects: true,
    chatPersistence: true,
    ...overrides
  });
}

async function writeUsers() {
  const users = {};
  for (const user of [ADA, GRACE, CAROL, EDITOR, ROOT, NOBODY, SOLO]) {
    users[user.id] = { ...user, username: user.id.replace('user-', ''), active: true };
  }
  const usersFile = path.join(scratch, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  return usersFile;
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-routes-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const usersFile = await writeUsers();
  platform = {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
    chats: { enabled: true }
  };
  setProjectSettings();
  setFeatures();
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        admins: {
          id: 'admins',
          name: 'Admins',
          permissions: { apps: ['*'], adminAccess: true, projects: true, projectSharing: true }
        },
        editors: {
          id: 'editors',
          name: 'Content editors',
          inherits: ['authenticated'],
          permissions: { apps: ['*'], contentAdmin: true }
        },
        engineers: {
          id: 'engineers',
          name: 'Engineers',
          inherits: ['authenticated'],
          permissions: { apps: ['*'] }
        },
        readers: {
          id: 'readers',
          name: 'Readers',
          permissions: { apps: ['support'] }
        },
        solo: {
          id: 'solo',
          name: 'Projects without sharing',
          permissions: { apps: ['chat'], projects: true, projectSharing: false }
        },
        runners: {
          id: 'runners',
          name: 'Runners',
          permissions: { apps: ['chat'], workflows: ['wf-link'] }
        },
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          inherits: ['anonymous'],
          permissions: { apps: ['chat'], projects: true, projectSharing: true }
        },
        anonymous: {
          id: 'anonymous',
          name: 'Anonymous',
          permissions: { apps: ['chat'] }
        }
      }
    })
  );
  configCache.setCacheEntry('config/apps.json', [
    { id: 'chat', name: { en: 'Chat' }, enabled: true },
    {
      id: 'support',
      name: { en: 'Support' },
      enabled: true,
      projects: ['faq', { id: 'docs', mode: 'tools' }]
    }
  ]);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/agents.json', []);
  configCache.setCacheEntry('config/projects.json', []);
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  setProjectSettings();
  setFeatures();
});

describe('configuration and gates', () => {
  it('tells a user what they may do', async () => {
    const res = await drive(route.config, { user: ADA });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.userProjects.enabled, true);
    assert.equal(res.body.userProjects.canCreate, true);
    assert.equal(res.body.userProjects.canShare, true);
    assert.ok(res.body.kinds.some(kind => kind.id === 'url'));
    assert.equal(
      res.body.kinds.some(kind => kind.id === 'ifinder-document'),
      false
    );
    const nobody = await drive(route.config, { user: NOBODY });
    assert.equal(nobody.body.userProjects.canCreate, false);
  });

  it('refuses anonymous callers, third-party tokens and users without the permission', async () => {
    assert.equal((await drive(route.create, { body: { name: 'x' } })).statusCode, 401);
    const thirdParty = await drive(route.create, { user: THIRD_PARTY, body: { name: 'x' } });
    assert.equal(thirdParty.statusCode, 403);
    assert.equal(thirdParty.body.details.code, 'PROJECTS_NOT_ALLOWED');
    const nobody = await drive(route.create, { user: NOBODY, body: { name: 'x' } });
    assert.equal(nobody.statusCode, 403);
    assert.equal(nobody.body.details.code, 'PERMISSION_DENIED');
  });

  it('keeps user projects dark while the flag is off', async () => {
    const existing = await create(ADA, { name: 'Before the switch' });
    setFeatures({ userProjects: false });
    const res = await drive(route.create, { user: ADA, body: { name: 'x' } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.details.code, 'USER_PROJECTS_DISABLED');
    const feature = await drive(route.config, { user: ADA });
    assert.equal(feature.body.userProjects.enabled, false);
    // An existing project is dark too, reads and writes alike, except for a
    // full admin; admin projects stay reachable through their links.
    const params = { projectId: existing.id };
    for (const handlers of [route.get, route.update, route.remove, route.addItem]) {
      const dark = await drive(handlers, { user: ADA, params, body: { name: 'y' } });
      assert.equal(dark.statusCode, 403, JSON.stringify(dark.body));
      assert.equal(dark.body.details.code, 'USER_PROJECTS_DISABLED');
    }
    assert.equal((await drive(route.get, { user: ROOT, params })).statusCode, 200);
    setFeatures({ projects: false });
    const gated = await drive(route.list, { user: ADA });
    assert.equal(gated.statusCode, 403);
    assert.equal(gated.body.code, 'FEATURE_DISABLED');
  });
});

describe('user projects', () => {
  it('is private to its owner until shared', async () => {
    const project = await create(ADA, { instructions: 'Answer in German' });
    assert.equal(project.role, 'owner');
    assert.equal(project.permissions.canDelete, true);
    assert.equal(project.instructions, 'Answer in German');
    assert.deepEqual(project.members, []);
    assert.ok((await drive(route.list, { user: ADA })).body.items.some(p => p.id === project.id));
    assert.equal(
      (await drive(route.list, { user: GRACE })).body.items.some(p => p.id === project.id),
      false
    );
    const direct = await drive(route.get, { user: GRACE, params: { projectId: project.id } });
    assert.equal(direct.statusCode, 404, 'an unshared project does not confirm it exists');
  });

  it('keeps a default app per project: set on create, changed, cleared, validated', async () => {
    const project = await create(ADA, { defaultAppId: 'chat' });
    assert.equal(project.defaultAppId, 'chat');
    const params = { projectId: project.id };

    const changed = await drive(route.update, {
      user: ADA,
      params,
      body: { defaultAppId: 'summarizer' }
    });
    assert.equal(changed.statusCode, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.defaultAppId, 'summarizer');
    const reread = await drive(route.get, { user: ADA, params });
    assert.equal(reread.body.defaultAppId, 'summarizer');

    const cleared = await drive(route.update, { user: ADA, params, body: { defaultAppId: null } });
    assert.equal(cleared.statusCode, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.defaultAppId, null);

    for (const bad of ['', '../etc', 42]) {
      const refused = await drive(route.update, { user: ADA, params, body: { defaultAppId: bad } });
      assert.equal(refused.statusCode, 400, `refuses ${JSON.stringify(bad)}`);
    }
    assert.equal((await create(ADA)).defaultAppId, null, 'a project starts without one');
  });

  it('gives an editor and a user their roles, and revokes at once', async () => {
    const project = await create(ADA);
    const shared = await setMembers(ADA, project.id, [
      { type: 'user', id: GRACE.id, role: 'editor' },
      { type: 'group', id: 'engineers', role: 'user' }
    ]);
    assert.equal(shared.statusCode, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.members.find(m => m.id === GRACE.id).name, 'Grace Hopper');

    const asEditor = await drive(route.get, { user: GRACE, params: { projectId: project.id } });
    assert.equal(asEditor.statusCode, 200);
    assert.equal(asEditor.body.role, 'editor');
    assert.ok(asEditor.body.members, 'editors see the member list');
    const edit = await drive(route.update, {
      user: GRACE,
      params: { projectId: project.id },
      body: { instructions: 'Be brief' }
    });
    assert.equal(edit.statusCode, 200);
    assert.equal(edit.body.instructions, 'Be brief');

    const asUser = await drive(route.get, { user: CAROL, params: { projectId: project.id } });
    assert.equal(asUser.statusCode, 200);
    assert.equal(asUser.body.role, 'user');
    assert.equal(asUser.body.members, undefined, 'users do not see the member list');
    assert.equal(asUser.body.memberCount, 2);
    const forbidden = await drive(route.update, {
      user: CAROL,
      params: { projectId: project.id },
      body: { name: 'Mine now' }
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.body.details.code, 'PERMISSION_DENIED');
    assert.equal(
      (await drive(route.remove, { user: GRACE, params: { projectId: project.id } })).statusCode,
      403,
      'editors never delete'
    );
    assert.ok(
      (await drive(route.list, { user: CAROL, query: { scope: 'shared' } })).body.items.some(
        p => p.id === project.id
      )
    );

    assert.equal((await setMembers(ADA, project.id, [])).statusCode, 200);
    assert.equal(
      (await drive(route.get, { user: GRACE, params: { projectId: project.id } })).statusCode,
      404
    );
    assert.equal(
      (await drive(route.list, { user: GRACE })).body.items.some(p => p.id === project.id),
      false
    );
  });

  it('enforces the sharing audiences and the sharing permission', async () => {
    const project = await create(ADA);
    const everyone = await setMembers(ADA, project.id, [{ type: 'everyone', role: 'user' }]);
    assert.equal(everyone.statusCode, 403, 'everyone is off by default');
    setProjectSettings({ sharing: { allowEveryone: true } });
    assert.equal(
      (await setMembers(ADA, project.id, [{ type: 'everyone', role: 'user' }])).statusCode,
      200
    );
    assert.equal(
      (await drive(route.get, { user: NOBODY, params: { projectId: project.id } })).statusCode,
      200
    );
    const unknown = await setMembers(ADA, project.id, [
      { type: 'user', id: 'user-ghost', role: 'user' }
    ]);
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.body.details.code, 'SHARE_TARGET_INVALID');
    const anonymousGroup = await setMembers(ADA, project.id, [
      { type: 'group', id: 'anonymous', role: 'user' }
    ]);
    assert.equal(anonymousGroup.statusCode, 400);
  });

  it('transfers ownership to a known user', async () => {
    const project = await create(ADA);
    const res = await drive(route.transfer, {
      user: ADA,
      params: { projectId: project.id },
      body: { ownerId: GRACE.id }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.transferred, true);
    const mine = await drive(route.get, { user: GRACE, params: { projectId: project.id } });
    assert.equal(mine.body.role, 'owner');
    const ghost = await drive(route.transfer, {
      user: GRACE,
      params: { projectId: project.id },
      body: { ownerId: 'nope' }
    });
    assert.equal(ghost.statusCode, 400);
  });

  it('adds and removes link items within the quota', async () => {
    const project = await create(ADA);
    const added = await drive(route.addItem, {
      user: ADA,
      params: { projectId: project.id },
      body: { kind: 'url', ref: { url: 'https://example.com/policy' }, pinned: true }
    });
    assert.equal(added.statusCode, 201, JSON.stringify(added.body));
    assert.equal(added.body.item.status, 'ready');
    assert.equal(added.body.item.pinned, true);
    assert.equal(added.body.item.text, null);
    const items = await drive(route.items, { user: ADA, params: { projectId: project.id } });
    assert.equal(items.body.items.length, 1);
    const upload = await drive(route.addItem, {
      user: ADA,
      params: { projectId: project.id },
      body: { kind: 'upload', ref: {}, name: 'x.txt' }
    });
    assert.equal(upload.statusCode, 400, 'an upload without a file or text has nothing to ingest');
    assert.equal(upload.body.details.code, 'INVALID_REF');
    const removed = await drive(route.removeItem, {
      user: ADA,
      params: { projectId: project.id, itemId: added.body.item.id }
    });
    assert.equal(removed.statusCode, 204);
    assert.equal(
      (await drive(route.items, { user: ADA, params: { projectId: project.id } })).body.items
        .length,
      0
    );
  });

  it('lets only the owner delete, and a full admin for compliance', async () => {
    const project = await create(ADA);
    await setMembers(ADA, project.id, [{ type: 'user', id: GRACE.id, role: 'editor' }]);
    assert.equal(
      (await drive(route.remove, { user: GRACE, params: { projectId: project.id } })).statusCode,
      403
    );
    const asAdmin = await drive(route.get, { user: ROOT, params: { projectId: project.id } });
    assert.equal(asAdmin.statusCode, 200);
    assert.equal(asAdmin.body.role, 'admin');
    assert.equal(asAdmin.body.permissions.canEdit, false);
    assert.equal(
      (await drive(route.remove, { user: ADA, params: { projectId: project.id } })).statusCode,
      204
    );
    assert.equal(
      (await drive(route.get, { user: ADA, params: { projectId: project.id } })).statusCode,
      404
    );
  });

  it('answers the share-target lookup with what the caller may pick', async () => {
    const res = await drive(route.targets, { user: ADA, query: { q: 'gr' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.allowed, { user: true, group: true, everyone: false });
    assert.ok(res.body.users.some(user => user.id === GRACE.id));
    assert.ok(res.body.groups.every(group => group.id !== 'anonymous'));
  });
});

describe('documents linked from another project', () => {
  it('never follows a stored link to itself, and checks links in a new admin project', async () => {
    const project = await create(ADA, { name: 'Loop' });
    await getProjectRepository().mutate(project.id, current => ({
      ...current,
      items: [
        {
          id: 'itm_loop',
          kind: 'project-item',
          name: 'Loop',
          ref: { projectId: project.id, itemId: 'itm_loop' },
          storage: 'link',
          status: 'ready',
          pinned: false
        }
      ]
    }));
    await assert.rejects(
      projectSourceContent({
        ref: { id: 'itm_loop', scope: project.id },
        user: ADA,
        format: 'original'
      }),
      error => error.status === 404
    );

    const created = await drive(route.adminCreate, {
      user: EDITOR,
      body: {
        id: 'loop-admin',
        name: { en: 'Loop' },
        items: [{ kind: 'project-item', ref: { projectId: 'loop-admin', itemId: 'itm_1' } }]
      }
    });
    assert.equal(created.statusCode, 400, JSON.stringify(created.body));
    assert.equal(created.body.details.code, 'INVALID_REF');
  });

  async function addLink(user, projectId, ref) {
    return drive(route.addItem, {
      user,
      params: { projectId },
      body: { kind: 'project-item', ref }
    });
  }

  async function linkState(user, projectId) {
    const res = await drive(route.get, { user, params: { projectId } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.items.find(item => item.kind === 'project-item')?.link;
  }

  it('links the original without copying it, for callers who may use the source', async () => {
    const source = await create(ADA, { name: 'Delivery' });
    const original = await drive(route.addItem, {
      user: ADA,
      params: { projectId: source.id },
      body: { kind: 'url', ref: { url: 'https://example.com/install' }, name: 'Install guide' }
    });
    const target = await create(ADA, { name: 'iHub' });

    const linked = await addLink(ADA, target.id, {
      projectId: source.id,
      itemId: original.body.item.id
    });
    assert.equal(linked.statusCode, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.item.name, 'Install guide');
    assert.equal(linked.body.item.storage, 'link');
    assert.equal(linked.body.item.status, 'ready');
    assert.deepEqual(linked.body.item.provenance.source, {
      site: 'Delivery',
      url: `/projects/${source.id}`
    });
    assert.deepEqual(await linkState(ADA, target.id), {
      state: 'ok',
      projectName: 'Delivery',
      status: 'ready'
    });

    // A link to a link is stored as a link to the original.
    const third = await create(ADA, { name: 'Third' });
    const chained = await addLink(ADA, third.id, {
      projectId: target.id,
      itemId: linked.body.item.id
    });
    assert.equal(chained.statusCode, 201, JSON.stringify(chained.body));
    assert.deepEqual(chained.body.item.ref, {
      projectId: source.id,
      itemId: original.body.item.id
    });

    // Its own documents are already in the project.
    const own = await addLink(ADA, source.id, {
      projectId: source.id,
      itemId: original.body.item.id
    });
    assert.equal(own.statusCode, 400);
    assert.equal(own.body.details.code, 'INVALID_REF');
  });

  it('refuses a source the caller only sees for compliance or not at all', async () => {
    const source = await create(ADA, { name: 'Private notes' });
    const original = await drive(route.addItem, {
      user: ADA,
      params: { projectId: source.id },
      body: { kind: 'url', ref: { url: 'https://example.com/notes' } }
    });
    const ref = { projectId: source.id, itemId: original.body.item.id };
    for (const user of [GRACE, ROOT]) {
      const target = await create(user, { name: `${user.name}'s project` });
      const res = await addLink(user, target.id, ref);
      assert.equal(res.statusCode, 404, `${user.id}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.details.code, 'PROJECT_NOT_FOUND');
    }
    const target = await create(ADA, { name: 'Target' });
    const missing = await addLink(ADA, target.id, { projectId: source.id, itemId: 'itm_gone' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.details.code, 'ITEM_NOT_FOUND');
  });

  it('links only from the caller’s own projects and published ones', async () => {
    // A project shared with Grace is hers to use, not to link from.
    const shared = await create(ADA, { name: 'Shared notes' });
    const original = await drive(route.addItem, {
      user: ADA,
      params: { projectId: shared.id },
      body: { kind: 'url', ref: { url: 'https://example.com/shared' } }
    });
    await setMembers(ADA, shared.id, [{ type: 'user', id: GRACE.id, role: 'editor' }]);
    const target = await create(GRACE, { name: 'Grace space' });
    const fromShared = await addLink(GRACE, target.id, {
      projectId: shared.id,
      itemId: original.body.item.id
    });
    assert.equal(fromShared.statusCode, 403, JSON.stringify(fromShared.body));
    assert.equal(fromShared.body.details.code, 'PERMISSION_DENIED');

    // An admin project is linked once it is published, by everyone signed in.
    const repo = getProjectRepository();
    await repo.createAdmin({
      id: 'link-docs',
      name: { en: 'Docs' },
      items: [{ id: 'itm_doc', kind: 'url', name: 'Doc', status: 'ready', pinned: false }]
    });
    try {
      const ref = { projectId: 'link-docs', itemId: 'itm_doc' };
      const hidden = await addLink(GRACE, target.id, ref);
      assert.equal(hidden.statusCode, 404, JSON.stringify(hidden.body));
      const published = await drive(route.adminPatch, {
        user: EDITOR,
        params: { id: 'link-docs' },
        body: { published: true }
      });
      assert.equal(published.statusCode, 200, JSON.stringify(published.body));
      assert.equal(published.body.project.published, true);
      const linked = await addLink(GRACE, target.id, ref);
      assert.equal(linked.statusCode, 201, JSON.stringify(linked.body));
      const listed = await drive(route.list, { user: GRACE, query: { scope: 'all' } });
      assert.ok(listed.body.items.some(project => project.id === 'link-docs'));

      // A published project that is switched off reaches nobody.
      await drive(route.adminPatch, {
        user: EDITOR,
        params: { id: 'link-docs' },
        body: { enabled: false }
      });
      const another = await create(GRACE, { name: 'Grace later' });
      const disabled = await addLink(GRACE, another.id, ref);
      assert.equal(disabled.statusCode, 404, JSON.stringify(disabled.body));
    } finally {
      await repo.delete('link-docs');
    }
  });

  it("reads the source with the reader's own access, and says when it is gone", async () => {
    const source = await create(ADA, { name: 'Handbook' });
    const original = await drive(route.addItem, {
      user: ADA,
      params: { projectId: source.id },
      body: { kind: 'url', ref: { url: 'https://example.com/handbook' } }
    });
    const target = await create(ADA, { name: 'Team space' });
    await addLink(ADA, target.id, { projectId: source.id, itemId: original.body.item.id });
    await setMembers(ADA, target.id, [{ type: 'user', id: GRACE.id, role: 'user' }]);

    // A member of the linking project is not a member of the source.
    assert.deepEqual(await linkState(GRACE, target.id), { state: 'forbidden' });
    await setMembers(ADA, source.id, [{ type: 'user', id: GRACE.id, role: 'user' }]);
    assert.equal((await linkState(GRACE, target.id)).state, 'ok');

    await drive(route.removeItem, {
      user: ADA,
      params: { projectId: source.id, itemId: original.body.item.id }
    });
    assert.deepEqual(await linkState(ADA, target.id), { state: 'gone' });
  });
});

describe('the project catalog', () => {
  async function publish(user, projectId, published = true) {
    return drive(route.publish, { user, params: { projectId }, body: { published } });
  }

  async function listIds(user) {
    const res = await drive(route.list, { user, query: { scope: 'all' } });
    return res.body.items.map(project => project.id);
  }

  it('publishes only while the catalog is on, and only for those who may share', async () => {
    const project = await create(ADA, { name: 'Off by default' });
    const off = await publish(ADA, project.id);
    assert.equal(off.statusCode, 403, JSON.stringify(off.body));
    assert.deepEqual((await drive(route.catalog, { user: GRACE })).body, {
      enabled: false,
      items: []
    });

    setProjectSettings({ sharing: { allowCatalog: true } });
    await setMembers(ADA, project.id, [{ type: 'user', id: GRACE.id, role: 'user' }]);
    assert.equal((await publish(GRACE, project.id)).statusCode, 403, 'a user member may not');
    const on = await publish(ADA, project.id);
    assert.equal(on.statusCode, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body.audience, { everyone: false, catalog: true });
    assert.ok(on.body.catalog.publishedAt);
  });

  it('lets others link documents of a published project while the catalog is on', async () => {
    setProjectSettings({ sharing: { allowCatalog: true } });
    const source = await create(ADA, { name: 'Published docs' });
    const original = await drive(route.addItem, {
      user: ADA,
      params: { projectId: source.id },
      body: { kind: 'url', ref: { url: 'https://example.com/published' } }
    });
    await publish(ADA, source.id);
    const link = (user, projectId) =>
      drive(route.addItem, {
        user,
        params: { projectId },
        body: { kind: 'project-item', ref: { projectId: source.id, itemId: original.body.item.id } }
      });

    const target = await create(GRACE, { name: 'From the catalog' });
    const linked = await link(GRACE, target.id);
    assert.equal(linked.statusCode, 201, JSON.stringify(linked.body));

    // With the catalog off the project reaches nobody but its members.
    setProjectSettings({ sharing: { allowCatalog: false } });
    const later = await create(GRACE, { name: 'After the catalog' });
    const refused = await link(GRACE, later.id);
    assert.equal(refused.statusCode, 404, JSON.stringify(refused.body));
  });

  it("lets everyone signed in browse and add a published project, without the members' chats", async () => {
    setProjectSettings({ sharing: { allowCatalog: true } });
    const project = await create(ADA, {
      name: 'iHub knowledge',
      description: 'Curated delivery docs'
    });
    await publish(ADA, project.id);

    const found = await drive(route.catalog, { user: CAROL, query: { q: 'delivery' } });
    assert.equal(found.statusCode, 200);
    const entry = found.body.items.find(item => item.id === project.id);
    assert.ok(entry, 'listed by its description');
    assert.equal(entry.subscribed, false);
    assert.equal(entry.role, 'catalog');
    assert.equal(
      (await drive(route.catalog, { user: CAROL, query: { q: 'nothing-like-it' } })).body.items
        .length,
      0
    );

    // Readable before it is added, but not in the list yet.
    const opened = await drive(route.get, { user: CAROL, params: { projectId: project.id } });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.body.role, 'catalog');
    assert.equal(opened.body.subscribed, false);
    assert.equal(opened.body.permissions.canEdit, false);
    assert.equal(opened.body.permissions.readsAllChats, false);
    assert.equal((await listIds(CAROL)).includes(project.id), false);

    const added = await drive(route.subscribe, { user: CAROL, params: { projectId: project.id } });
    assert.equal(added.statusCode, 200, JSON.stringify(added.body));
    assert.equal((await listIds(CAROL)).includes(project.id), true);
    assert.equal(
      (await drive(route.catalog, { user: CAROL })).body.items.find(item => item.id === project.id)
        .subscribed,
      true
    );

    // A member reads the members' chats; someone from the catalog does not.
    const chats = getChatRepository();
    const chat = await chats.ensureChat({
      chatId: 'chat-catalog-1',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Owner notes'
    });
    await joinProject(chat, project.id);
    assert.equal((await authorizeChat(chat.id, CAROL, { repository: chats })).ok, false);
    const listed = await drive(route.chats, {
      user: CAROL,
      params: { projectId: project.id },
      query: { filter: 'all' }
    });
    assert.equal(listed.statusCode, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.items.length, 0);

    const removed = await drive(route.unsubscribe, {
      user: CAROL,
      params: { projectId: project.id }
    });
    assert.equal(removed.statusCode, 204);
    assert.equal((await listIds(CAROL)).includes(project.id), false);
  });

  it('keeps the chats of someone from the catalog out of the project, so members never read them', async () => {
    setProjectSettings({ sharing: { allowCatalog: true } });
    const project = await create(ADA, { name: 'Salary bands' });
    await publish(ADA, project.id);

    const req = { user: { ...CAROL }, headers: {} };
    const inside = await resolveChatProjects({
      req,
      chat: null,
      app: { id: 'chat' },
      projectId: project.id,
      projects: undefined
    });
    assert.equal(inside.ok, false, 'no chat starts inside it');
    const attached = await resolveChatProjects({
      req: { user: { ...CAROL }, headers: {} },
      chat: null,
      app: { id: 'chat' },
      projectId: undefined,
      projects: [project.id]
    });
    assert.equal(attached.ok, true, JSON.stringify(attached));
    assert.deepEqual(attached.attachedIds, [project.id], 'attached to a chat of her own');

    const opened = await drive(route.get, { user: CAROL, params: { projectId: project.id } });
    assert.equal(opened.body.permissions.canHoldChats, false);
  });

  it('lets a full admin keep the compliance view and take any project out', async () => {
    setProjectSettings({ sharing: { allowCatalog: true } });
    const project = await create(ADA, { name: 'Left behind' });
    await publish(ADA, project.id);
    const asAdmin = await drive(route.get, { user: ROOT, params: { projectId: project.id } });
    assert.equal(asAdmin.body.role, 'admin');
    assert.equal(asAdmin.body.permissions.readsAllChats, true);

    const republish = await publish(ROOT, project.id, true);
    assert.equal(republish.statusCode, 403);
    assert.equal(republish.body.details.code, 'PERMISSION_DENIED');
    const out = await publish(ROOT, project.id, false);
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(out.body.audience.catalog, false);
  });

  it('takes the projectSharing permission to publish, not to take a project out', async () => {
    setProjectSettings({ sharing: { allowCatalog: true } });
    const project = await create(SOLO, { name: 'Mine alone' });
    const refused = await publish(SOLO, project.id);
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.body.details.code, 'PERMISSION_DENIED');
    await getProjectRepository().setPublished(project.id, true, { actor: ADA });
    assert.equal((await publish(SOLO, project.id, false)).statusCode, 200);
  });

  it('disappears for those who added it once it is taken out or the catalog is off', async () => {
    setProjectSettings({ sharing: { allowCatalog: true } });
    const project = await create(ADA, { name: 'Short-lived' });
    await publish(ADA, project.id);
    await drive(route.subscribe, { user: CAROL, params: { projectId: project.id } });
    assert.equal((await listIds(CAROL)).includes(project.id), true);

    setProjectSettings({ sharing: { allowCatalog: false } });
    assert.equal((await listIds(CAROL)).includes(project.id), false);
    assert.equal(
      (await drive(route.get, { user: CAROL, params: { projectId: project.id } })).statusCode,
      404
    );

    setProjectSettings({ sharing: { allowCatalog: true } });
    assert.equal((await publish(ADA, project.id, false)).statusCode, 200);
    assert.equal((await listIds(CAROL)).includes(project.id), false);
    assert.equal(
      (await drive(route.catalog, { user: CAROL })).body.items.some(item => item.id === project.id),
      false
    );
    // Taking it off the list still works without access.
    assert.equal(
      (await drive(route.unsubscribe, { user: CAROL, params: { projectId: project.id } }))
        .statusCode,
      204
    );
  });

  it('lists the admin projects available to everyone signed in', async () => {
    setProjectSettings({ sharing: { allowCatalog: true } });
    const repo = getProjectRepository();
    await repo.createAdmin({
      id: 'catalog-faq',
      name: { en: 'Company FAQ', de: 'Firmen-FAQ' },
      description: { en: 'Answers to common questions' },
      items: []
    });
    const find = async (q = '') =>
      (await drive(route.catalog, { user: CAROL, query: q ? { q } : {} })).body.items.find(
        item => item.id === 'catalog-faq'
      );
    const patch = body =>
      drive(route.adminPatch, { user: EDITOR, params: { id: 'catalog-faq' }, body });
    try {
      assert.equal(await find(), undefined, 'linked apps only: not in the catalog');

      assert.equal((await patch({ published: true })).statusCode, 200);
      const entry = await find('firmen');
      assert.ok(entry, 'found by its name in any language');
      assert.equal(entry.ownership, 'admin');
      assert.equal(entry.role, 'catalog');
      assert.ok(await find('common questions'), 'found by its description');
      assert.equal((await listIds(CAROL)).includes('catalog-faq'), true);

      // Added to one's list, it says so in the list, the catalog and on its page.
      const listed = async () =>
        (await drive(route.list, { user: CAROL, query: { scope: 'all' } })).body.items.find(
          item => item.id === 'catalog-faq'
        );
      assert.equal(entry.subscribed, false);
      assert.equal((await listed()).subscribed, false);
      const added = await drive(route.subscribe, {
        user: CAROL,
        params: { projectId: 'catalog-faq' }
      });
      assert.equal(added.statusCode, 200, JSON.stringify(added.body));
      assert.equal(added.body.subscribed, true);
      assert.equal((await listed()).subscribed, true);
      assert.equal((await find()).subscribed, true);
      const opened = await drive(route.get, { user: CAROL, params: { projectId: 'catalog-faq' } });
      assert.equal(opened.body.subscribed, true);
      // Removed again, it stays open to everyone but leaves the list.
      const removed = await drive(route.unsubscribe, {
        user: CAROL,
        params: { projectId: 'catalog-faq' }
      });
      assert.equal(removed.statusCode, 204);
      assert.equal((await listed()).subscribed, false);

      assert.equal((await patch({ enabled: false })).statusCode, 200);
      assert.equal(await find(), undefined, 'off: not in the catalog');
    } finally {
      await repo.delete('catalog-faq');
    }
  });
});

describe('admin projects', () => {
  it('are created by content admins and reached by users through a linked app', async () => {
    const created = await drive(route.adminCreate, {
      user: EDITOR,
      body: { id: 'faq', name: { en: 'FAQ', de: 'FAQ' }, instructions: 'Cite the FAQ' }
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.project.ownership, 'admin');
    const again = await drive(route.adminCreate, {
      user: EDITOR,
      body: { id: 'faq', name: { en: 'FAQ' } }
    });
    assert.equal(again.statusCode, 409);
    assert.equal(
      (await drive(route.adminCreate, { user: ADA, body: { id: 'x', name: { en: 'x' } } }))
        .statusCode,
      403
    );

    // NOBODY may use the `support` app, which links `faq`; ADA may not.
    const linked = await drive(route.get, { user: NOBODY, params: { projectId: 'faq' } });
    assert.equal(linked.statusCode, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.role, 'linked');
    assert.equal(linked.body.permissions.canEdit, false);
    // It comes with the app, not from the catalog: there is nothing to add.
    assert.equal(linked.body.subscribed, undefined);
    assert.equal(
      (await drive(route.subscribe, { user: NOBODY, params: { projectId: 'faq' } })).statusCode,
      400
    );
    assert.equal(
      (await drive(route.get, { user: ADA, params: { projectId: 'faq' } })).statusCode,
      404
    );
    assert.ok((await drive(route.list, { user: NOBODY })).body.items.some(p => p.id === 'faq'));
    const asEditor = await drive(route.get, { user: EDITOR, params: { projectId: 'faq' } });
    assert.equal(asEditor.body.role, 'admin');
    assert.equal(asEditor.body.permissions.canEdit, true);

    const item = await drive(route.adminAddItem, {
      user: EDITOR,
      params: { id: 'faq' },
      body: { kind: 'page', ref: { pageId: 'faq' } }
    });
    assert.equal(item.statusCode, 201, JSON.stringify(item.body));
    assert.equal(item.body.item.provenance.origin, 'linked');
    assert.equal(
      (await drive(route.items, { user: NOBODY, params: { projectId: 'faq' } })).body.items.length,
      1
    );
  });

  it('refuses import pointers and managed files from API callers', async () => {
    // The startup importer reads such a file into the project and deletes
    // it: a content admin must not be able to aim it at config/platform.json.
    const item = extra => ({
      id: 'itm_x',
      kind: 'upload',
      name: 'platform.json',
      storage: 'text',
      status: 'pending',
      provenance: { origin: 'uploaded' },
      ...extra
    });
    for (const [field, extra] of [
      ['import', { import: { file: 'config/platform.json' } }],
      ['managedFile', { managedFile: 'config/platform.json' }]
    ]) {
      const refused = await drive(route.adminCreate, {
        user: EDITOR,
        body: { id: 'smuggled', name: { en: 'Smuggled' }, items: [item(extra)] }
      });
      assert.equal(refused.statusCode, 400, JSON.stringify(refused.body));
      // The strict creation schema names the field it refuses.
      assert.match(JSON.stringify(refused.body), new RegExp(field));
    }
    assert.equal(await getProjectRepository().get('smuggled'), null);
  });

  it('is reached through a workflow by the same rule that lets the user run it', async () => {
    // `allowedGroups` is not part of the execution policy (`permissions.workflows`
    // is), so it must not hide the linked project from a user who may run it.
    configCache.setCacheEntry('config/workflows.json', [
      { id: 'wf-link', enabled: true, allowedGroups: ['other'], projects: ['faq'], nodes: [] }
    ]);
    try {
      const linked = await drive(route.get, { user: RUNNER, params: { projectId: 'faq' } });
      assert.equal(linked.statusCode, 200, JSON.stringify(linked.body));
      assert.equal(linked.body.role, 'linked');
      assert.equal(
        (await drive(route.get, { user: GRACE, params: { projectId: 'faq' } })).statusCode,
        404,
        'without the workflow permission the project stays hidden'
      );
    } finally {
      configCache.setCacheEntry('config/workflows.json', []);
    }
  });

  it('builds the items of a new admin project itself and refuses server-owned fields', async () => {
    const forged = await drive(route.adminCreate, {
      user: EDITOR,
      body: {
        id: 'forged',
        name: { en: 'Forged' },
        items: [
          {
            kind: 'url',
            ref: { url: 'https://example.com/a' },
            storage: 'text',
            status: 'ready',
            text: { blobKey: 'elsewhere__itm__v1', format: 'text/plain', extractedAt: 'now' }
          }
        ]
      }
    });
    assert.equal(forged.statusCode, 400, JSON.stringify(forged.body));
    assert.equal(
      (await drive(route.adminGet, { user: EDITOR, params: { id: 'forged' } })).statusCode,
      404
    );
    const badId = await drive(route.adminCreate, {
      user: EDITOR,
      body: {
        id: 'forged',
        name: { en: 'Forged' },
        items: [{ id: 'doc..v1', kind: 'url', ref: { url: 'https://example.com/a' } }]
      }
    });
    assert.equal(badId.statusCode, 400, 'an item id the item routes would refuse');
    const sepId = await drive(route.adminCreate, {
      user: EDITOR,
      body: { id: 'case__archive', name: { en: 'Archive' } }
    });
    assert.equal(sepId.statusCode, 400, 'a project id carrying the blob separator');
    for (const id of ['share-targets', '_Config', '_stats', '_kinds']) {
      const reserved = await drive(route.adminCreate, {
        user: EDITOR,
        body: { id, name: { en: 'Shadow' } }
      });
      assert.equal(reserved.statusCode, 400, `"${id}" names a static endpoint`);
    }

    const built = await drive(route.adminCreate, {
      user: EDITOR,
      body: {
        id: 'built',
        name: { en: 'Built' },
        items: [
          { id: 'policy', kind: 'url', ref: { url: 'https://example.com/policy' }, pinned: true }
        ]
      }
    });
    assert.equal(built.statusCode, 201, JSON.stringify(built.body));
    const [item] = built.body.project.items;
    assert.equal(item.id, 'policy');
    assert.equal(item.storage, 'link');
    assert.equal(item.status, 'ready');
    assert.equal(item.pinned, true);
    assert.equal(item.provenance.origin, 'linked');
    assert.equal(item.provenance.by.id, EDITOR.id);
    assert.deepEqual(item.cache, { ttlSeconds: 7200 });
    assert.equal(item.text, null);
    assert.equal(
      (await drive(route.adminDelete, { user: EDITOR, params: { id: 'built' } })).statusCode,
      204
    );
  });

  it("is reached through a planner's task template and blocks its deletion", async () => {
    // The planner's generated workers carry `taskTemplate.projects`; a
    // non-admin who may run the workflow (RUNNER: `wf-link`) must reach
    // them, and the admin
    // page must list the dependency.
    configCache.setCacheEntry('config/workflows.json', [
      {
        id: 'wf-link',
        name: { en: 'Planner' },
        enabled: true,
        nodes: [
          {
            id: 'plan',
            type: 'planner',
            config: { taskTemplate: { projects: [{ id: 'faq', mode: 'tools' }] } }
          }
        ]
      }
    ]);
    try {
      const linked = await drive(route.get, { user: RUNNER, params: { projectId: 'faq' } });
      assert.equal(linked.statusCode, 200, JSON.stringify(linked.body));
      assert.equal(linked.body.role, 'linked');
      const deps = await drive(route.adminDeps, { user: EDITOR, params: { id: 'faq' } });
      assert.ok(
        deps.body.dependencies.some(
          dep => dep.type === 'workflow' && dep.id === 'wf-link' && dep.nodeId === 'plan'
        ),
        JSON.stringify(deps.body)
      );
    } finally {
      configCache.setCacheEntry('config/workflows.json', []);
    }
  });

  it('is listed for a delegated token that reaches it through an app', async () => {
    const delegated = { ...CAROL, authMode: 'oauth_authorization_code' };
    const direct = await drive(route.get, { user: delegated, params: { projectId: 'faq' } });
    assert.equal(direct.statusCode, 200, JSON.stringify(direct.body));
    const admin = await drive(route.list, { user: delegated, query: { scope: 'admin' } });
    assert.equal(admin.statusCode, 200, JSON.stringify(admin.body));
    assert.ok(
      admin.body.items.some(p => p.id === 'faq'),
      JSON.stringify(admin.body)
    );
    const all = await drive(route.list, { user: delegated });
    assert.ok(all.body.items.some(p => p.id === 'faq'));
    // A principal that holds no projects has nothing owned or shared.
    for (const scope of ['mine', 'shared']) {
      const own = await drive(route.list, { user: delegated, query: { scope } });
      assert.deepEqual(own.body, { items: [], nextCursor: null });
    }
  });

  it('cannot be deleted while linked, and disabling hides it from users', async () => {
    const deps = await drive(route.adminDeps, { user: EDITOR, params: { id: 'faq' } });
    assert.deepEqual(deps.body.dependencies, [{ type: 'app', id: 'support', name: 'Support' }]);
    const blocked = await drive(route.adminDelete, { user: EDITOR, params: { id: 'faq' } });
    assert.equal(blocked.statusCode, 400);
    assert.equal(blocked.body.details.code, 'PROJECT_IN_USE');

    const toggled = await drive(route.adminToggle, {
      user: EDITOR,
      body: { ids: ['faq'], enabled: false }
    });
    assert.equal(toggled.statusCode, 200);
    assert.equal(toggled.body.changed, 1);
    const hidden = await drive(route.get, { user: NOBODY, params: { projectId: 'faq' } });
    assert.equal(
      hidden.statusCode,
      403,
      'a disabled project is visible but unusable through the link'
    );
    assert.equal(
      (await drive(route.adminToggle, { user: EDITOR, body: { ids: ['faq'], enabled: true } }))
        .statusCode,
      200
    );

    const patched = await drive(route.adminPatch, {
      user: EDITOR,
      params: { id: 'faq' },
      body: { tags: ['help'] }
    });
    assert.equal(patched.statusCode, 200);
    assert.deepEqual(patched.body.project.tags, ['help']);
    // Admin names are localized records, on update as on create — through
    // the user route as well, where a content admin may edit it.
    const plain = await drive(route.adminPatch, {
      user: EDITOR,
      params: { id: 'faq' },
      body: { name: 'FAQ' }
    });
    assert.equal(plain.statusCode, 400);
    const plainViaUser = await drive(route.update, {
      user: EDITOR,
      params: { projectId: 'faq' },
      body: { name: 'FAQ' }
    });
    assert.equal(plainViaUser.statusCode, 400);
    const localizedViaUser = await drive(route.update, {
      user: EDITOR,
      params: { projectId: 'faq' },
      body: { name: { en: 'FAQ' } }
    });
    assert.equal(localizedViaUser.statusCode, 200, JSON.stringify(localizedViaUser.body));
    // The linked project cannot be deleted through the user route either.
    const viaUser = await drive(route.remove, { user: EDITOR, params: { projectId: 'faq' } });
    assert.equal(viaUser.statusCode, 400, JSON.stringify(viaUser.body));
    assert.equal(viaUser.body.details.code, 'PROJECT_IN_USE');
    // PUT is a metadata request: a document carrying items is refused, not
    // silently stored without them.
    const withItems = await drive(route.adminPut, {
      user: EDITOR,
      params: { id: 'faq' },
      body: { id: 'faq', name: { en: 'FAQ' }, items: [] }
    });
    assert.equal(withItems.statusCode, 400);
    assert.equal(withItems.body.details.code, 'ITEMS_NOT_EDITABLE');
    const put = await drive(route.adminPut, {
      user: EDITOR,
      params: { id: 'faq' },
      body: { id: 'faq', name: { en: 'FAQ' }, tags: ['help'] }
    });
    assert.equal(put.statusCode, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.project.tags, ['help']);

    const unlinked = await drive(route.adminCreate, {
      user: EDITOR,
      body: { id: 'scratch', name: { en: 'Scratch' } }
    });
    assert.equal(unlinked.statusCode, 201);
    assert.equal(
      (await drive(route.adminDelete, { user: EDITOR, params: { id: 'scratch' } })).statusCode,
      204
    );
    assert.equal(
      (await drive(route.adminGet, { user: EDITOR, params: { id: 'scratch' } })).statusCode,
      404
    );
  });

  it('creates only the iHub tier and keeps no snapshot of a deleted user project', async () => {
    const ifinder = await drive(route.adminCreate, {
      user: EDITOR,
      body: { id: 'ifinder-tier', name: { en: 'Later' }, tier: 'ifinder' }
    });
    assert.equal(ifinder.statusCode, 400);
    assert.match(ifinder.body.error, /tier/);
    const project = await create(ADA, { name: 'Private matter' });
    const gone = await drive(route.adminDelete, { user: ROOT, params: { id: project.id } });
    assert.equal(gone.statusCode, 204);
    assert.deepEqual(await listSnapshots('project', project.id), []);
  });

  it('lists user projects for full admins only', async () => {
    await create(ADA, { name: 'Compliance' });
    const asRoot = await drive(route.adminList, { user: ROOT, query: { ownership: 'user' } });
    assert.equal(asRoot.statusCode, 200);
    assert.ok(asRoot.body.items.some(p => p.name === 'Compliance' && p.owner.id === ADA.id));
    const asEditor = await drive(route.adminList, { user: EDITOR, query: { ownership: 'user' } });
    assert.equal(asEditor.statusCode, 403);
    const admin = await drive(route.adminList, { user: EDITOR });
    assert.ok(Array.isArray(admin.body) && admin.body.some(p => p.id === 'faq'));
  });
});

describe('token estimate routes', () => {
  it('estimates a project the caller may use, and refuses everyone else', async () => {
    const project = await create(ADA, { name: 'Estimated' });
    await drive(route.addItem, {
      user: ADA,
      params: { projectId: project.id },
      body: {
        kind: 'upload',
        ref: {},
        name: 'note.md',
        text: '# Note\n\nTen words about the rent being due.'
      }
    });

    const own = await drive(route.estimate, { user: ADA, params: { projectId: project.id } });
    assert.equal(own.statusCode, 200, JSON.stringify(own.body));
    assert.equal(own.body.projectId, project.id);
    assert.ok(Array.isArray(own.body.items));
    assert.ok(['prompt', 'search', 'unknown'].includes(own.body.recommendation));
    assert.ok(own.body.budgetTokens > 0);

    // A stranger gets what a missing project gets; nobody anonymous gets in.
    assert.equal(
      (await drive(route.estimate, { user: GRACE, params: { projectId: project.id } })).statusCode,
      404
    );
    assert.equal(
      (await drive(route.estimate, { params: { projectId: project.id } })).statusCode,
      401
    );
    assert.equal(
      (await drive(route.estimate, { user: ADA, params: { projectId: 'prj_doesnotexist' } }))
        .statusCode,
      404
    );
  });

  it('estimates an admin project for content admins only', async () => {
    const created = await drive(route.adminCreate, {
      user: EDITOR,
      body: { id: 'estimate-me', name: { en: 'Estimate me' } }
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));

    const ok = await drive(route.adminEstimate, { user: EDITOR, params: { id: 'estimate-me' } });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.projectId, 'estimate-me');
    assert.equal(ok.body.items.length, 0);
    assert.equal(
      (await drive(route.adminEstimate, { user: ADA, params: { id: 'estimate-me' } })).statusCode,
      403
    );
    assert.equal(
      (await drive(route.adminEstimate, { user: EDITOR, params: { id: 'no-such-project' } }))
        .statusCode,
      404
    );
  });

  it('refuses the id "new" for an admin project: it is the route of the create form', async () => {
    for (const id of ['new', 'NEW']) {
      const refused = await drive(route.adminCreate, {
        user: EDITOR,
        body: { id, name: { en: 'New' } }
      });
      assert.equal(refused.statusCode, 400, `${id}: ${JSON.stringify(refused.body)}`);
    }
  });
});

describe('chats in a project', () => {
  it('lists the chats of a project for its members, who read them', async () => {
    const chats = getChatRepository();
    assert.ok(chats.isAvailable());
    const chat = await chats.ensureChat({
      chatId: 'chat-move-1',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Hello'
    });
    assert.ok(chat);
    const project = await create(ADA, { name: 'Container' });
    await setMembers(ADA, project.id, [{ type: 'user', id: GRACE.id, role: 'user' }]);
    const stale = '2020-01-01T00:00:00.000Z';
    await getProjectRepository().mutate(project.id, current => current, { now: stale });

    await joinProject(chat, project.id);
    assert.equal((await getChatRepository().getChat(chat.id)).projectId, project.id);
    const markers = await getProjectRepository().listChatMarkers(project.id);
    assert.deepEqual(
      markers.map(m => m.chatId),
      [chat.id]
    );
    // A chat joining is activity: retention must not see the old stamp.
    assert.ok((await getProjectRepository().get(project.id)).lastActivityAt > stale);

    // A member reads the chat's transcript, marked as such so the owner's
    // side effects stay the owner's; a stranger gets nothing; the read is
    // gone with the feature.
    const asMember = await authorizeChat(chat.id, GRACE, { repository: chats });
    assert.equal(asMember.ok, true);
    assert.equal(asMember.viaProject, true);
    assert.equal(
      (await authorizeChat(chat.id, GRACE, { repository: chats, intent: 'write' })).ok,
      false
    );
    assert.equal((await authorizeChat(chat.id, CAROL, { repository: chats })).ok, false);
    setFeatures({ userProjects: false });
    assert.equal((await authorizeChat(chat.id, GRACE, { repository: chats })).ok, false);
    setFeatures();

    const listed = await drive(route.chats, { user: GRACE, params: { projectId: project.id } });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].owner.mine, false);
    const mine = await drive(route.chats, {
      user: GRACE,
      params: { projectId: project.id },
      query: { filter: 'mine' }
    });
    assert.equal(mine.body.items.length, 0);

    // The API no longer moves a chat, in or out.
    for (const projectId of [project.id, 'faq', null]) {
      const refused = await drive(route.chatPatch, {
        user: ADA,
        params: { chatId: chat.id },
        body: { projectId }
      });
      assert.equal(refused.statusCode, 400, JSON.stringify(refused.body));
    }
    assert.equal((await getChatRepository().getChat(chat.id)).projectId, project.id);
    assert.deepEqual(
      (await getProjectRepository().listChatMarkers(project.id)).map(m => m.chatId),
      [chat.id]
    );
  });

  it('lists the chats of a project a page at a time, newest first', async () => {
    const chats = getChatRepository();
    const project = await create(ADA, { name: 'Paged' });
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      const chat = await chats.ensureChat({
        chatId: `chat-page-${index}`,
        ownerId: ADA.id,
        appId: 'chat',
        title: `Chat ${index}`
      });
      await joinProject(chat, project.id);
      ids.push(chat.id);
    }
    const page = async query =>
      (await drive(route.chats, { user: ADA, params: { projectId: project.id }, query })).body;

    const first = await page({ limit: '2' });
    assert.equal(first.items.length, 2);
    assert.equal(first.total, 5);
    assert.equal(first.nextCursor, '2');

    const second = await page({ limit: '2', cursor: first.nextCursor });
    const last = await page({ limit: '2', cursor: second.nextCursor });
    assert.equal(second.items.length, 2);
    assert.equal(last.items.length, 1);
    assert.equal(last.nextCursor, null);
    const seen = [...first.items, ...second.items, ...last.items].map(item => item.id);
    assert.deepEqual([...seen].sort(), [...ids].sort(), 'every chat once, none twice');

    // The default page is bounded too, and a bad limit or cursor falls back.
    const bad = await page({ limit: 'many', cursor: '-4' });
    assert.equal(bad.items.length, 5);
    assert.equal(bad.total, 5);
    assert.equal((await page({ limit: '1000' })).items.length, 5);
  });

  it('attaches no project to a chat whose app takes none', async () => {
    const chats = getChatRepository();
    const chat = await chats.ensureChat({
      chatId: 'chat-attach-dark',
      ownerId: ADA.id,
      appId: 'dark',
      title: 'Dark app'
    });
    const mine = await create(ADA, { name: 'Mine (dark)' });
    const apps = configCache.getApps();
    configCache.setCacheEntry('config/apps.json', [
      ...(apps?.data || []),
      { id: 'dark', name: { en: 'Dark' }, enabled: true, features: { userProjects: false } }
    ]);
    try {
      const refused = await drive(route.chatPatch, {
        user: ADA,
        params: { chatId: chat.id },
        body: { attachedProjectIds: [mine.id] }
      });
      assert.equal(refused.statusCode, 403, JSON.stringify(refused.body));
      assert.equal(refused.body.details.code, 'APP_PROJECTS_DISABLED');
      assert.equal((await chats.getChat(chat.id)).attachedProjectIds, undefined);
    } finally {
      configCache.setCacheEntry('config/apps.json', apps?.data || []);
    }
  });

  it('attaches projects to a stored chat, takes them away and refuses ones it may not use', async () => {
    const chats = getChatRepository();
    const chat = await chats.ensureChat({
      chatId: 'chat-attach-1',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Attach'
    });
    assert.ok(chat);
    const mine = await create(ADA, { name: 'Mine' });
    const other = await create(ADA, { name: 'Other' });
    const strangers = await create(GRACE, { name: 'Strangers' });

    const attached = await drive(route.chatPatch, {
      user: ADA,
      params: { chatId: chat.id },
      body: { attachedProjectIds: [mine.id, other.id, mine.id] }
    });
    assert.equal(attached.statusCode, 200, JSON.stringify(attached.body));
    assert.deepEqual(attached.body.chat.attachedProjectIds, [mine.id, other.id]);
    assert.deepEqual((await chats.getChat(chat.id)).attachedProjectIds, [mine.id, other.id]);

    // The list replaces the attached ones: taking a project away is the same call.
    const removed = await drive(route.chatPatch, {
      user: ADA,
      params: { chatId: chat.id },
      body: { attachedProjectIds: [other.id] }
    });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.body.chat.attachedProjectIds, [other.id]);

    // A project the caller may not use is a 404 and nothing changes.
    const refused = await drive(route.chatPatch, {
      user: ADA,
      params: { chatId: chat.id },
      body: { attachedProjectIds: [other.id, strangers.id] }
    });
    assert.equal(refused.statusCode, 404);
    assert.deepEqual((await chats.getChat(chat.id)).attachedProjectIds, [other.id]);

    // Taking one away needs no access: a project the caller lost stays removable.
    const clearing = await drive(route.chatPatch, {
      user: ADA,
      params: { chatId: chat.id },
      body: { attachedProjectIds: [] }
    });
    assert.equal(clearing.statusCode, 200);
    assert.deepEqual(clearing.body.chat.attachedProjectIds, []);

    const bad = await drive(route.chatPatch, {
      user: ADA,
      params: { chatId: chat.id },
      body: { attachedProjectIds: 'prj_x' }
    });
    assert.equal(bad.statusCode, 400);

    // Not the caller's chat.
    const notMine = await drive(route.chatPatch, {
      user: GRACE,
      params: { chatId: chat.id },
      body: { attachedProjectIds: [strangers.id] }
    });
    assert.equal(notMine.statusCode, 404);

    // More than a chat may have attached is refused before anything is looked up.
    const tooMany = await drive(route.chatPatch, {
      user: ADA,
      params: { chatId: chat.id },
      body: { attachedProjectIds: Array.from({ length: 11 }, (_, i) => `prj_${i}`) }
    });
    assert.equal(tooMany.statusCode, 400);

    // While the feature is off a project cannot be added.
    setFeatures({ userProjects: false });
    const off = await drive(route.chatPatch, {
      user: ADA,
      params: { chatId: chat.id },
      body: { attachedProjectIds: [mine.id] }
    });
    setFeatures();
    assert.equal(off.statusCode, 403);
  });

  it("keeps a personal key its owner's project grants", () => {
    const personal = enhanceUserWithPermissions(
      { ...ADA, authMode: 'oauth_personal_key' },
      {},
      platform
    );
    assert.equal(personal.permissions.projects, true);
    assert.equal(personal.permissions.projectSharing, true);
    assert.equal(personal.permissions.adminAccess, false);
    assert.equal(personal.permissions.scheduledTasks, false);
    const delegated = enhanceUserWithPermissions({ ...THIRD_PARTY }, {}, platform);
    assert.equal(delegated.permissions.projects, false);
    assert.equal(delegated.permissions.projectSharing, false);
  });

  it('reports what the cleanup of a deleted user could not remove', async () => {
    const owner = { id: 'user-gone', name: 'Gone' };
    const kept = await getProjectService().createUserProject({ owner, content: { name: 'Stuck' } });
    const removed = await getProjectService().createUserProject({
      owner,
      content: { name: 'Removable' }
    });
    const repo = getProjectRepository();
    const original = repo.delete.bind(repo);
    repo.delete = async (projectId, options) => {
      if (projectId === kept.id) throw new Error('lock timeout');
      return original(projectId, options);
    };
    try {
      await assert.rejects(cleanUpProjectsOfUser(owner.id), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.match(error.errors[0].message, /lock timeout/);
        return true;
      });
    } finally {
      repo.delete = original;
    }
    assert.equal(await repo.get(removed.id), null, 'the other project is still removed');
    assert.ok(await repo.get(kept.id), 'the stuck project is reported, not forgotten');
  });

  it('keeps a chat that moved on while its old project is deleted', async () => {
    const chats = getChatRepository();
    const chat = await chats.ensureChat({
      chatId: 'chat-move-2',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Nomad'
    });
    const first = await create(ADA, { name: 'First' });
    const second = await create(ADA, { name: 'Second' });
    await joinProject(chat, first.id);
    // The association only changes while the chat is still where the caller
    // saw it: a stale expectation leaves it alone.
    const stale = await chats.moveProjectIf(chat.id, 'prj_elsewhere', null);
    assert.equal(stale.moved, false);
    assert.equal(stale.chat.projectId, first.id);
    const onward = await chats.moveProjectIf(chat.id, first.id, second.id, {
      settle: () => getProjectService().attachChat(second.id, chat.id, { ownerId: ADA.id })
    });
    assert.equal(onward.moved, true);
    // Deleting the first project detaches only chats that still point at it.
    const gone = await drive(route.remove, { user: ADA, params: { projectId: first.id } });
    assert.equal(gone.statusCode, 204);
    assert.equal((await chats.getChat(chat.id)).projectId, second.id);
    assert.deepEqual(
      (await getProjectRepository().listChatMarkers(second.id)).map(m => m.chatId),
      [chat.id]
    );
  });

  it('prunes a stale marker only once the chat is judged under its own lock', async () => {
    const chats = getChatRepository();
    const chat = await chats.ensureChat({
      chatId: 'chat-prune-1',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Back and forth'
    });
    const project = await create(ADA, { name: 'Home' });
    await joinProject(chat, project.id);
    // A listing that read the chat elsewhere asks again under the lock: the
    // chat is in the project now, so its marker stays.
    let ran = false;
    assert.equal(
      await chats.unlessInProject(chat.id, project.id, () => {
        ran = true;
      }),
      false
    );
    assert.equal(ran, false);
    assert.equal(
      await chats.unlessInProject(chat.id, 'prj_other', () => {
        ran = true;
      }),
      true
    );
    assert.equal(ran, true);
    const listed = await drive(route.chats, { user: ADA, params: { projectId: project.id } });
    assert.deepEqual(
      listed.body.items.map(entry => entry.id),
      [chat.id]
    );
  });

  it('removes the project marker of a deleted chat', async () => {
    const chats = getChatRepository();
    const chat = await chats.ensureChat({
      chatId: 'chat-erase-1',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Erased'
    });
    const project = await create(ADA, { name: 'Erasures' });
    await joinProject(chat, project.id);
    const erased = await drive(route.chatDelete, { user: ADA, params: { chatId: chat.id } });
    assert.equal(erased.statusCode, 200, JSON.stringify(erased.body));
    assert.deepEqual(await getProjectRepository().listChatMarkers(project.id), []);
  });

  it('reports the chats a project delete could not detach, and keeps their markers', async () => {
    const chats = getChatRepository();
    const chat = await chats.ensureChat({
      chatId: 'chat-stuck-1',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Stuck'
    });
    const project = await create(ADA, { name: 'Half gone' });
    await joinProject(chat, project.id);
    await assert.rejects(
      getProjectService().deleteProject(project.id, {
        detachChat: () => {
          throw new Error('chat storage is down');
        }
      }),
      error =>
        error.code === 'CASCADE_INCOMPLETE' &&
        error.status === 500 &&
        error.details.deleted === false &&
        error.details.chats.length === 1 &&
        // The chat id only: the storage error stays in the log.
        Object.keys(error.details.chats[0]).join() === 'chatId' &&
        error.details.chats[0].chatId === chat.id
    );
    // Nothing is gone: the project, the marker and the chat's association
    // are the record of what is still to do.
    assert.ok(await getProjectRepository().get(project.id));
    assert.deepEqual(
      (await getProjectRepository().listChatMarkers(project.id)).map(m => m.chatId),
      [chat.id]
    );
    assert.equal((await chats.getChat(chat.id)).projectId, project.id);
    // Meanwhile nothing can join or change the project: its delete has begun.
    const other = await chats.ensureChat({
      chatId: 'chat-stuck-2',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Late'
    });
    assert.equal(
      await getProjectService().attachChat(project.id, other.id, { ownerId: ADA.id }),
      false,
      'a project being deleted takes no new chat'
    );
    assert.deepEqual(
      (await getProjectRepository().listChatMarkers(project.id)).map(m => m.chatId),
      [chat.id]
    );
    const renamed = await drive(route.update, {
      user: ADA,
      params: { projectId: project.id },
      body: { name: 'Still here' }
    });
    assert.equal(renamed.statusCode, 404, JSON.stringify(renamed.body));
    // The retry with chat storage back finishes the job.
    const retried = await drive(route.remove, {
      user: ADA,
      params: { projectId: project.id }
    });
    assert.equal(retried.statusCode, 204, JSON.stringify(retried.body));
    assert.equal(await getProjectRepository().get(project.id), null);
    assert.deepEqual(await getProjectRepository().listChatMarkers(project.id), []);
    assert.equal((await chats.getChat(chat.id)).projectId ?? null, null);
  });

  it('leaves the chats of a project alone when the delete is refused under the lock', async () => {
    const chats = getChatRepository();
    const chat = await chats.ensureChat({
      chatId: 'chat-kept-1',
      ownerId: ADA.id,
      appId: 'chat',
      title: 'Kept'
    });
    const project = await create(ADA, { name: 'Handed over' });
    await joinProject(chat, project.id);
    let detached = 0;
    await assert.rejects(
      getProjectService().deleteProject(project.id, {
        // The owner changed between the route's check and the lock.
        authorize: () => false,
        detachChat: () => {
          detached += 1;
        }
      }),
      error => error.code === 'PROJECT_ACCESS_CHANGED'
    );
    assert.equal(detached, 0);
    const kept = await getProjectRepository().get(project.id);
    assert.ok(kept);
    assert.notEqual(kept.deleting, true);
    assert.deepEqual(
      (await getProjectRepository().listChatMarkers(project.id)).map(m => m.chatId),
      [chat.id]
    );
    assert.equal((await chats.getChat(chat.id)).projectId, project.id);
  });
});

describe('listing without user projects', () => {
  it('answers empty for the owned and shared scopes', async () => {
    setFeatures({ userProjects: false });
    try {
      for (const scope of ['mine', 'shared']) {
        const res = await drive(route.list, { user: NOBODY, query: { scope } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.items, [], scope);
      }
      const admin = await drive(route.list, { user: NOBODY, query: { scope: 'admin' } });
      assert.ok(
        admin.body.items.some(p => p.id === 'faq'),
        'linked admin projects still list'
      );
    } finally {
      setFeatures();
    }
  });
});

describe('moving, copying and merging admin projects', () => {
  async function adminProject(id, items = []) {
    const created = await drive(route.adminCreate, {
      user: EDITOR,
      body: { id, name: { en: id } }
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    for (const pageId of items) {
      const added = await drive(route.adminAddItem, {
        user: EDITOR,
        params: { id },
        body: { kind: 'page', ref: { pageId }, name: pageId }
      });
      assert.ok([201, 202].includes(added.statusCode), JSON.stringify(added.body));
    }
    return getProjectRepository().get(id);
  }

  it('copies and moves items for content admins only', async () => {
    const from = await adminProject('xfer-from', ['one', 'two']);
    await adminProject('xfer-to');
    const [one, two] = from.items;

    const denied = await drive(route.adminCopy, {
      user: ADA,
      body: { sourceId: 'xfer-from', targetId: 'xfer-to', itemIds: [one.id] }
    });
    assert.equal(denied.statusCode, 403);

    const copied = await drive(route.adminCopy, {
      user: EDITOR,
      body: { sourceId: 'xfer-from', targetId: 'xfer-to', itemIds: [one.id] }
    });
    assert.equal(copied.statusCode, 200, JSON.stringify(copied.body));
    assert.equal(copied.body.transferred.length, 1);
    assert.equal(copied.body.source.items.length, 2);
    assert.equal(copied.body.target.items.length, 1);

    const moved = await drive(route.adminMove, {
      user: EDITOR,
      body: { sourceId: 'xfer-from', targetId: 'xfer-to', itemIds: [two.id] }
    });
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
    assert.deepEqual(
      moved.body.source.items.map(item => item.id),
      [one.id]
    );
    assert.equal(moved.body.target.items.length, 2);
  });

  it('answers 400 for a bad body, 404 for a missing project and 409 for the same one', async () => {
    await adminProject('xfer-guard', ['page']);
    const itemId = (await getProjectRepository().get('xfer-guard')).items[0].id;
    const status = async (handlers, body) =>
      (await drive(handlers, { user: EDITOR, body })).statusCode;
    for (const handlers of [route.adminMove, route.adminCopy]) {
      assert.equal(
        await status(handlers, { sourceId: 'xfer-guard', targetId: 'x', itemIds: [] }),
        400
      );
      assert.equal(await status(handlers, { sourceId: 'xfer-guard', itemIds: [itemId] }), 400);
      assert.equal(
        await status(handlers, { sourceId: 'xfer-guard', targetId: 'no-such', itemIds: [itemId] }),
        404
      );
      assert.equal(
        await status(handlers, { sourceId: 'no-such', targetId: 'xfer-guard', itemIds: [itemId] }),
        404
      );
      assert.equal(
        await status(handlers, {
          sourceId: 'xfer-guard',
          targetId: 'xfer-guard',
          itemIds: [itemId]
        }),
        409
      );
    }
  });

  it('does not move items into or out of a user project', async () => {
    await adminProject('xfer-admin', ['page']);
    const mine = await create(ADA, { name: 'Mine' });
    const itemId = (await getProjectRepository().get('xfer-admin')).items[0].id;
    for (const [sourceId, targetId] of [
      ['xfer-admin', mine.id],
      [mine.id, 'xfer-admin']
    ]) {
      const res = await drive(route.adminMove, {
        user: EDITOR,
        body: { sourceId, targetId, itemIds: [itemId] }
      });
      assert.equal(res.statusCode, 404);
    }
  });

  it('says which deleted source ships with iHub and comes back at the next start', async () => {
    await adminProject('ship-keep', ['kept']);
    // `meeting-knowledge-base` is one of the shipped default projects.
    await adminProject('meeting-knowledge-base', ['m']);
    await adminProject('ship-own', ['o']);
    const merged = await drive(route.adminMerge, {
      user: EDITOR,
      body: {
        sourceIds: ['meeting-knowledge-base', 'ship-own'],
        targetId: 'ship-keep',
        deleteSources: true
      }
    });
    assert.equal(merged.statusCode, 200, JSON.stringify(merged.body));
    assert.deepEqual(
      merged.body.sources.map(entry => [entry.id, entry.deleted, entry.shipped]),
      [
        ['meeting-knowledge-base', true, true],
        ['ship-own', true, false]
      ]
    );
  });

  it('merges projects and reports what each source did', async () => {
    await adminProject('merge-keep', ['kept']);
    await adminProject('merge-a', ['a']);
    await adminProject('merge-b', ['b']);

    const denied = await drive(route.adminMerge, {
      user: ADA,
      body: { sourceIds: ['merge-a'], targetId: 'merge-keep' }
    });
    assert.equal(denied.statusCode, 403);
    const invalid = await drive(route.adminMerge, {
      user: EDITOR,
      body: { sourceIds: [], targetId: 'merge-keep' }
    });
    assert.equal(invalid.statusCode, 400);
    const self = await drive(route.adminMerge, {
      user: EDITOR,
      body: { sourceIds: ['merge-keep'], targetId: 'merge-keep' }
    });
    assert.equal(self.statusCode, 409);
    const missing = await drive(route.adminMerge, {
      user: EDITOR,
      body: { sourceIds: ['merge-ghost'], targetId: 'merge-keep' }
    });
    assert.equal(missing.statusCode, 404);

    const merged = await drive(route.adminMerge, {
      user: EDITOR,
      body: { sourceIds: ['merge-a', 'merge-b'], targetId: 'merge-keep', deleteSources: true }
    });
    assert.equal(merged.statusCode, 200, JSON.stringify(merged.body));
    assert.deepEqual(
      merged.body.sources.map(entry => [entry.id, entry.moved, entry.deleted]),
      [
        ['merge-a', 1, true],
        ['merge-b', 1, true]
      ]
    );
    assert.deepEqual(merged.body.target.items.map(item => item.name).sort(), ['a', 'b', 'kept']);
    assert.equal(await getProjectRepository().get('merge-a'), null);
    assert.equal(await getProjectRepository().get('merge-b'), null);
  });
});

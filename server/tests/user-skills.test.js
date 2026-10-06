/**
 * User skills — skills users write themselves — driven through the real route
 * chains, on the same model as user prompts.
 *
 * Everything below the handlers is real: a filesystem storage provider over
 * `mkdtemp`, the skill repository, the access policy, the settings and a
 * scratch `contents/skills/` for global skills. What is pinned here:
 *
 *  - a skill is private until shared, and a share reaches exactly the users,
 *    groups (inheritance resolved) or everyone it names;
 *  - *can use* and *can edit* are enforced on the server; only the owner and
 *    admins delete; revoking a share removes the skill from the recipient;
 *  - names, descriptions, files and size follow the skill rules and limits;
 *  - every save is a revision that can be restored;
 *  - a global skill can be copied into "my skills";
 *  - in chat, a user skill is listed for the model and loads by id for its
 *    owner and the people it is shared with — never for anyone else, and not
 *    in apps that opt out;
 *  - admins see shared skills and promote one to a global skill folder;
 *  - users browse the skills of enabled marketplace registries and add one to
 *    their own skills, with the text files that fit the limits — never from a
 *    registry that is off, and only while the marketplace is offered to them.
 *
 * Run: node --test server/tests/user-skills.test.js
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Global skills are read from CONTENTS_DIR, which the config module reads on
// import: point it at a scratch folder first.
const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-user-skills-'));
const contentsDir = path.join(baseDir, 'contents');
process.env.CONTENTS_DIR = contentsDir;
const globalSkillDir = path.join(contentsDir, 'skills', 'brand-voice');
fsSync.mkdirSync(path.join(globalSkillDir, 'references'), { recursive: true });
fsSync.writeFileSync(
  path.join(globalSkillDir, 'SKILL.md'),
  '---\nname: brand-voice\ndescription: "Applies the brand voice. Use when writing copy."\n---\n\nBRAND BODY\n'
);
fsSync.writeFileSync(path.join(globalSkillDir, 'references', 'tone.md'), 'TONE GUIDE');

const { default: configCache } = await import('../configCache.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
const { resolveGroupInheritance } = await import('../utils/authorization.js');
const { locateConfigFile } = await import('../utils/configFileLocation.js');
const { USER_SKILL_SHARES_NAMESPACE, isUserSkillId, shareMarkerKey } =
  await import('../services/skills/UserSkillRepository.js');
const { loadSkillsMetadata, validateSkillDirectory } = await import('../services/skillLoader.js');
const skillAccess = await import('../services/skillAccess.js');
const { runTool } = await import('../toolLoader.js');
const { default: registerUserSkillRoutes } = await import('../routes/userSkillRoutes.js');
const { default: registerSkillRoutes } = await import('../routes/skillRoutes.js');
const { default: registerAdminSkillsRoutes, skillMarkdownFromUserSkill } =
  await import('../routes/admin/skills.js');
const { getStorage, readFacet } = await import('../storage/bootstrap.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { userSkillsClientConfig } = await import('../services/skills/userSkillSettings.js');
const { hasSyncedRegistry } = await import('../services/skills/marketplaceSkills.js');
const { PromptNodeExecutor } = await import('../services/workflow/executors/PromptNodeExecutor.js');
const { ToolNodeExecutor } = await import('../services/workflow/executors/ToolNodeExecutor.js');

const ADA = { id: 'user-ada', name: 'Ada Lovelace', groups: ['authenticated'] };
const GRACE = { id: 'user-grace', name: 'Grace Hopper', groups: ['authenticated'] };
const CAROL = { id: 'user-carol', name: 'Carol Shaw', groups: ['engineers'] };
const ROOT = { id: 'user-root', name: 'Root', groups: ['admins'] };
const THIRD_PARTY = { ...GRACE, authMode: 'oauth_authorization_code' };
const AGENT = { id: 'agent:x', name: 'Agent', groups: ['authenticated'], isAgent: true };

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

const userRoutes = captureRoutes(registerUserSkillRoutes);
const skillRoutes = captureRoutes(registerSkillRoutes);
const adminRoutes = captureRoutes(registerAdminSkillsRoutes);

function handlersFor(routes, method, suffix) {
  const found = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(found, `${method.toUpperCase()} ${suffix} must be registered`);
  return found.handlers;
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
  list: handlersFor(userRoutes, 'get', '/api/user-skills'),
  create: handlersFor(userRoutes, 'post', '/api/user-skills'),
  get: handlersFor(userRoutes, 'get', '/api/user-skills/:skillId'),
  update: handlersFor(userRoutes, 'put', '/api/user-skills/:skillId'),
  remove: handlersFor(userRoutes, 'delete', '/api/user-skills/:skillId'),
  shares: handlersFor(userRoutes, 'put', '/api/user-skills/:skillId/shares'),
  owner: handlersFor(userRoutes, 'put', '/api/user-skills/:skillId/owner'),
  duplicate: handlersFor(userRoutes, 'post', '/api/user-skills/:skillId/duplicate'),
  duplicateGlobal: handlersFor(userRoutes, 'post', '/api/skills/:name/duplicate'),
  versions: handlersFor(userRoutes, 'get', '/api/user-skills/:skillId/versions'),
  version: handlersFor(userRoutes, 'get', '/api/user-skills/:skillId/versions/:revision'),
  restore: handlersFor(userRoutes, 'post', '/api/user-skills/:skillId/versions/:revision/restore'),
  targets: handlersFor(userRoutes, 'get', '/api/user-skills/share-targets'),
  marketplace: handlersFor(userRoutes, 'get', '/api/user-skills/marketplace'),
  marketplaceItem: handlersFor(userRoutes, 'get', '/api/user-skills/marketplace/:registryId/:name'),
  marketplaceAdd: handlersFor(
    userRoutes,
    'post',
    '/api/user-skills/marketplace/:registryId/:name/add'
  ),
  picker: handlersFor(skillRoutes, 'get', '/api/skills'),
  adminList: handlersFor(adminRoutes, 'get', '/api/admin/user-skills'),
  promote: handlersFor(adminRoutes, 'post', '/api/admin/user-skills/:skillId/promote'),
  settings: handlersFor(adminRoutes, 'get', '/api/admin/user-skills/settings')
};

const SKILL = {
  name: 'weekly-report',
  description: 'Drafts the weekly report from notes. Use when the user asks for the weekly report.',
  body: 'WEEKLY BODY',
  files: [{ path: 'references/template.md', content: 'TEMPLATE' }]
};

async function create(user, body = {}) {
  const res = await drive(route.create, { user, body: { ...SKILL, ...body } });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body;
}

async function list(user, scope) {
  const res = await drive(route.list, { user, query: scope ? { scope } : {} });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

function share(user, skillId, shares) {
  return drive(route.shares, { user, params: { skillId }, body: { shares } });
}

function setFeatures(features) {
  configCache.setCacheEntry('config/features.json', features);
}

function setUserSkillSettings(overrides = {}) {
  platform.userSkills = {
    enabled: true,
    maxSkillsPerUser: 50,
    maxVersions: 50,
    maxSkillSizeKB: 256,
    maxFilesPerSkill: 20,
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

async function writeUsers() {
  const users = {
    [ADA.id]: { ...ADA, username: 'ada', active: true },
    [GRACE.id]: { ...GRACE, username: 'grace', active: true },
    [CAROL.id]: { ...CAROL, username: 'carol', active: true },
    [ROOT.id]: { ...ROOT, username: 'root', active: true }
  };
  const usersFile = path.join(baseDir, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  return usersFile;
}

async function refreshGlobalSkills() {
  configCache.setCacheEntry('skills', [...(await loadSkillsMetadata()).values()]);
}

before(async () => {
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(baseDir, 'data'), flushIntervalMs: 25 }
    }
  });
  const usersFile = await writeUsers();
  platform = { defaultLanguage: 'en', localAuth: { usersFile } };
  setUserSkillSettings();
  setFeatures({ skills: true });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        admins: {
          id: 'admins',
          name: 'Admins',
          permissions: { apps: ['*'], skills: ['*'], models: ['*'], adminAccess: true }
        },
        engineers: {
          id: 'engineers',
          name: 'Engineers',
          inherits: ['authenticated'],
          permissions: { apps: ['*'], skills: ['*'], models: ['*'] }
        },
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          inherits: ['anonymous'],
          permissions: { apps: ['*'], skills: ['*'], models: ['*'] }
        },
        anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: [], skills: [] } }
      }
    })
  );
  await refreshGlobalSkills();
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(() => {
  setUserSkillSettings();
  setFeatures({ skills: true });
});

describe('creating and reading', () => {
  it('creates a private skill only its owner sees', async () => {
    const skill = await create(ADA);
    assert.ok(isUserSkillId(skill.id));
    assert.equal(skill.scope, 'mine');
    assert.equal(skill.body, 'WEEKLY BODY');
    assert.deepEqual(skill.files, SKILL.files);
    assert.equal(skill.fileCount, 1);
    assert.ok((await list(ADA, 'mine')).some(item => item.id === skill.id));
    assert.ok(!(await list(GRACE)).some(item => item.id === skill.id));
    const other = await drive(route.get, { user: GRACE, params: { skillId: skill.id } });
    assert.equal(other.statusCode, 404);
  });

  it('refuses names, descriptions and files that break the skill rules', async () => {
    for (const body of [
      { name: 'Weekly Report' },
      { name: 'weekly--report' },
      { description: 'x'.repeat(1025) },
      { files: [{ path: 'references/../secret.md', content: 'x' }] },
      { files: [{ path: 'images/logo.png', content: 'x' }] }
    ]) {
      const res = await drive(route.create, { user: ADA, body: { ...SKILL, ...body } });
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
  });

  it('enforces the size, file and per-user limits', async () => {
    setUserSkillSettings({ maxSkillSizeKB: 1, maxFilesPerSkill: 1 });
    const big = await drive(route.create, {
      user: GRACE,
      body: { ...SKILL, body: 'x'.repeat(2048) }
    });
    assert.equal(big.statusCode, 400);
    assert.equal(big.body.details?.code, 'SKILL_TOO_LARGE');
    const many = await drive(route.create, {
      user: GRACE,
      body: {
        ...SKILL,
        files: [
          { path: 'references/a.md', content: 'a' },
          { path: 'references/b.md', content: 'b' }
        ]
      }
    });
    assert.equal(many.body.details?.code, 'SKILL_TOO_LARGE');

    setUserSkillSettings({ maxSkillsPerUser: 1 });
    await create(GRACE);
    const second = await drive(route.create, { user: GRACE, body: SKILL });
    assert.equal(second.statusCode, 409);
    assert.equal(second.body.details?.code, 'SKILL_LIMIT_REACHED');
  });

  it('turns away anonymous callers, third-party tokens and agents', async () => {
    for (const user of [THIRD_PARTY, AGENT]) {
      const res = await drive(route.create, { user, body: SKILL });
      assert.equal(res.statusCode, 403, JSON.stringify(user));
      assert.equal(res.body.details?.code, 'USER_SKILLS_NOT_ALLOWED');
    }
    const anonymous = await drive(route.create, {
      user: { id: 'anonymous', groups: ['anonymous'] },
      body: SKILL
    });
    assert.equal(anonymous.statusCode, 401);
  });

  it('is switched off with the skills feature or the setting', async () => {
    setFeatures({ skills: false });
    const off = await drive(route.list, { user: ADA });
    assert.equal(off.statusCode, 403);
    setFeatures({ skills: true });
    setUserSkillSettings({ enabled: false });
    const disabled = await drive(route.create, { user: ADA, body: SKILL });
    assert.equal(disabled.body.details?.code, 'USER_SKILLS_DISABLED');
  });
});

describe('sharing', () => {
  it('reaches a group, enforces use versus edit, and revokes at once', async () => {
    const skill = await create(ADA, { name: 'shared-skill' });
    const shared = await share(ADA, skill.id, [
      { type: 'group', id: 'engineers', permission: 'use' }
    ]);
    assert.equal(shared.statusCode, 200, JSON.stringify(shared.body));

    const carolSees = await list(CAROL, 'shared');
    assert.ok(carolSees.some(item => item.id === skill.id && item.access === 'use'));
    assert.ok(!(await list(GRACE)).some(item => item.id === skill.id));

    const denied = await drive(route.update, {
      user: CAROL,
      params: { skillId: skill.id },
      body: { ...SKILL, name: 'shared-skill', body: 'CAROL WAS HERE' }
    });
    assert.equal(denied.statusCode, 403);

    await share(ADA, skill.id, [{ type: 'group', id: 'engineers', permission: 'edit' }]);
    const edited = await drive(route.update, {
      user: CAROL,
      params: { skillId: skill.id },
      body: { ...SKILL, name: 'shared-skill', body: 'CAROL WAS HERE' }
    });
    assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.body, 'CAROL WAS HERE');

    const deleteByEditor = await drive(route.remove, {
      user: CAROL,
      params: { skillId: skill.id }
    });
    assert.equal(deleteByEditor.statusCode, 403);

    await share(ADA, skill.id, []);
    const gone = await drive(route.get, { user: CAROL, params: { skillId: skill.id } });
    assert.equal(gone.statusCode, 404);
  });

  it('refuses a target the settings do not allow', async () => {
    setUserSkillSettings({ sharing: { allowEveryone: false } });
    const skill = await create(ADA, { name: 'no-everyone' });
    const res = await share(ADA, skill.id, [{ type: 'everyone', permission: 'use' }]);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.details?.code, 'SHARE_TARGET_NOT_ALLOWED');
  });

  it('lists share targets', async () => {
    const users = await drive(route.targets, { user: ADA, query: { q: 'gr' } });
    assert.equal(users.statusCode, 200);
    assert.ok(users.body.users.some(user => user.id === GRACE.id));
    const groups = await drive(route.targets, { user: ADA });
    assert.ok(groups.body.groups.some(group => group.id === 'engineers'));
    assert.ok(!groups.body.groups.some(group => group.id === 'anonymous'));
  });
});

describe('ownership, copies and history', () => {
  it('keeps revisions and restores an earlier one', async () => {
    const skill = await create(ADA, { name: 'versioned' });
    const updated = await drive(route.update, {
      user: ADA,
      params: { skillId: skill.id },
      body: { ...SKILL, name: 'versioned', body: 'SECOND', expectedRevision: 1 }
    });
    assert.equal(updated.body.revision, 2);
    const stale = await drive(route.update, {
      user: ADA,
      params: { skillId: skill.id },
      body: { ...SKILL, name: 'versioned', body: 'THIRD', expectedRevision: 1 }
    });
    assert.equal(stale.statusCode, 409);

    const versions = await drive(route.versions, { user: ADA, params: { skillId: skill.id } });
    assert.deepEqual(
      versions.body.map(v => v.revision),
      [2, 1]
    );
    const first = await drive(route.version, {
      user: ADA,
      params: { skillId: skill.id, revision: '1' }
    });
    assert.equal(first.body.body, 'WEEKLY BODY');
    const restored = await drive(route.restore, {
      user: ADA,
      params: { skillId: skill.id, revision: '1' }
    });
    assert.equal(restored.body.revision, 3);
    assert.equal(restored.body.body, 'WEEKLY BODY');
  });

  it('copies a shared skill and a global skill into my skills', async () => {
    const skill = await create(ADA, { name: 'copy-me' });
    await share(ADA, skill.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    const copy = await drive(route.duplicate, {
      user: GRACE,
      params: { skillId: skill.id },
      body: { name: 'my-copy' }
    });
    assert.equal(copy.statusCode, 201, JSON.stringify(copy.body));
    assert.equal(copy.body.scope, 'mine');
    assert.deepEqual(copy.body.copiedFrom, { scope: 'user', id: skill.id });

    const fromGlobal = await drive(route.duplicateGlobal, {
      user: GRACE,
      params: { name: 'brand-voice' }
    });
    assert.equal(fromGlobal.statusCode, 201, JSON.stringify(fromGlobal.body));
    assert.equal(fromGlobal.body.body, 'BRAND BODY');
    assert.deepEqual(fromGlobal.body.files, [
      { path: 'references/tone.md', content: 'TONE GUIDE' }
    ]);
    assert.deepEqual(fromGlobal.body.copiedFrom, { scope: 'global', id: 'brand-voice' });
  });

  it('hands a skill to another user and deletes it with its share markers', async () => {
    const skill = await create(ADA, { name: 'hand-over' });
    await share(ADA, skill.id, [{ type: 'group', id: 'engineers', permission: 'use' }]);
    const moved = await drive(route.owner, {
      user: ADA,
      params: { skillId: skill.id },
      body: { ownerId: GRACE.id }
    });
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
    assert.ok((await list(GRACE, 'mine')).some(item => item.id === skill.id));

    const removed = await drive(route.remove, { user: GRACE, params: { skillId: skill.id } });
    assert.equal(removed.statusCode, 200);
    const documents = readFacet(getStorage(), 'documents');
    const marker = await documents.get(
      USER_SKILL_SHARES_NAMESPACE,
      shareMarkerKey(skill.id, 'group:engineers')
    );
    assert.equal(marker, null);
  });
});

describe('in chat', () => {
  const app = { id: 'chat', skills: ['brand-voice'] };

  it('lists a user skill for the model and loads it for owner and recipients only', async () => {
    const skill = await create(ADA, { name: 'chat-skill' });
    await share(ADA, skill.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    const ada = { ...ADA, permissions: { skills: new Set(['*']) } };
    const grace = { ...GRACE, permissions: { skills: new Set(['*']) } };
    const carol = { ...CAROL, permissions: { skills: new Set(['*']) } };

    const listed = await skillAccess.listSkillsForPrompt({ app, user: ada });
    assert.ok(listed.some(entry => entry.name === 'brand-voice'));
    assert.ok(
      listed.some(entry => entry.name === skill.id && entry.description.startsWith('chat-skill:'))
    );

    for (const user of [ada, grace]) {
      const body = await runTool('activate_skill', { skill_name: skill.id, appConfig: app, user });
      assert.match(body, /WEEKLY BODY/);
      const file = await runTool('read_skill_resource', {
        skill_name: skill.id,
        file_path: 'references/template.md',
        appConfig: app,
        user
      });
      assert.equal(file, 'TEMPLATE');
    }
    const carolBody = await runTool('activate_skill', {
      skill_name: skill.id,
      appConfig: app,
      user: carol
    });
    assert.doesNotMatch(carolBody, /WEEKLY BODY/);

    const requested = await skillAccess.resolveRequestedSkills([skill.id, 'brand-voice'], {
      app,
      user: grace
    });
    assert.deepEqual(
      requested.map(entry => entry.displayName),
      ['chat-skill', 'brand-voice']
    );
  });

  it('invokes a user skill with /name, preferring own over shared over global', async () => {
    const mine = await create(GRACE, { name: 'brand-voice', body: 'GRACE BRAND' });
    const theirs = await create(ADA, { name: 'team-notes', body: 'ADA NOTES' });
    await share(ADA, theirs.id, [{ type: 'user', id: GRACE.id, permission: 'use' }]);
    const grace = { ...GRACE, permissions: { skills: new Set(['*']) } };
    const resolved = await skillAccess.resolveSkillsForTurn({
      text: 'Please /brand-voice and /team-notes this',
      app,
      user: grace
    });
    assert.deepEqual(
      resolved.map(entry => entry.name),
      [mine.id, theirs.id]
    );
    const ada = { ...ADA, permissions: { skills: new Set(['*']) } };
    const forAda = await skillAccess.resolveSkillsForTurn({ text: '/brand-voice', app, user: ada });
    assert.deepEqual(
      forAda.map(entry => entry.name),
      ['brand-voice']
    );
  });

  it("keeps the user's own namesake, picked earlier, ahead of an auto-activated skill", async () => {
    const mine = await create(ROOT, { name: 'brand-voice', body: 'ROOT BRAND' });
    const root = { ...ROOT, permissions: { skills: new Set(['*']) } };
    const auto = { ...app, skillSettings: { autoActivate: true, maxActiveSkills: 1 } };
    // A later turn: the user named their own brand-voice in an earlier one.
    const resolved = await skillAccess.resolveSkillsForTurn({
      earlier: [{ name: 'brand-voice', by: 'user' }],
      app: auto,
      user: root
    });
    assert.deepEqual(
      resolved.map(entry => [entry.name, entry.origin]),
      [[mine.id, 'chat']]
    );
    // An answer records it by its id: the same.
    const byId = await skillAccess.resolveSkillsForTurn({
      earlier: [{ id: mine.id, by: 'user' }],
      app: auto,
      user: root
    });
    assert.deepEqual(
      byId.map(entry => [entry.name, entry.origin]),
      [[mine.id, 'chat']]
    );
    // Without it, the app's global skill is the one auto-activated.
    const fresh = await skillAccess.resolveSkillsForTurn({ app: auto, user: root });
    assert.deepEqual(
      fresh.map(entry => [entry.name, entry.origin]),
      [['brand-voice', 'app']]
    );
  });

  it('keeps user skills out of apps that opt out and out of agent nodes', async () => {
    const skill = await create(ADA, { name: 'opt-out' });
    const ada = { ...ADA, permissions: { skills: new Set(['*']) } };
    const closed = { ...app, skillSettings: { allowPersonal: false } };
    assert.equal(await skillAccess.isSkillUsable(skill.id, { app: closed, user: ada }), false);
    const listed = await skillAccess.listSkillsForPrompt({ app: closed, user: ada });
    assert.ok(!listed.some(entry => entry.name === skill.id));
    const body = await runTool('activate_skill', {
      skill_name: skill.id,
      appConfig: { _skillIds: [], skills: [] },
      user: ada
    });
    assert.doesNotMatch(body, /WEEKLY BODY/);
  });

  it('offers and loads no user skills in workflow nodes, even with no skills of their own', async () => {
    const skill = await create(ADA, { name: 'node-blocked' });
    const ada = { ...ADA, permissions: { skills: new Set(['*']) } };
    const tools = await new PromptNodeExecutor().getAgentTools([], 'en', { user: ada });
    assert.ok(!tools.some(tool => tool.id === 'activate_skill'));
    const emptyNode = await new PromptNodeExecutor().getAgentTools([], 'en', {
      user: ada,
      _skillIds: []
    });
    assert.ok(!emptyNode.some(tool => tool.id === 'activate_skill'));
    const result = await new ToolNodeExecutor().execute(
      {
        id: 'activate',
        type: 'tool',
        config: { toolId: 'activate_skill', parameters: { skill_name: skill.id } }
      },
      { data: {} },
      { user: ada, appConfig: app }
    );
    assert.doesNotMatch(JSON.stringify(result.output ?? result), /WEEKLY BODY/);
  });

  it('shows the picker global and personal skills with their scope', async () => {
    const skill = await create(GRACE, { name: 'picker-skill' });
    const res = await drive(route.picker, { user: GRACE });
    assert.equal(res.statusCode, 200);
    const global = res.body.find(item => item.id === 'brand-voice');
    const mine = res.body.find(item => item.id === skill.id);
    assert.equal(global.scope, 'global');
    assert.equal(mine.scope, 'mine');
    assert.equal(mine.name, 'picker-skill');
  });
});

describe('admin', () => {
  it('lists skills shared with a group or everyone, not private ones', async () => {
    const shared = await create(ADA, { name: 'admin-visible' });
    await share(ADA, shared.id, [{ type: 'everyone', permission: 'use' }]);
    const privateSkill = await create(ADA, { name: 'admin-hidden' });
    const res = await drive(route.adminList, { user: ROOT });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.skills.some(item => item.id === shared.id && item.owner.id === ADA.id));
    assert.ok(!res.body.skills.some(item => item.id === privateSkill.id));
  });

  it('refuses the admin routes to non-admins', async () => {
    const res = await drive(route.adminList, { user: ADA });
    assert.notEqual(res.statusCode, 200);
  });

  it('promotes a user skill to a global skill folder', async () => {
    const skill = await create(ADA, { name: 'promote-me' });
    const res = await drive(route.promote, {
      user: ROOT,
      params: { skillId: skill.id },
      body: { name: 'team-weekly-report' }
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const dir = path.join(contentsDir, 'skills', 'team-weekly-report');
    const validation = await validateSkillDirectory(dir);
    assert.ok(validation.valid, JSON.stringify(validation.errors));
    assert.equal(validation.metadata.name, 'team-weekly-report');
    assert.equal(validation.metadata.description, SKILL.description);
    assert.equal(
      await fs.readFile(path.join(dir, 'references', 'template.md'), 'utf8'),
      'TEMPLATE'
    );
    const after = await drive(route.get, { user: ADA, params: { skillId: skill.id } });
    assert.equal(after.body.promotedTo.skillName, 'team-weekly-report');

    const again = await drive(route.promote, {
      user: ROOT,
      params: { skillId: skill.id },
      body: { name: 'team-weekly-report' }
    });
    assert.equal(again.statusCode, 409);
    assert.equal(again.body.details?.code, 'SKILL_NAME_TAKEN');
  });

  it('lets only one of two concurrent promotions to the same name win', async () => {
    const first = await create(ADA, { name: 'race-one' });
    const second = await create(ADA, { name: 'race-two' });
    const promote = skill =>
      drive(route.promote, {
        user: ROOT,
        params: { skillId: skill.id },
        body: { name: 'raced-skill' }
      });
    const results = await Promise.all([promote(first), promote(second)]);
    assert.deepEqual(results.map(res => res.statusCode).sort(), [201, 409]);
    const loser = results.find(res => res.statusCode === 409);
    assert.equal(loser.body.details?.code, 'SKILL_NAME_TAKEN');
    const validation = await validateSkillDirectory(
      path.join(contentsDir, 'skills', 'raced-skill')
    );
    assert.ok(validation.valid, JSON.stringify(validation.errors));
  });

  it('writes frontmatter no description can break', () => {
    const markdown = skillMarkdownFromUserSkill(
      { id: 'usk_x', ownerName: 'Ada', description: 'Says "hi"\n---\nname: evil', body: 'B' },
      'safe-name'
    );
    assert.match(
      markdown,
      /^---\nname: "safe-name"\ndescription: "Says \\"hi\\"\\n---\\nname: evil"/
    );
  });

  it('reports the settings', async () => {
    const res = await drive(route.settings, { user: ROOT });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.settings.maxFilesPerSkill, 20);
    assert.equal(res.body.storageAvailable, true);
  });
});

describe('from the marketplace', () => {
  // A registry served from 127.0.0.1: one skill with reference files (a `url`
  // source with companions), one plain SKILL.md (a `relative` source), and one
  // whose source is gone. A second registry is switched off.
  const AGENDA = `# Agenda\n${'x'.repeat(2000)}`;
  const FILES = {
    '/skills/meeting-notes/SKILL.md':
      '---\nname: meeting-notes\ndescription: "Turns meeting notes into minutes. Use for minutes."\n' +
      'license: Apache-2.0\n---\n\nMEETING BODY\n',
    '/skills/meeting-notes/references/agenda.md': AGENDA,
    '/skills/meeting-notes/references/deep/nested.md': 'NESTED',
    '/skills/meeting-notes/assets/logo.png': 'PNG',
    '/skills/plain/SKILL.md': '---\nname: plain\ndescription: "Plain skill."\n---\n\nPLAIN BODY\n'
  };
  let server;
  let base;

  const catalog = () => ({
    name: 'Test',
    items: [
      {
        type: 'skill',
        name: 'meeting-notes',
        displayName: { en: 'Meeting Notes', de: 'Besprechungsnotizen' },
        description: { en: 'Turns notes into minutes', de: 'Macht Protokolle' },
        version: '1.2.0',
        author: 'Test Author',
        category: 'productivity',
        tags: ['minutes'],
        license: 'Apache-2.0',
        source: {
          type: 'url',
          url: `${base}/skills/meeting-notes/SKILL.md`,
          companions: ['references/agenda.md', 'references/deep/nested.md', 'assets/logo.png']
        }
      },
      {
        type: 'skill',
        name: 'plain',
        displayName: { en: 'Plain' },
        description: { en: 'Plain skill' },
        category: 'writing',
        source: { type: 'relative', path: 'skills/plain/SKILL.md' }
      },
      {
        type: 'skill',
        name: 'gone',
        description: { en: 'Its source is gone' },
        category: 'writing',
        source: { type: 'url', url: `${base}/skills/gone/SKILL.md` }
      },
      { type: 'app', name: 'not-a-skill', source: { type: 'relative', path: 'apps/x.json' } }
    ]
  });

  const registries = () => ({
    registries: [
      {
        id: 'test-reg',
        name: 'Test Registry',
        enabled: true,
        source: `${base}/catalog.json`,
        auth: { type: 'none' },
        lastSynced: '2026-10-01T00:00:00.000Z'
      },
      {
        id: 'off-reg',
        name: 'Switched Off',
        enabled: false,
        source: `${base}/catalog.json`,
        auth: { type: 'none' },
        lastSynced: '2026-10-01T00:00:00.000Z'
      }
    ]
  });

  const browse = (user, query = {}) => drive(route.marketplace, { user, query });
  const add = (user, registryId, name, body = {}) =>
    drive(route.marketplaceAdd, { user, params: { registryId, name }, body });

  before(async () => {
    server = http.createServer((req, res) => {
      const file = FILES[req.url];
      if (file === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(file);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    configCache.setCacheEntry('config/registries.json', registries());
    for (const id of ['test-reg', 'off-reg']) {
      await configStore.writeJson(`.registry-cache/${id}.json`, {
        registryId: id,
        fetchedAt: new Date().toISOString(),
        catalog: catalog()
      });
    }
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    setFeatures({ skills: true, marketplace: true });
  });

  it('is offered only with the marketplace feature and the setting', async () => {
    setFeatures({ skills: true, marketplace: false });
    const featureOff = await browse(ADA);
    assert.equal(featureOff.statusCode, 403);
    assert.equal(featureOff.body.details?.code, 'MARKETPLACE_SKILLS_DISABLED');

    setFeatures({ skills: true, marketplace: true });
    setUserSkillSettings({ allowMarketplace: false });
    const settingOff = await add(ADA, 'test-reg', 'plain');
    assert.equal(settingOff.statusCode, 403);
    assert.equal(settingOff.body.details?.code, 'MARKETPLACE_SKILLS_DISABLED');

    for (const user of [THIRD_PARTY, AGENT]) {
      setUserSkillSettings();
      const refused = await browse(user);
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.body.details?.code, 'USER_SKILLS_NOT_ALLOWED');
    }
  });

  it('tells the client whether there is a marketplace to browse', () => {
    const features = { skills: true, marketplace: true };
    const ready = { storageAvailable: true, marketplaceReady: true };
    assert.equal(userSkillsClientConfig(features, platform, ready).marketplace, true);
    assert.equal(
      userSkillsClientConfig({ ...features, marketplace: false }, platform, ready).marketplace,
      false
    );
    assert.equal(
      userSkillsClientConfig(features, platform, { ...ready, marketplaceReady: false }).marketplace,
      false
    );
    assert.equal(
      userSkillsClientConfig(features, platform, { ...ready, storageAvailable: false }).marketplace,
      false
    );
    assert.equal(hasSyncedRegistry(registries()), true);
    assert.equal(
      hasSyncedRegistry({ registries: [{ id: 'x', enabled: true, lastSynced: null }] }),
      false
    );
    assert.equal(hasSyncedRegistry(undefined), false);
  });

  it('lists the skills of enabled registries, filtered and paged, without their sources', async () => {
    const res = await browse(ADA);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 3);
    assert.deepEqual(res.body.registries, [{ id: 'test-reg', name: 'Test Registry', count: 3 }]);
    assert.deepEqual(res.body.categories, ['productivity', 'writing']);
    const notes = res.body.items.find(item => item.name === 'meeting-notes');
    assert.equal(notes.registryName, 'Test Registry');
    assert.deepEqual(notes.displayName, { en: 'Meeting Notes', de: 'Besprechungsnotizen' });
    assert.equal(notes.license, 'Apache-2.0');
    assert.equal(notes.added, null);
    assert.equal(notes.availableAsGlobal, false);
    assert.equal('source' in notes, false);
    assert.equal('installation' in notes, false);

    const german = await browse(ADA, { search: 'besprechung' });
    assert.deepEqual(
      german.body.items.map(item => item.name),
      ['meeting-notes']
    );
    const writing = await browse(ADA, { category: 'writing' });
    assert.deepEqual(
      writing.body.items.map(item => item.name),
      ['plain', 'gone']
    );
    const paged = await browse(ADA, { limit: '1', page: '2' });
    assert.equal(paged.body.totalPages, 3);
    assert.deepEqual(
      paged.body.items.map(item => item.name),
      ['plain']
    );
    const otherRegistry = await browse(ADA, { registry: 'off-reg' });
    assert.equal(otherRegistry.body.total, 0);
  });

  it('shows a skill with a preview and the files that would come with it', async () => {
    const res = await drive(route.marketplaceItem, {
      user: ADA,
      params: { registryId: 'test-reg', name: 'meeting-notes' }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.body.preview.body, /MEETING BODY/);
    assert.deepEqual(res.body.preview.files, [
      { path: 'references/agenda.md', included: true },
      { path: 'references/deep/nested.md', included: false },
      { path: 'assets/logo.png', included: false }
    ]);
    assert.equal('source' in res.body, false);

    const off = await drive(route.marketplaceItem, {
      user: ADA,
      params: { registryId: 'off-reg', name: 'meeting-notes' }
    });
    assert.equal(off.statusCode, 404);
  });

  it('adds a skill with the text files that fit, privately, and reports the rest', async () => {
    const res = await add(ADA, 'test-reg', 'meeting-notes');
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.ok(isUserSkillId(res.body.id));
    assert.equal(res.body.scope, 'mine');
    assert.equal(res.body.name, 'meeting-notes');
    assert.equal(res.body.description, 'Turns meeting notes into minutes. Use for minutes.');
    assert.equal(res.body.body, 'MEETING BODY');
    assert.deepEqual(res.body.files, [{ path: 'references/agenda.md', content: AGENDA }]);
    assert.deepEqual(res.body.skippedFiles, [
      { path: 'assets/logo.png', reason: 'unsupported' },
      { path: 'references/deep/nested.md', reason: 'unsupported' }
    ]);
    assert.deepEqual(res.body.copiedFrom, {
      scope: 'marketplace',
      id: 'meeting-notes',
      registryId: 'test-reg',
      registryName: 'Test Registry',
      version: '1.2.0',
      license: 'Apache-2.0'
    });

    const listed = await browse(ADA, { search: 'meeting' });
    assert.deepEqual(listed.body.items[0].added, { id: res.body.id, name: 'meeting-notes' });
    assert.ok((await list(ADA, 'mine')).some(skill => skill.id === res.body.id));
    assert.ok(!(await list(GRACE)).some(skill => skill.id === res.body.id));
    const graceView = await browse(GRACE, { search: 'meeting' });
    assert.equal(graceView.body.items[0].added, null);

    const plain = await add(GRACE, 'test-reg', 'plain', { name: 'my-plain' });
    assert.equal(plain.statusCode, 201, JSON.stringify(plain.body));
    assert.equal(plain.body.name, 'my-plain');
    assert.equal(plain.body.body, 'PLAIN BODY');
    assert.deepEqual(plain.body.skippedFiles, []);
  });

  it('keeps to the size and per-user limits', async () => {
    setUserSkillSettings({ maxSkillSizeKB: 1 });
    const small = await add(CAROL, 'test-reg', 'meeting-notes', { name: 'small-notes' });
    assert.equal(small.statusCode, 201, JSON.stringify(small.body));
    assert.deepEqual(small.body.files, []);
    assert.ok(
      small.body.skippedFiles.some(
        file => file.path === 'references/agenda.md' && file.reason === 'sizeLimit'
      )
    );

    const owned = (await list(CAROL, 'mine')).length;
    setUserSkillSettings({ maxSkillsPerUser: owned });
    const full = await add(CAROL, 'test-reg', 'plain');
    assert.equal(full.statusCode, 409);
    assert.equal(full.body.details?.code, 'SKILL_LIMIT_REACHED');
  });

  it('refuses switched-off registries, unknown items, bad names and unreachable sources', async () => {
    const off = await add(ADA, 'off-reg', 'plain');
    assert.equal(off.statusCode, 404);
    assert.equal(off.body.details?.code, 'MARKETPLACE_SKILL_NOT_FOUND');
    const unknown = await add(ADA, 'test-reg', 'nope');
    assert.equal(unknown.statusCode, 404);
    const notASkill = await add(ADA, 'test-reg', 'not-a-skill');
    assert.equal(notASkill.statusCode, 404);
    const traversal = await add(ADA, 'test-reg', '../plain');
    assert.equal(traversal.statusCode, 404);
    const badName = await add(ADA, 'test-reg', 'plain', { name: 'Not Valid' });
    assert.equal(badName.statusCode, 400);
    const gone = await add(ADA, 'test-reg', 'gone');
    assert.equal(gone.statusCode, 502);
    assert.equal(gone.body.details?.code, 'MARKETPLACE_FETCH_FAILED');
  });
});

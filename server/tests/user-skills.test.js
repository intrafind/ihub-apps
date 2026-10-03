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
 *  - admins see shared skills and promote one to a global skill folder.
 *
 * Run: node --test server/tests/user-skills.test.js
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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

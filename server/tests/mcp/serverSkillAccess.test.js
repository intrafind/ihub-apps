// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A skill an MCP server offers reaches the model like iHub's own skills once
 * an admin approved it: listed as `<installation>:<name>` with the server in
 * front of its description, activated and read with `activate_skill` and
 * `read_skill_resource`, kept active across a chat — and only in an app that
 * turned skills on and binds the installation.
 *
 * Run: node --test server/tests/mcp/serverSkillAccess.test.js
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-skill-access-'));
process.env.CONTENTS_DIR = contentsDir;

const { default: configCache } = await import('../../configCache.js');
const skillAccess = await import('../../services/skillAccess.js');
const { runTool } = await import('../../services/tools/runTool.js');
const { setServerSkillDepsForTests, clearServerSkillCache } =
  await import('../../services/mcp/mcpSkills.js');
const { default: registerSkillRoutes } = await import('../../routes/skillRoutes.js');

const sha = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const FILES = {
  'skill://deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy safely\n---\nDEPLOY BODY\n',
  'skill://deploy/references/CHECKLIST.md': 'CHECKLIST'
};
const ENTRY = {
  uri: 'skill://deploy/SKILL.md',
  frontmatter: { name: 'deploy', description: 'Deploy safely' },
  resources: Object.entries(FILES).map(([uri, text]) => ({
    uri,
    digest: sha(text),
    size: Buffer.byteLength(text)
  }))
};

/** A connection that serves FILES as the SDK's SkillsClient would after verifying them. */
const conn = {
  listSkills: async () => ({ skills: [ENTRY], invalid: [] }),
  readSkillFile: async (_skill, ref) => {
    const uri = `skill://deploy/${ref}`;
    if (ref === 'SKILL.md') return { uri, text: FILES[uri], body: 'DEPLOY BODY\n', verified: true };
    return { uri, text: FILES[uri], verified: true };
  }
};

const instance = {
  id: 'billing',
  label: 'Billing',
  enabled: true,
  skills: { approved: { deploy: { ...ENTRY, approvedAt: '2026-11-26T00:00:00.000Z' } } }
};

const serverDeps = {
  manager: {
    hasServer: id => id === 'billing',
    withUserConnection: (_id, _user, operation) => operation(conn)
  },
  installations: { get: id => (id === 'billing' ? instance : null) },
  // The app binds the installation when it names it.
  boundInstanceIds: app => (app?.integrations?.billing ? ['billing'] : []),
  userMayUse: (_instance, user) => user.id !== 'stranger'
};

const original = {};
const stubs = {
  getSkills: () => ({ data: [], etag: 'test' }),
  getFeatures: () => ({ skills: true }),
  getPlatform: () => ({ defaultLanguage: 'en' }),
  getGroups: () => ({ data: { groups: {} } }),
  getStyles: () => ({})
};

before(() => {
  for (const [key, fn] of Object.entries(stubs)) {
    original[key] = configCache[key];
    configCache[key] = fn;
  }
  setServerSkillDepsForTests(serverDeps);
});

after(() => {
  for (const [key, fn] of Object.entries(original)) configCache[key] = fn;
  setServerSkillDepsForTests(null);
  clearServerSkillCache();
  fs.rmSync(contentsDir, { recursive: true, force: true });
});

const user = {
  id: 'alice',
  groups: ['users'],
  permissions: { skills: new Set(), apps: new Set(['ops']) }
};
const app = { id: 'ops', skillSettings: { enabled: true }, integrations: { billing: {} } };

describe('a server skill an admin approved', () => {
  test('is listed for the model under its id, with the server named', async () => {
    const listed = await skillAccess.listSkillsForPrompt({ app, user });
    assert.deepEqual(listed, [
      { name: 'billing:deploy', displayName: 'deploy', description: 'Billing: Deploy safely' }
    ]);
  });

  test('is activated and read with the skill tools', async () => {
    const appConfig = app;
    const body = await runTool('activate_skill', { skill_name: 'billing:deploy', appConfig, user });
    assert.match(body, /DEPLOY BODY/);
    assert.match(body, /references\/CHECKLIST\.md/);
    const file = await runTool('read_skill_resource', {
      skill_name: 'billing:deploy',
      file_path: 'references/CHECKLIST.md',
      appConfig,
      user
    });
    assert.equal(file, 'CHECKLIST');
  });

  test('stays active on the next turns of the chat', async () => {
    const resolved = await skillAccess.resolveSkillsForTurn({
      earlier: [{ id: 'billing:deploy', by: 'model' }],
      app,
      user
    });
    assert.deepEqual(
      resolved.map(entry => [entry.name, entry.displayName, entry.origin]),
      [['billing:deploy', 'deploy', 'chat']]
    );
  });

  test('is not offered where the app has no skills, does not bind the server, or the user may not use it', async () => {
    for (const [label, options] of [
      ['skills off', { app: { ...app, skillSettings: { enabled: false } }, user }],
      ['not bound', { app: { ...app, integrations: {} }, user }],
      ['not granted', { app, user: { ...user, id: 'stranger' } }]
    ]) {
      assert.deepEqual(await skillAccess.listSkillsForPrompt(options), [], label);
      assert.equal(await skillAccess.loadUsableSkill('billing:deploy', options), null, label);
    }
  });

  test('is started with /<installation>:<name>, or /<name> when nothing else has the name', async () => {
    assert.deepEqual(skillAccess.skillTokensIn('Run /billing:deploy now, then /deploy: done'), [
      'billing:deploy',
      'deploy'
    ]);
    for (const text of ['/billing:deploy now', 'please /deploy']) {
      const resolved = await skillAccess.resolveSkillsForTurn({ text, app, user });
      assert.deepEqual(
        resolved.map(entry => [entry.name, entry.origin]),
        [['billing:deploy', 'message']],
        text
      );
    }
  });

  test('gives way to an iHub skill of the same name; a name two servers share picks neither', async () => {
    const getSkills = configCache.getSkills;
    const getSkillsForApp = configCache.getSkillsForApp;
    const global = [{ name: 'deploy', description: 'Our own deploy skill' }];
    configCache.getSkills = () => ({ data: global, etag: 'g' });
    configCache.getSkillsForApp = async () => global;
    try {
      const resolved = await skillAccess.resolveSkillsForTurn({
        text: '/deploy',
        app: { ...app, skills: ['deploy'] },
        user
      });
      assert.deepEqual(
        resolved.map(entry => entry.name),
        ['deploy']
      );
    } finally {
      configCache.getSkills = getSkills;
      configCache.getSkillsForApp = getSkillsForApp;
    }

    const second = {
      ...instance,
      id: 'billing-eu',
      label: 'Billing EU'
    };
    setServerSkillDepsForTests({
      ...serverDeps,
      installations: { get: id => ({ billing: instance, 'billing-eu': second })[id] || null },
      boundInstanceIds: () => ['billing', 'billing-eu'],
      manager: { ...serverDeps.manager, hasServer: () => true }
    });
    try {
      assert.deepEqual(await skillAccess.resolveSkillsForTurn({ text: '/deploy', app, user }), []);
      const byId = await skillAccess.resolveSkillsForTurn({
        text: '/billing-eu:deploy',
        app,
        user
      });
      assert.deepEqual(
        byId.map(entry => entry.name),
        ['billing-eu:deploy']
      );
    } finally {
      setServerSkillDepsForTests(serverDeps);
    }
  });
});

describe('the / picker', () => {
  /** The handlers `registerSkillRoutes` registers for a path. */
  function pickerHandlers() {
    const routes = [];
    registerSkillRoutes({
      get: (routePath, ...handlers) => routes.push({ routePath, handlers }),
      post: () => {},
      put: () => {},
      delete: () => {},
      use: () => {}
    });
    return routes.find(route => route.routePath.endsWith('/api/skills')).handlers;
  }

  async function list(query) {
    const res = {
      headers: {},
      body: null,
      status() {
        return res;
      },
      setHeader(name, value) {
        res.headers[name.toLowerCase()] = value;
      },
      json(value) {
        res.body = value;
      }
    };
    const req = { query, params: {}, headers: {}, user: { ...user } };
    for (const handler of pickerHandlers()) {
      let advanced = false;
      await handler(req, res, error => {
        if (error) throw error;
        advanced = true;
      });
      if (!advanced) break;
    }
    return res;
  }

  test("lists the app's server skills, by id, with the server's name", async () => {
    const getSkillsForUser = configCache.getSkillsForUser;
    const getAppForRequest = configCache.getAppForRequest;
    configCache.getSkillsForUser = async () => ({ data: [], etag: 'x' });
    configCache.getAppForRequest = id =>
      ({ ops: app, closed: { ...app, id: 'closed' } })[id] || null;
    try {
      const withApp = await list({ appId: 'ops' });
      assert.deepEqual(withApp.body, [
        {
          id: 'billing:deploy',
          name: 'deploy',
          displayName: 'deploy',
          description: 'Deploy safely',
          scope: 'server',
          server: { id: 'billing', name: 'Billing' }
        }
      ]);
      assert.equal(withApp.headers['cache-control'], 'private, no-store');
      // Without an app, with an unknown one, or with one the user's groups do
      // not grant, there are none.
      assert.deepEqual((await list({})).body, []);
      assert.deepEqual((await list({ appId: 'secret' })).body, []);
      assert.deepEqual((await list({ appId: 'closed' })).body, []);
    } finally {
      configCache.getSkillsForUser = getSkillsForUser;
      configCache.getAppForRequest = getAppForRequest;
    }
  });
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An administrator can switch an installed skill off and change the description
 * shown for it: `POST /api/admin/skills/:name/_toggle` and
 * `PUT /api/admin/skills/:name`, kept in `config/skills.json`.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-skill-settings-'));
const contentsDir = path.join(baseDir, 'contents');
process.env.CONTENTS_DIR = contentsDir;
fsSync.mkdirSync(path.join(contentsDir, 'config'), { recursive: true });
const skillDir = path.join(contentsDir, 'skills', 'brand-voice');
fsSync.mkdirSync(skillDir, { recursive: true });
fsSync.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  '---\nname: brand-voice\ndescription: "Applies the brand voice. Use when writing copy."\n---\n\nBODY\n'
);

const { default: configCache } = await import('../configCache.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { default: registerAdminSkillsRoutes } = await import('../routes/admin/skills.js');
const { normalizeSkillOverrides, applySkillOverrides } =
  await import('../services/skills/skillOverrides.js');

const OVERRIDES_FILE = path.join(contentsDir, 'config', 'skills.json');
const ADMIN = { id: 'root', name: 'Root', isAdmin: true, groups: ['admins'] };

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
const routes = captureRoutes(registerAdminSkillsRoutes);
const handlersFor = (method, suffix) => {
  const found = routes.find(r => r.method === method && r.routePath.endsWith(suffix));
  assert.ok(found, `${method.toUpperCase()} ${suffix} must be registered`);
  return found.handlers;
};
const route = {
  toggle: handlersFor('post', '/api/admin/skills/:name/_toggle'),
  update: handlersFor('put', '/api/admin/skills/:name')
};

async function drive(handlers, { params = {}, body = {} } = {}) {
  const req = { params, query: {}, body, headers: {}, user: ADMIN, ip: '127.0.0.1' };
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.end = () => res;
  res.setHeader = () => res;
  for (const handler of handlers) {
    let advanced = false;
    try {
      await handler(req, res, error => {
        if (error) throw error;
        advanced = true;
      });
    } catch (error) {
      errorHandler(error, req, res, () => {});
      break;
    }
    if (!advanced) break;
  }
  return res;
}

const skillOf = () => configCache.getSkills().data.find(s => s.name === 'brand-voice');
const savedFile = async () => JSON.parse(await fs.readFile(OVERRIDES_FILE, 'utf8'));

before(async () => {
  configCache.setCacheEntry('config/features.json', { skills: true });
  await configCache.refreshSkillsCache();
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('skill overrides file', () => {
  it('keeps only well-formed entries and tolerates a damaged file', () => {
    const overrides = normalizeSkillOverrides({
      skills: {
        good: { enabled: false, configOverrides: { description: '  Shown  ' } },
        wrong: { enabled: 'no', configOverrides: { description: 5 } },
        empty: { configOverrides: { description: '   ' } },
        junk: 'text',
        ['__proto__']: { enabled: false }
      }
    });
    assert.deepEqual(
      { ...overrides.good },
      {
        enabled: false,
        configOverrides: { description: 'Shown' }
      }
    );
    assert.equal(overrides.wrong, undefined);
    assert.equal(overrides.empty, undefined);
    assert.equal(overrides.junk, undefined);
    assert.equal(Object.keys(normalizeSkillOverrides(null)).length, 0);
    assert.equal(Object.keys(normalizeSkillOverrides({ skills: [] })).length, 0);
  });

  it('never changes a system skill', () => {
    const [skill] = applySkillOverrides(
      [{ name: 'builder', description: 'Own', isSystem: true }],
      normalizeSkillOverrides({
        skills: { builder: { enabled: false, configOverrides: { description: 'X' } } }
      })
    );
    assert.equal(skill.enabled, true);
    assert.equal(skill.description, 'Own');
  });
});

describe('POST /api/admin/skills/:name/_toggle', () => {
  it('switches a skill off and on, and offers it to no one while it is off', async () => {
    const user = { id: 'u1', groups: ['authenticated'], permissions: { skills: new Set(['*']) } };
    assert.equal(skillOf().enabled, true);
    assert.ok((await configCache.getSkillsForUser(user)).data.some(s => s.name === 'brand-voice'));

    const off = await drive(route.toggle, { params: { name: 'brand-voice' } });
    assert.equal(off.statusCode, 200, JSON.stringify(off.body));
    assert.equal(off.body.enabled, false);
    assert.equal(skillOf().enabled, false);
    assert.deepEqual((await savedFile()).skills['brand-voice'], { enabled: false });
    assert.ok(!(await configCache.getSkillsForUser(user)).data.some(s => s.name === 'brand-voice'));

    const on = await drive(route.toggle, { params: { name: 'brand-voice' } });
    assert.equal(on.body.enabled, true);
    assert.deepEqual((await savedFile()).skills, {}, 'the default leaves no entry behind');
    assert.ok((await configCache.getSkillsForUser(user)).data.some(s => s.name === 'brand-voice'));
  });

  it('refuses to switch off a system skill', async () => {
    const system = configCache.getSkills().data.find(skill => skill.isSystem);
    assert.ok(system, 'iHub ships at least one system skill');
    const res = await drive(route.toggle, { params: { name: system.name } });
    assert.equal(res.statusCode, 403);
    const put = await drive(route.update, {
      params: { name: system.name },
      body: { configOverrides: { description: 'x' } }
    });
    assert.equal(put.statusCode, 403);
  });

  it('answers 404 for an unknown skill and 400 for an unsafe name', async () => {
    assert.equal((await drive(route.toggle, { params: { name: 'nope' } })).statusCode, 404);
    assert.equal((await drive(route.toggle, { params: { name: '../x' } })).statusCode, 400);
  });
});

describe('PUT /api/admin/skills/:name', () => {
  it('sets, then removes, the description shown for a skill', async () => {
    const set = await drive(route.update, {
      params: { name: 'brand-voice' },
      body: { configOverrides: { description: '  Our brand voice, for copy.  ' } }
    });
    assert.equal(set.statusCode, 200, JSON.stringify(set.body));
    assert.equal(set.body.description, 'Our brand voice, for copy.');
    assert.deepEqual(set.body.configOverrides, { description: 'Our brand voice, for copy.' });
    assert.equal(skillOf().description, 'Our brand voice, for copy.');

    const cleared = await drive(route.update, {
      params: { name: 'brand-voice' },
      body: { configOverrides: { description: '' } }
    });
    assert.equal(cleared.statusCode, 200);
    assert.match(cleared.body.description, /^Applies the brand voice/);
    assert.equal(cleared.body.configOverrides, undefined);
    assert.deepEqual((await savedFile()).skills, {});
  });

  it('keeps the on/off state when only the description changes', async () => {
    await drive(route.toggle, { params: { name: 'brand-voice' } });
    await drive(route.update, {
      params: { name: 'brand-voice' },
      body: { configOverrides: { description: 'Custom' } }
    });
    assert.deepEqual((await savedFile()).skills['brand-voice'], {
      enabled: false,
      configOverrides: { description: 'Custom' }
    });
    await drive(route.toggle, { params: { name: 'brand-voice' } });
    await drive(route.update, {
      params: { name: 'brand-voice' },
      body: { configOverrides: { description: '' } }
    });
  });

  it('refuses a body with other fields or an overlong description', async () => {
    const extra = await drive(route.update, {
      params: { name: 'brand-voice' },
      body: { configOverrides: { description: 'x' }, enabled: false }
    });
    assert.equal(extra.statusCode, 400);
    const long = await drive(route.update, {
      params: { name: 'brand-voice' },
      body: { configOverrides: { description: 'x'.repeat(1025) } }
    });
    assert.equal(long.statusCode, 400);
    assert.equal((await drive(route.update, { params: { name: 'brand-voice' } })).statusCode, 400);
  });
});

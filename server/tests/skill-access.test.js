/**
 * Skill access: a skill loads only when it is installed, assigned to the app
 * (or agent node) and granted to the user's groups — for the skills list, the
 * `activate_skill` / `read_skill_resource` tools, `requestedSkills`
 * pre-activation and the agent planner.
 *
 * Run: node --test server/tests/skill-access.test.js
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The skill loader resolves the skills folder from CONTENTS_DIR when the
// config module loads, so point it at a scratch folder before importing.
const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-access-'));
process.env.CONTENTS_DIR = contentsDir;

function writeSkill(name, description, body, files = {}) {
  const dir = path.join(contentsDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`
  );
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

writeSkill('alpha', 'Alpha skill <b>bold</b> & more', 'ALPHA BODY', {
  'references/notes.md': 'ALPHA NOTES'
});
writeSkill('beta', 'Beta skill', 'BETA BODY', { 'references/secret.md': 'BETA SECRET' });
writeSkill('gamma', 'Gamma skill', 'GAMMA BODY');

const { default: configCache } = await import('../configCache.js');
const { loadSkillsMetadata } = await import('../services/skillLoader.js');
const skillAccess = await import('../services/skillAccess.js');
const { runTool } = await import('../toolLoader.js');
const { default: PromptService } = await import('../services/PromptService.js');
const { PlannerNodeExecutor } =
  await import('../services/workflow/executors/PlannerNodeExecutor.js');
const { buildDefaultWorkflowForProfile } =
  await import('../agents/profile/profileWorkflowSerializer.js');
const { resolveNodeSkillIds } =
  await import('../services/workflow/executors/PromptNodeExecutor.js');

const skills = [...(await loadSkillsMetadata()).values()];
let features = { skills: true };
const original = {};
const stubs = {
  getSkills: () => ({ data: skills, etag: 'test' }),
  getFeatures: () => features,
  getPlatform: () => ({ defaultLanguage: 'en' }),
  getGroups: () => ({
    data: {
      groups: {
        agents: { id: 'agents', permissions: { skills: ['alpha'] } },
        everyone: { id: 'everyone', permissions: { skills: ['*'] } }
      }
    }
  }),
  getStyles: () => ({})
};

before(() => {
  for (const [key, fn] of Object.entries(stubs)) {
    original[key] = configCache[key];
    configCache[key] = fn;
  }
});

after(() => {
  for (const [key, fn] of Object.entries(original)) configCache[key] = fn;
  fs.rmSync(contentsDir, { recursive: true, force: true });
});

/** An expanded user whose groups grant `granted` skills. */
const userWith = granted => ({
  id: 'u1',
  groups: ['users'],
  permissions: { skills: new Set(granted) }
});

const names = list => list.map(s => s.name).sort();

describe('getSkillsForUser', () => {
  test('an empty grant sees no skills', async () => {
    const { data } = await configCache.getSkillsForUser(userWith([]));
    assert.deepEqual(data, []);
  });

  test('a wildcard grant sees every skill', async () => {
    const { data } = await configCache.getSkillsForUser(userWith(['*']));
    assert.deepEqual(names(data), ['alpha', 'beta', 'gamma']);
  });

  test('a named grant sees only that skill', async () => {
    const { data } = await configCache.getSkillsForUser(userWith(['beta']));
    assert.deepEqual(names(data), ['beta']);
  });

  test('a bare principal gets the grant of its groups', async () => {
    const { data } = await configCache.getSkillsForUser({ id: 'agent:x', groups: ['agents'] });
    assert.deepEqual(names(data), ['alpha']);
  });

  test('a principal without permissions or groups sees no skills', async () => {
    assert.deepEqual((await configCache.getSkillsForUser(null)).data, []);
    assert.deepEqual((await configCache.getSkillsForUser({ id: 'system', groups: [] })).data, []);
  });
});

describe('isSkillUsable', () => {
  test('needs the skill assigned and granted', async () => {
    const user = userWith(['alpha', 'gamma']);
    assert.equal(await skillAccess.isSkillUsable('alpha', { skillIds: ['alpha'], user }), true);
    assert.equal(await skillAccess.isSkillUsable('beta', { skillIds: ['alpha'], user }), false);
    assert.equal(await skillAccess.isSkillUsable('beta', { skillIds: ['beta'], user }), false);
    assert.equal(
      await skillAccess.isSkillUsable('missing', { skillIds: ['missing'], user }),
      false
    );
  });

  test('is false while the skills feature is off', async () => {
    features = { skills: false };
    try {
      const user = userWith(['*']);
      assert.equal(await skillAccess.isSkillUsable('alpha', { skillIds: ['alpha'], user }), false);
    } finally {
      features = { skills: true };
    }
  });

  test('reads an agent node list before the app list', () => {
    assert.deepEqual(skillAccess.getAssignedSkillIds({ skills: ['a'], _skillIds: ['b'] }), ['b']);
    assert.deepEqual(skillAccess.getAssignedSkillIds({ skills: ['a'] }), ['a']);
    assert.deepEqual(skillAccess.getAssignedSkillIds(undefined), []);
  });
});

describe('resolveRequestedSkills', () => {
  const app = { id: 'app', skills: ['alpha', 'beta', 'gamma'] };

  test('keeps usable names in request order without duplicates', async () => {
    const user = userWith(['alpha', 'gamma']);
    const resolved = await skillAccess.resolveRequestedSkills(['gamma', 'beta', 'gamma', 'alpha'], {
      app,
      user
    });
    assert.deepEqual(
      resolved.map(s => s.name),
      ['gamma', 'alpha']
    );
  });

  test('stops at maxActiveSkills', async () => {
    const user = userWith(['*']);
    const capped = await skillAccess.resolveRequestedSkills(['alpha', 'beta', 'gamma'], {
      app: { ...app, skillSettings: { maxActiveSkills: 2 } },
      user
    });
    assert.deepEqual(
      capped.map(s => s.name),
      ['alpha', 'beta']
    );
  });

  test('falls back to the default cap for an invalid maxActiveSkills and caps it at 10', () => {
    const cap = maxActiveSkills =>
      skillAccess.maxActiveSkillsFor({ skillSettings: { maxActiveSkills } });
    assert.equal(skillAccess.maxActiveSkillsFor({}), skillAccess.DEFAULT_MAX_ACTIVE_SKILLS);
    for (const invalid of [0, -1, 2.5, '2', 'abc', null]) {
      assert.equal(cap(invalid), skillAccess.DEFAULT_MAX_ACTIVE_SKILLS, String(invalid));
    }
    assert.equal(cap(1), 1);
    assert.equal(cap(25), 10);
  });

  test('loads nothing on an app without skills', async () => {
    const resolved = await skillAccess.resolveRequestedSkills(['alpha'], {
      app: { id: 'plain' },
      user: userWith(['*'])
    });
    assert.deepEqual(resolved, []);
  });
});

describe('activate_skill and read_skill_resource', () => {
  const appConfig = { id: 'app', skills: ['alpha'] };

  test('load an assigned, granted skill and its files', async () => {
    const user = userWith(['*']);
    const body = await runTool('activate_skill', { skill_name: 'alpha', appConfig, user });
    assert.match(body, /ALPHA BODY/);
    assert.match(body, /references\/notes\.md/);
    const file = await runTool('read_skill_resource', {
      skill_name: 'alpha',
      file_path: 'references/notes.md',
      appConfig,
      user
    });
    assert.equal(file, 'ALPHA NOTES');
  });

  test('refuse an installed skill the app does not have', async () => {
    const user = userWith(['*']);
    const body = await runTool('activate_skill', { skill_name: 'beta', appConfig, user });
    assert.doesNotMatch(body, /BETA BODY/);
    assert.match(body, /not found/);
    const file = await runTool('read_skill_resource', {
      skill_name: 'beta',
      file_path: 'references/secret.md',
      appConfig,
      user
    });
    assert.doesNotMatch(file, /BETA SECRET/);
  });

  test('refuse a skill the user is not granted', async () => {
    const body = await runTool('activate_skill', {
      skill_name: 'alpha',
      appConfig,
      user: userWith(['gamma'])
    });
    assert.doesNotMatch(body, /ALPHA BODY/);
  });

  test('check an agent node against its own list', async () => {
    const body = await runTool('activate_skill', {
      skill_name: 'gamma',
      appConfig: { skills: ['alpha'], _skillIds: ['gamma'] },
      user: { id: 'agent:x', groups: ['everyone'] }
    });
    assert.match(body, /GAMMA BODY/);
  });
});

describe('PromptService skills block', () => {
  const run = (app, user, requestedSkills) =>
    PromptService.processMessageTemplates(
      [{ role: 'user', content: 'hi' }],
      app,
      null,
      null,
      'en',
      null,
      user,
      null,
      null,
      requestedSkills
    );

  test('pre-activates only requested skills the app and user allow', async () => {
    const app = { id: 'app', system: { en: 'SYSTEM' }, skills: ['alpha', 'gamma'] };
    const [system] = await run(app, userWith(['alpha', 'beta']), ['beta', 'alpha', 'gamma']);
    assert.match(system.content, /<active_skill name="alpha">\nALPHA BODY/);
    assert.doesNotMatch(system.content, /BETA BODY/);
    assert.doesNotMatch(system.content, /GAMMA BODY/);
    assert.doesNotMatch(system.content, /Several skills are active/);
  });

  test('pre-activates nothing on an app without skills', async () => {
    const app = { id: 'plain', system: { en: 'SYSTEM' } };
    const [system] = await run(app, userWith(['*']), ['alpha']);
    assert.doesNotMatch(system.content, /ALPHA BODY|available_skills/);
  });

  test('lists usable skills with escaped descriptions and stacks several', async () => {
    const app = { id: 'app', system: { en: 'SYSTEM' }, skills: ['alpha', 'gamma'] };
    const [system] = await run(app, userWith(['*']), ['gamma', 'alpha']);
    assert.match(
      system.content,
      /<description>Alpha skill &lt;b&gt;bold&lt;\/b&gt; &amp; more<\/description>/
    );
    assert.match(system.content, /Several skills are active/);
    assert.ok(system.content.indexOf('GAMMA BODY') < system.content.indexOf('ALPHA BODY'));
  });
});

describe('/name in the prompt', () => {
  test('finds skill names written as /name', () => {
    assert.deepEqual(skillAccess.skillTokensIn('/alpha do it'), ['alpha']);
    assert.deepEqual(skillAccess.skillTokensIn('Use /beta, then /alpha. And /beta again'), [
      'beta',
      'alpha'
    ]);
    assert.deepEqual(skillAccess.skillTokensIn('and/or http://host/alpha /Alpha /a--b'), []);
    assert.deepEqual(skillAccess.skillTokensIn(undefined), []);
  });

  test('reads the last user message, text parts included', () => {
    assert.equal(
      skillAccess.lastUserText([
        { role: 'user', content: '/alpha first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: '/gamma now' }, { type: 'image_url' }] }
      ]),
      '/gamma now'
    );
  });

  test('pre-activates the skills the message invokes, if the app and user allow them', async () => {
    const app = { id: 'app', system: { en: 'SYSTEM' }, skills: ['alpha'] };
    const [system] = await PromptService.processMessageTemplates(
      [{ role: 'user', content: '/alpha and /beta: summarize this' }],
      app,
      null,
      null,
      'en',
      null,
      userWith(['*']),
      null,
      null,
      null
    );
    assert.match(system.content, /<active_skill name="alpha">\nALPHA BODY/);
    assert.doesNotMatch(system.content, /BETA BODY/);
  });

  test('puts explicitly requested skills first and caps the total', async () => {
    const resolved = await skillAccess.resolveSkillsForTurn({
      requested: ['gamma'],
      text: '/alpha /beta /gamma',
      app: { id: 'app', skills: ['alpha', 'beta', 'gamma'], skillSettings: { maxActiveSkills: 2 } },
      user: userWith(['*'])
    });
    assert.deepEqual(
      resolved.map(s => s.name),
      ['gamma', 'alpha']
    );
  });
});

describe('agent planner', () => {
  test('pre-activates only skills on its own list', async () => {
    const executor = new PlannerNodeExecutor();
    const state = { data: {} };
    await executor._activateSkillsIntoState(
      ['alpha', 'beta'],
      state,
      { user: { id: 'agent:x', groups: ['everyone'] } },
      { skills: ['alpha'] }
    );
    assert.deepEqual(Object.keys(state.data._activatedSkills), ['alpha']);
    assert.equal(state.data._activatedSkills.alpha.description, 'Alpha skill <b>bold</b> & more');
  });

  test('an empty skills list on a node means no skills, a missing one the profile', () => {
    const profile = { skills: ['alpha'] };
    assert.deepEqual(resolveNodeSkillIds({ skills: [] }, profile), []);
    assert.deepEqual(resolveNodeSkillIds({ skills: ['beta'] }, profile), ['beta']);
    assert.deepEqual(resolveNodeSkillIds({}, profile), ['alpha']);
    assert.equal(resolveNodeSkillIds({}, {}), null);
  });

  test('gets the profile skills on the planner node', () => {
    const workflow = buildDefaultWorkflowForProfile({
      id: 'p',
      name: 'P',
      planner: { enabled: true },
      skills: ['alpha']
    });
    const planner = workflow.nodes.find(node => node.type === 'planner');
    assert.deepEqual(planner.config.skills, ['alpha']);
  });
});

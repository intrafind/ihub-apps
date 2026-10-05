/**
 * Skills in the model's context: the list the model is offered (within its
 * token budget, with `find_skill` when it is shortened), skills only users may
 * start (`disable-model-invocation`), skills that stay active across a chat,
 * the budget for active skills' instructions, and how an activation is
 * recorded so the next turn finds the skill again.
 *
 * Run: node --test server/tests/skill-context.test.js
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The skill loader resolves the skills folder from CONTENTS_DIR when the
// config module loads, so point it at a scratch folder before importing.
const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-context-'));
process.env.CONTENTS_DIR = contentsDir;

function writeSkill(name, description, body, { frontmatter = '', files = {} } = {}) {
  const dir = path.join(contentsDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\n${frontmatter}---\n\n${body}\n`
  );
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

const BIG_BODY = 'Follow every step of this long procedure carefully. '.repeat(400);

writeSkill('alpha', 'Draft the weekly newsletter from notes', 'ALPHA BODY', {
  files: { 'references/notes.md': 'ALPHA NOTES' }
});
writeSkill('beta', 'Review a contract', 'BETA BODY');
writeSkill('gamma', 'Plan a meeting', 'GAMMA BODY');
writeSkill('manual', 'Send the newsletter to everyone', 'MANUAL BODY', {
  frontmatter: 'disable-model-invocation: true\n'
});
writeSkill('big', 'A skill with long instructions', BIG_BODY);

const { default: configCache } = await import('../configCache.js');
const { loadSkillsMetadata } = await import('../services/skillLoader.js');
const skillAccess = await import('../services/skillAccess.js');
const { getToolsForApp, runTool } = await import('../toolLoader.js');
const { default: PromptService } = await import('../services/PromptService.js');
const { PlannerNodeExecutor } =
  await import('../services/workflow/executors/PlannerNodeExecutor.js');
const { estimateTokens } = await import('../../shared/tokenEstimator.js');
const { createStreamState, reduceRunEvents } = await import('../../shared/run/runReducer.js');
const { boundStoredActivity } = await import('../services/chat/runActivity.js');
const { announcedSkills, historyForPrompt } = await import('../routes/chat/sessionRoutes.js');

const skills = [...(await loadSkillsMetadata()).values()];
let platform = { defaultLanguage: 'en' };
const original = {};
const stubs = {
  getSkills: () => ({ data: skills, etag: 'test' }),
  getFeatures: () => ({ skills: true }),
  getPlatform: () => platform,
  getGroups: () => ({
    data: { groups: { everyone: { id: 'everyone', permissions: { skills: ['*'] } } } }
  }),
  getStyles: () => ({}),
  getTools: () => ({ data: [] }),
  getSources: () => ({ data: [] })
};

before(() => {
  for (const [key, fn] of Object.entries(stubs)) {
    original[key] = configCache[key];
    configCache[key] = fn;
  }
});

afterEach(() => {
  platform = { defaultLanguage: 'en' };
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

const app = { id: 'app', system: { en: 'SYSTEM' }, skills: ['alpha', 'beta', 'gamma', 'manual'] };

/** The system prompt PromptService builds for a chat. */
async function systemPromptFor(messages, { appConfig = app, user = userWith(['*']) } = {}) {
  const [system] = await PromptService.processMessageTemplates(
    messages,
    appConfig,
    null,
    null,
    'en',
    null,
    user,
    null,
    null,
    null
  );
  return system.content;
}

const user = content => ({ role: 'user', content });
const answer = (content, activeSkills) => ({
  role: 'assistant',
  content,
  ...(activeSkills ? { activeSkills } : {})
});

describe('the skills list', () => {
  test('lists the skills the model may start, with a line on how to use them', async () => {
    const catalog = await skillAccess.describeSkillCatalog({ app, user: userWith(['*']) });
    assert.deepEqual(
      catalog.entries.map(entry => entry.name),
      ['alpha', 'beta', 'gamma']
    );
    assert.equal(catalog.compact, false);
    assert.match(catalog.text, /call activate_skill with the skill's name/);
    assert.match(
      catalog.text,
      /<description>Draft the weekly newsletter from notes<\/description>/
    );
    assert.doesNotMatch(catalog.text, /manual/);
  });

  test('shortens descriptions over the budget, then lists the names that fit', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      name: `skill-${i}`,
      description: 'Draft the weekly newsletter from the notes of the team. '.repeat(15)
    }));
    const full = skillAccess.buildSkillCatalog(entries, { maxTokens: 100000 });
    assert.equal(full.compact, false);

    const shortened = skillAccess.buildSkillCatalog(entries, { maxTokens: 2500 });
    assert.equal(shortened.compact, true);
    assert.equal(shortened.listed, 30);
    assert.ok(estimateTokens(shortened.text) <= 2500);
    assert.match(shortened.text, /descriptions are shortened: call find_skill/);
    assert.match(shortened.text, /…<\/description>/);

    const names = skillAccess.buildSkillCatalog(entries, { maxTokens: 200 });
    assert.equal(names.compact, true);
    assert.ok(names.listed > 0 && names.listed < 30, String(names.listed));
    assert.doesNotMatch(names.text, /<description>/);
    assert.match(names.text, new RegExp(`${30 - names.listed} more skills are not listed`));
  });

  test('takes its budget from platform.skills.maxCatalogTokens', async () => {
    assert.equal(skillAccess.maxCatalogTokensFor({}), skillAccess.DEFAULT_MAX_CATALOG_TOKENS);
    assert.equal(skillAccess.maxCatalogTokensFor({ skills: { maxCatalogTokens: -1 } }), 3000);
    platform = { defaultLanguage: 'en', skills: { maxCatalogTokens: 40 } };
    const catalog = await skillAccess.describeSkillCatalog({ app, user: userWith(['*']) });
    assert.equal(catalog.compact, true);
  });

  test('is in the system prompt and does not depend on the message', async () => {
    const first = await systemPromptFor([user('write the newsletter')]);
    const second = await systemPromptFor([user('something else entirely')]);
    assert.match(first, /<available_skills>/);
    assert.equal(first, second);
  });

  test('ranks name matches above description matches', () => {
    const entries = [
      { name: 'meeting-notes', description: 'Summarize a meeting for the newsletter' },
      { name: 'newsletter', description: 'Draft a newsletter' },
      { name: 'other', description: 'Nothing to see' }
    ];
    assert.deepEqual(
      skillAccess.searchSkillCatalog(entries, 'Newsletter').map(entry => entry.name),
      ['newsletter', 'meeting-notes']
    );
    assert.deepEqual(skillAccess.searchSkillCatalog(entries, 'a ?'), []);
  });
});

describe('skill tools', () => {
  const toolsFor = async (context = {}) =>
    getToolsForApp(app, 'en', { user: userWith(['*']), ...context });
  const tool = (tools, id) => tools.find(t => t.id === id);

  test('take only the names of the listed skills', async () => {
    const tools = await toolsFor();
    const names = ['alpha', 'beta', 'gamma'];
    assert.deepEqual(tool(tools, 'activate_skill').parameters.properties.skill_name.enum, names);
    assert.deepEqual(
      tool(tools, 'read_skill_resource').parameters.properties.skill_name.enum,
      names
    );
    assert.equal(tool(tools, 'find_skill'), undefined);
  });

  test('also take the names of the skills active in the turn', async () => {
    const tools = await toolsFor({ activeSkills: [{ name: 'manual', full: true }] });
    assert.deepEqual(tool(tools, 'activate_skill').parameters.properties.skill_name.enum, [
      'alpha',
      'beta',
      'gamma',
      'manual'
    ]);
  });

  test('are left out when there is no skill to load', async () => {
    const tools = await toolsFor({ user: userWith([]) });
    assert.equal(tool(tools, 'activate_skill'), undefined);
    assert.equal(tool(tools, 'read_skill_resource'), undefined);
  });

  test('include find_skill when the list is shortened', async () => {
    platform = { defaultLanguage: 'en', skills: { maxCatalogTokens: 40 } };
    const tools = await toolsFor();
    assert.ok(tool(tools, 'find_skill'));
  });

  test('find_skill searches the listed skills only', async () => {
    const params = { appConfig: app, user: userWith(['*']) };
    const found = await runTool('find_skill', { ...params, query: 'newsletter' });
    assert.match(found, /- alpha: Draft the weekly newsletter from notes/);
    assert.doesNotMatch(found, /manual/);
    assert.match(await runTool('find_skill', { ...params, query: 'astronomy' }), /No skill/);
    assert.match(await runTool('find_skill', { ...params, query: ' ' }), /keywords/);
  });
});

describe('a skill only users may start', () => {
  const params = { appConfig: app, user: userWith(['*']) };

  test('is marked in its metadata', () => {
    const manual = skills.find(skill => skill.name === 'manual');
    assert.equal(manual.modelInvocable, false);
    assert.equal(skills.find(skill => skill.name === 'alpha').modelInvocable, true);
  });

  test('cannot be activated by the model', async () => {
    const result = await runTool('activate_skill', { ...params, skill_name: 'manual' });
    assert.match(result, /can only be started by the user, by writing \/manual/);
    assert.doesNotMatch(result, /MANUAL BODY/);
  });

  test('starts with /name and can then be loaded', async () => {
    assert.match(await systemPromptFor([user('/manual send it')]), /MANUAL BODY/);
    const loaded = await runTool('activate_skill', {
      ...params,
      appConfig: { ...app, _activeSkills: [{ name: 'manual', full: false }] },
      skill_name: 'manual'
    });
    assert.match(loaded, /MANUAL BODY/);
  });

  test('is not pre-activated by the agent planner', async () => {
    const state = { data: {} };
    await new PlannerNodeExecutor()._activateSkillsIntoState(
      ['manual', 'alpha'],
      state,
      { user: { id: 'agent:x', groups: ['everyone'] } },
      { skills: ['manual', 'alpha'] }
    );
    assert.deepEqual(Object.keys(state.data._activatedSkills), ['alpha']);
  });
});

describe('skills stay active across a chat', () => {
  test('earlier turns name their skills newest first', () => {
    const refs = skillAccess.earlierSkillRefs([
      user('/alpha start'),
      answer('ok', [{ name: 'Beta', id: 'beta' }, { name: 'gamma' }]),
      user('/manual now')
    ]);
    assert.deepEqual(refs, [{ name: 'gamma' }, { id: 'beta' }, { name: 'alpha' }]);
  });

  test('a skill named with /name stays active in later turns', async () => {
    const system = await systemPromptFor([
      user('/alpha draft it'),
      answer('Here is a draft'),
      user('make it shorter')
    ]);
    assert.match(system, /<active_skill name="alpha">\nALPHA BODY/);
  });

  test('a skill the model activated stays active in later turns', async () => {
    const system = await systemPromptFor([
      user('plan the meeting'),
      answer('Planned', [{ name: 'gamma', description: 'Plan a meeting', id: 'gamma' }]),
      user('add a break')
    ]);
    assert.match(system, /<active_skill name="gamma">\nGAMMA BODY/);
  });

  test('access is checked again on every turn', async () => {
    const messages = [user('/alpha draft'), answer('ok', [{ id: 'gamma' }]), user('again')];
    const revoked = await systemPromptFor(messages, { user: userWith(['beta']) });
    assert.doesNotMatch(revoked, /ALPHA BODY|GAMMA BODY/);
    const unassigned = await systemPromptFor(messages, {
      appConfig: { ...app, skills: ['beta'] }
    });
    assert.doesNotMatch(unassigned, /ALPHA BODY|GAMMA BODY/);
  });

  test('the skills named last win when there are more than the app allows', async () => {
    const { skills: active } = await skillAccess.prepareActiveSkills({
      messages: [
        user('/alpha first'),
        answer('ok', [{ id: 'gamma' }]),
        user('/beta then'),
        answer('ok'),
        user('go on')
      ],
      app: { ...app, skillSettings: { maxActiveSkills: 2 } },
      user: userWith(['*'])
    });
    assert.deepEqual(
      active.map(skill => [skill.name, skill.origin]),
      [
        ['beta', 'chat'],
        ['gamma', 'chat']
      ]
    );
  });

  test('the current turn comes before the chat', async () => {
    const { skills: active } = await skillAccess.prepareActiveSkills({
      messages: [user('/alpha first'), answer('ok'), user('/gamma now')],
      requested: ['beta'],
      app,
      user: userWith(['*'])
    });
    assert.deepEqual(
      active.map(skill => [skill.name, skill.origin]),
      [
        ['beta', 'requested'],
        ['gamma', 'message'],
        ['alpha', 'chat']
      ]
    );
  });

  test('nothing is carried over when the request has no history', async () => {
    const system = await systemPromptFor([user('make it shorter')]);
    assert.doesNotMatch(system, /<active_skill/);
  });
});

describe('the budget for active skills', () => {
  const bigApp = { ...app, skills: [...app.skills, 'big'] };

  test('a skill over maxSkillBodyTokens is active by description only', async () => {
    platform = { defaultLanguage: 'en', skills: { maxSkillBodyTokens: 1000 } };
    const prepared = await skillAccess.prepareActiveSkills({
      messages: [user('/big go')],
      app: bigApp,
      user: userWith(['*'])
    });
    assert.deepEqual(
      prepared.skills.map(skill => [skill.name, skill.full]),
      [['big', false]]
    );
    assert.match(prepared.text, /A skill with long instructions/);
    assert.match(prepared.text, /too long to include here\. Call activate_skill/);
    assert.doesNotMatch(prepared.text, /Follow every step/);
  });

  test('all active skills together take at most a quarter of the context window', async () => {
    const alphaTokens = estimateTokens('ALPHA BODY');
    const prepared = await skillAccess.prepareActiveSkills({
      messages: [user('/alpha /gamma go')],
      app,
      user: userWith(['*']),
      contextWindow: alphaTokens / skillAccess.ACTIVE_SKILLS_CONTEXT_SHARE
    });
    assert.deepEqual(
      prepared.skills.map(skill => [skill.name, skill.full]),
      [
        ['alpha', true],
        ['gamma', false]
      ]
    );
    assert.match(prepared.text, /ALPHA BODY/);
    assert.doesNotMatch(prepared.text, /GAMMA BODY/);
  });

  test('takes its limit from platform.skills.maxSkillBodyTokens', () => {
    assert.equal(skillAccess.maxSkillBodyTokensFor({}), 5000);
    assert.equal(skillAccess.maxSkillBodyTokensFor({ skills: { maxSkillBodyTokens: 0 } }), 5000);
    assert.equal(skillAccess.maxSkillBodyTokensFor({ skills: { maxSkillBodyTokens: 800 } }), 800);
  });

  test('activate_skill does not load a skill the system prompt already has', async () => {
    const params = { user: userWith(['*']), skill_name: 'alpha' };
    const again = await runTool('activate_skill', {
      ...params,
      appConfig: { ...app, _activeSkills: [{ name: 'alpha', full: true }] }
    });
    assert.match(again, /already active/);
    assert.doesNotMatch(again, /ALPHA BODY/);
    const deferred = await runTool('activate_skill', {
      ...params,
      appConfig: { ...app, _activeSkills: [{ name: 'alpha', full: false }] }
    });
    assert.match(deferred, /ALPHA BODY/);
  });
});

describe('activation records', () => {
  test('the run state keeps the skill id of an activation', () => {
    const runId = 'run-1';
    const state = reduceRunEvents(createStreamState(), [
      { v: 2, type: 'run/started', runId, seq: 1, ts: 1, data: { kind: 'chat' } },
      {
        v: 2,
        type: 'tool/progress',
        runId,
        seq: 2,
        ts: 2,
        data: {
          phase: 'skill.activation',
          message: 'My skill',
          data: { skillName: 'My skill', skillId: 'usk_1', description: 'Mine' }
        }
      }
    ]);
    assert.deepEqual(state.runs[runId].skills, [
      { name: 'My skill', description: 'Mine', id: 'usk_1' }
    ]);
  });

  test('the stored answer keeps it', () => {
    const stored = boundStoredActivity({
      activeSkills: [
        { name: 'My skill', description: 'Mine', id: 'usk_1' },
        { name: 'alpha', description: '' }
      ]
    });
    assert.deepEqual(stored.activeSkills, [
      { name: 'My skill', description: 'Mine', id: 'usk_1' },
      { name: 'alpha', description: '' }
    ]);
  });

  test("a stored chat hands the answers' skills to the next turn", () => {
    const history = historyForPrompt([
      { role: 'user', content: 'hi', id: 'm1' },
      { role: 'assistant', content: 'ok', activity: { activeSkills: [{ name: 'a', id: 'a' }] } },
      { role: 'assistant', content: 'plain', activity: { toolActivity: {} } }
    ]);
    assert.deepEqual(history, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok', activeSkills: [{ name: 'a', id: 'a' }] },
      { role: 'assistant', content: 'plain' }
    ]);
  });

  test('a turn announces the skills it activates, not the ones carried over', () => {
    assert.deepEqual(
      announcedSkills([
        { name: 'usk_1', displayName: 'Mine', description: 'd', origin: 'message' },
        { name: 'alpha', displayName: 'alpha', description: '', origin: 'chat' }
      ]),
      [{ skillName: 'Mine', skillId: 'usk_1', description: 'd' }]
    );
  });
});

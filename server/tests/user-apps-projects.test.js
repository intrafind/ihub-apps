// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The projects a personal app links (design 07, section 2.4), against real projects.
 *
 * The rule: a personal app never gives anyone access to a project. A project is
 * in the scope of a chat only when the owner and the person chatting may each
 * use it in their own right. Pinned here, with the repository, the project
 * permissions and `resolveProjectScope` as the chat uses them:
 *
 *  - a member of the project gets its documents through the app, someone who is
 *    not a member gets nothing, and the app does not say whose project it is;
 *  - an owner who lost the project takes it away from everyone;
 *  - an admin project that is not available to someone stays out of reach: the
 *    personal app is not in the app cache, so it is no "link" that grants it;
 *  - the feature `userProjects` off darkens linked user projects too;
 *  - a chat of a personal app runs in no container project, attaches none, and
 *    the instructions of a linked project do not reach the prompt;
 *  - the same project in an ordinary company app still brings its instructions
 *    and its container, so the rule is the personal app's own.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, getStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { enhanceUserWithPermissions, resolveGroupInheritance } from '../utils/authorization.js';
import { locateConfigFile } from '../utils/configFileLocation.js';
import { ProjectRepository } from '../services/projects/ProjectRepository.js';
import configStore from '../services/config/ConfigStore.js';
import installedIntegrationService from '../services/integrations/InstalledIntegrationService.js';
import { reviseApp } from '../services/appRevision.js';
import { resolveProjectScope } from '../services/knowledge/ProjectScope.js';
import { effectiveUserApp } from '../services/userApps/ceiling.js';
import { takeOverPreview } from '../services/userApps/publishUserApp.js';
import { userAppCatalog } from '../services/userApps/userAppResolution.js';
import { projectAccessFor, linkedProjectIdsOf } from '../services/userApps/userAppProjects.js';
import { userAppSettings } from '../services/userApps/userAppSettings.js';

const person = (id, name) => ({
  id,
  name,
  username: id,
  groups: ['authenticated'],
  authMode: 'local',
  active: true
});
const ANNA = person('user-anna', 'Anna');
const BEN = person('user-ben', 'Ben');
const CARL = person('user-carl', 'Carl');
const APP_ID = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';
const SECRET_INSTRUCTIONS = 'INSTRUCTIONS-ONLY-THE-PROJECT-TEAM-WROTE';

let scratch;
let repo;
let privateProject;
let sharedProject;

/** The settings of an installation that allows linked projects. */
const settings = userAppSettings({ userApps: { capabilities: { projects: true } } });

const record = (projects, extra = {}) => ({
  id: APP_ID,
  owner: { id: ANNA.id },
  ownerPrincipal: { userId: ANNA.id, authMode: 'local', groups: ['authenticated'], recorded: true },
  ownerPrincipalAt: new Date().toISOString(),
  content: {
    name: { en: 'Handbook helper' },
    description: { en: 'Answers from the handbook' },
    system: { en: 'You answer from the handbook.' },
    capabilities: {
      upload: false,
      webSearch: false,
      skills: false,
      integrations: [],
      projects: projects.map(id => ({ id }))
    },
    ...extra
  }
});

/** The app object of a chat: what the ceiling grants this runner, with the lookup of the projects. */
async function appFor(runner, projects, { owner = ANNA, features } = {}) {
  const content = record(projects).content;
  const access = await projectAccessFor(linkedProjectIdsOf(content), { owner, runner });
  const catalog = {
    models: [],
    installations: [],
    features: { skills: true, integrations: true, projects: true, userProjects: true, ...features },
    webSearch: { owner: false, runner: false },
    skills: { owner: [], runner: [] },
    projects: access
  };
  return effectiveUserApp(record(projects), { runner, owner, settings, catalog, now: Date.now() });
}

const idsOf = scope => scope.map(entry => entry.project.id);

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-user-app-projects-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const users = Object.fromEntries([ANNA, BEN, CARL].map(user => [user.id, user]));
  const usersFile = path.join(scratch, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  configCache.setCacheEntry('config/platform.json', {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    anonymousAuth: { enabled: false }
  });
  configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          permissions: {
            apps: ['*'],
            models: ['*'],
            projects: true,
            projectSharing: true,
            userApps: true
          }
        },
        anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: [] } }
      }
    })
  );
  // A company app that links the admin project `faq`: the one place that makes it reachable.
  configCache.setCacheEntry('config/apps.json', [
    { id: 'chat', name: { en: 'Chat' }, enabled: true },
    { id: 'faq-bot', name: { en: 'FAQ bot' }, enabled: true, projects: ['faq'] }
  ]);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/agents.json', []);
  configCache.setCacheEntry('config/models.json', [
    {
      id: 'big-model',
      name: { en: 'Big model' },
      provider: 'openai',
      modelId: 'big-1',
      default: true,
      enabled: true
    }
  ]);
  configCache.setCacheEntry('config/projects.json', [
    { id: 'faq', name: { en: 'FAQ' }, enabled: true, items: [] },
    { id: 'hr-only', name: { en: 'HR' }, enabled: true, items: [] }
  ]);

  // The people as a request has them: with the permissions their groups grant.
  for (const user of [ANNA, BEN, CARL]) {
    Object.assign(user, enhanceUserWithPermissions(user, {}, configCache.getPlatform()));
  }

  // The admin projects are files of the configuration store: two of them, read by ID.
  const adminProjects = {
    faq: { id: 'faq', ownership: 'admin', name: { en: 'FAQ' }, enabled: true, items: [] },
    'hr-only': { id: 'hr-only', ownership: 'admin', name: { en: 'HR' }, enabled: true, items: [] }
  };
  const readJson = configStore.readJson.bind(configStore);
  mock.method(configStore, 'readJson', async (relative, ...rest) => {
    const match = /^projects\/([^/]+)\.json$/.exec(String(relative));
    if (match && adminProjects[match[1]]) return structuredClone(adminProjects[match[1]]);
    return readJson(relative, ...rest);
  });

  const provider = getStorage();
  repo = new ProjectRepository({
    documents: provider.documents,
    blobs: provider.blobs,
    locks: provider.locks
  });
  privateProject = await repo.createUser({
    owner: ANNA,
    content: { name: 'Private notes', instructions: SECRET_INSTRUCTIONS }
  });
  sharedProject = await repo.createUser({
    owner: ANNA,
    content: { name: 'Team handbook', instructions: SECRET_INSTRUCTIONS }
  });
  // Shared the way the members route does: the list on the document and the markers that index it.
  ({ project: sharedProject } = await repo.setMembers(
    sharedProject.id,
    [{ type: 'user', id: BEN.id, name: BEN.name, role: 'user' }],
    { actor: ANNA }
  ));
});

after(async () => {
  mock.restoreAll();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('who may use a linked project', () => {
  it('looks up the owner and the runner each in their own right', async () => {
    const access = await projectAccessFor([privateProject.id, sharedProject.id, 'nope'], {
      owner: ANNA,
      runner: BEN
    });
    assert.deepEqual(access[privateProject.id], {
      exists: true,
      ownership: 'user',
      name: 'Private notes',
      owner: true,
      runner: false
    });
    assert.deepEqual(access[sharedProject.id], {
      exists: true,
      ownership: 'user',
      name: 'Team handbook',
      owner: true,
      runner: true
    });
    assert.deepEqual(access.nope, {
      exists: false,
      ownership: null,
      name: '',
      owner: false,
      runner: false
    });
  });

  it('knows no owner as an owner who may use nothing', async () => {
    const access = await projectAccessFor([sharedProject.id], { owner: null, runner: BEN });
    assert.deepEqual(
      [access[sharedProject.id].owner, access[sharedProject.id].runner],
      [false, true]
    );
  });

  it('reads the linked IDs of a content object, each once', () => {
    assert.deepEqual(
      linkedProjectIdsOf({
        capabilities: { projects: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, {}] }
      }),
      ['a', 'b']
    );
    assert.deepEqual(linkedProjectIdsOf({}), []);
  });
});

describe('the catalog a publication is computed from', () => {
  it('holds the access to the projects the app links, for the owner and the admin', async () => {
    const catalog = await userAppCatalog({
      owner: ANNA,
      runner: ANNA,
      content: record(['faq']).content
    });
    assert.deepEqual(Object.keys(catalog.projects), ['faq']);
    // Without the content of the app the lookup has nothing to look up.
    const empty = await userAppCatalog({ owner: ANNA, runner: ANNA });
    assert.deepEqual(Object.keys(empty.projects), []);
  });

  it('keeps a link both may use in the preview of a take-over, and drops one that is gone', async () => {
    const preview = await takeOverPreview(record(['faq', 'no-such-project']), {
      admin: ANNA,
      settings
    });
    const byId = Object.fromEntries(
      [...preview.capabilities, ...preview.dropped].map(entry => [entry.id, entry])
    );
    assert.ok(byId['project:faq'], JSON.stringify(preview));
    assert.equal(
      preview.dropped.some(entry => entry.id === 'project:faq'),
      false,
      'a project both may use is not dropped'
    );
    assert.ok(
      preview.dropped.some(entry => entry.id === 'project:no-such-project'),
      'a project that does not exist is dropped'
    );
  });
});

describe('what a chat of the app reaches', () => {
  it('brings the documents of a project to a member, and not to someone who is not one', async () => {
    const forBen = await appFor(BEN, [privateProject.id, sharedProject.id]);
    // The ceiling already leaves out the project Ben may not use.
    assert.deepEqual(forBen.app.projects, [sharedProject.id]);
    const scope = await resolveProjectScope({ appConfig: forBen.app, user: BEN });
    assert.deepEqual(idsOf(scope), [sharedProject.id]);

    const forCarl = await appFor(CARL, [privateProject.id, sharedProject.id]);
    assert.equal(Object.hasOwn(forCarl.app, 'projects'), false);
    assert.deepEqual(await resolveProjectScope({ appConfig: forCarl.app, user: CARL }), []);
  });

  it('holds back, at the scope itself, a project the runner may not use, even if the app object names it', async () => {
    // The ceiling is the first line; the scope checks the person chatting on every request too.
    const scope = await resolveProjectScope({
      appConfig: { id: APP_ID, projects: [privateProject.id], features: { projects: true } },
      user: BEN
    });
    assert.deepEqual(scope, []);
  });

  it('takes the project away from everyone when the owner lost it', async () => {
    const stranger = person('user-stranger', 'Stranger');
    const forBen = await appFor(BEN, [sharedProject.id], { owner: stranger });
    assert.equal(Object.hasOwn(forBen.app, 'projects'), false);
    const reason = forBen.capabilities.find(entry => entry.id === `project:${sharedProject.id}`);
    assert.equal(reason.reason, 'ownerMayNot');
  });

  it('gives the owner their own chat', async () => {
    const own = await appFor(ANNA, [privateProject.id]);
    const scope = await resolveProjectScope({ appConfig: own.app, user: ANNA });
    assert.deepEqual(idsOf(scope), [privateProject.id]);
    assert.equal(scope[0].origin, 'app');
  });

  it('does not let the app give an admin project to someone who cannot reach it', async () => {
    // `faq` is linked by the company app `faq-bot`, which every signed-in user may use: reachable.
    // `hr-only` is linked by nothing: nobody reaches it through a personal app that names it.
    const forBen = await appFor(BEN, ['faq', 'hr-only'], { owner: ANNA });
    assert.deepEqual(forBen.app.projects, ['faq']);
    const scope = await resolveProjectScope({ appConfig: forBen.app, user: BEN });
    assert.deepEqual(idsOf(scope), ['faq']);
    const unreachable = forBen.capabilities.find(entry => entry.id === 'project:hr-only');
    assert.equal(unreachable.granted, false);
  });

  it('is dark while user projects are off, links included', async () => {
    configCache.setCacheEntry('config/features.json', { projects: true, userProjects: false });
    try {
      const forBen = await appFor(BEN, [sharedProject.id], {
        features: { userProjects: false }
      });
      assert.equal(Object.hasOwn(forBen.app, 'projects'), false);
      // Even an app object that names the project reaches nothing of it.
      const scope = await resolveProjectScope({
        appConfig: { id: APP_ID, projects: [sharedProject.id], features: { projects: true } },
        user: BEN
      });
      assert.deepEqual(scope, []);
    } finally {
      configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
    }
  });

  it('is dark when the projects feature is off', async () => {
    configCache.setCacheEntry('config/features.json', { projects: false });
    try {
      const scope = await resolveProjectScope({
        appConfig: { id: APP_ID, projects: [sharedProject.id], features: { projects: true } },
        user: BEN
      });
      assert.deepEqual(scope, []);
    } finally {
      configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
    }
  });
});

describe('what a chat of a personal app does not reach', () => {
  const personalApp = extra => ({
    id: APP_ID,
    features: { projects: true, userProjects: false },
    projects: [sharedProject.id],
    ...extra
  });

  it('runs in no container project and attaches none', async () => {
    const scope = await resolveProjectScope({
      appConfig: personalApp({
        _projectId: sharedProject.id,
        _attachedProjectIds: [sharedProject.id, privateProject.id]
      }),
      user: BEN
    });
    assert.deepEqual(
      scope.map(entry => [entry.project.id, entry.origin]),
      [[sharedProject.id, 'app']]
    );
    // Container and attachments alone bring nothing to a personal app.
    const only = await resolveProjectScope({
      appConfig: {
        id: APP_ID,
        features: { projects: true, userProjects: false },
        _projectId: sharedProject.id
      },
      user: BEN
    });
    assert.deepEqual(only, []);
  });

  it('never carries the instructions of a linked project into the prompt', async () => {
    const scope = await resolveProjectScope({ appConfig: personalApp(), user: BEN });
    assert.equal(scope.length, 1);
    assert.equal(scope[0].instructions, false);
  });

  it('never lets a link write into a project', async () => {
    const scope = await resolveProjectScope({
      appConfig: personalApp({ projects: [{ id: sharedProject.id, write: true }] }),
      user: ANNA
    });
    assert.equal(scope[0].write, false);
  });

  it('is the rule of personal apps only: a company app keeps instructions and container', async () => {
    const company = {
      id: 'chat',
      projects: [sharedProject.id],
      _projectId: sharedProject.id
    };
    const scope = await resolveProjectScope({ appConfig: company, user: BEN });
    assert.deepEqual(
      scope.map(entry => [entry.origin, entry.instructions]),
      [
        ['container', true]
        // The container and the link name the same project: it is in the scope once, first.
      ]
    );
    // A company app also needs user projects switched on at the app, which a personal app does not.
    const dark = await resolveProjectScope({
      appConfig: { id: 'chat', projects: [sharedProject.id], features: { userProjects: false } },
      user: BEN
    });
    assert.deepEqual(dark, []);
  });
});

describe('the builder proposes projects, and the ceiling filters them', () => {
  const llm = { calls: [], settings: null };
  const llmClient = {
    complete: async params => {
      llm.calls.push(params);
      return {
        content: JSON.stringify({
          reply: 'change',
          text: 'I linked the handbook.',
          change: { settings: llm.settings }
        }),
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
      };
    }
  };
  const draft = () => ({
    name: { en: 'Handbook helper' },
    description: { en: 'Answers from the handbook' },
    system: { en: 'You answer from the handbook.' },
    capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
  });
  const revise = (user, { policy = settings, draftOf = draft() } = {}) =>
    reviseApp({
      draft: draftOf,
      conversation: [{ role: 'author', text: 'Answer from the team handbook' }],
      language: 'en',
      user,
      llmClient,
      personal: { settings: policy }
    });
  const systemOf = call => call.messages.find(message => message.role === 'system').content;

  before(() => {
    mock.method(installedIntegrationService, 'resolveAllEnabled', async () => []);
  });

  it('lists the projects the caller may use, and only those', async () => {
    llm.calls = [];
    llm.settings = {};
    await revise(BEN);
    const system = systemOf(llm.calls[0]);
    assert.match(system, /- "projects" \(confirm\)/);
    assert.ok(system.includes(`- ${sharedProject.id} (Team handbook)`));
    // Anna's private project is Anna's: Ben is told nothing of it.
    assert.equal(system.includes(privateProject.id), false);
    assert.equal(system.includes('Private notes'), false);
  });

  it('offers a link only for a project the caller may use, and shortens a list to those', async () => {
    llm.calls = [];
    llm.settings = {
      projects: [{ id: sharedProject.id }, { id: privateProject.id }, { id: 'nope' }]
    };
    const turn = await revise(BEN);
    assert.deepEqual(turn.suggestions.settings, [
      { key: 'projects', value: [{ id: sharedProject.id }] }
    ]);
    assert.deepEqual(turn.patch, {});
  });

  it("drops the proposal when none of the projects is the caller's to use", async () => {
    llm.settings = { projects: [{ id: privateProject.id }] };
    const turn = await revise(BEN);
    assert.deepEqual(turn.suggestions.settings, []);
    assert.equal(turn.reply, 'message');
  });

  it('offers none while the administrator has not switched linked projects on', async () => {
    llm.calls = [];
    llm.settings = { projects: [{ id: sharedProject.id }] };
    const off = userAppSettings({ userApps: { capabilities: { projects: false } } });
    const turn = await revise(BEN, { policy: off });
    assert.equal(systemOf(llm.calls[0]).includes('"projects"'), false);
    assert.deepEqual(turn.suggestions.settings, []);
  });

  it('offers none while the feature of projects is off', async () => {
    configCache.setCacheEntry('config/features.json', { projects: false });
    try {
      llm.calls = [];
      llm.settings = { projects: [{ id: sharedProject.id }] };
      const turn = await revise(BEN);
      assert.equal(systemOf(llm.calls[0]).includes('AVAILABLE_PROJECTS'), false);
      assert.deepEqual(turn.suggestions.settings, []);
    } finally {
      configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
    }
  });
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The capability ceiling of personal apps (feature `userApps`, design
 * section 6): a personal app never does more than its owner may do and never
 * more than the person chatting may do.
 *
 * `effectiveUserApp` and `checkCapabilitiesForSave` are pure, so everything
 * here runs on plain objects: principals with resolved permissions, the
 * settings block and the catalog the caller would have looked up.
 *
 * Pinned here:
 *
 *  - the table of 6.3 as a matrix: capability x installation setting x owner
 *    right x runner right x owner state, one assertion per cell;
 *  - the run object has exactly the keys of `USER_APP_RUN_KEYS`, whatever a
 *    record carries, and passes `appConfigSchema`;
 *  - approval is `writes` for the owner and `always` for everyone else, and
 *    only the owner can allow a tool for the chat;
 *  - native web search is always off;
 *  - an owner from an identity provider with an old snapshot is stale;
 *  - a save is refused for what the actor or the owner may not use.
 *
 * Run: node --test server/tests/user-apps-ceiling.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_REASONS,
  USER_APP_CAPABILITY_IDS,
  checkCapabilitiesForSave,
  effectiveUserApp,
  integrationCapabilityId,
  removesCapabilitiesOnly
} from '../services/userApps/ceiling.js';
import { userAppSettings } from '../services/userApps/userAppSettings.js';
import { filterModelsForApp } from '../services/chat/RequestBuilder.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import {
  NO_MODEL_AVAILABLE_ID,
  PERSONAL_UPLOAD_OFF,
  PERSONAL_UPLOAD_ON,
  USER_APP_RUN_KEYS,
  USER_APP_SCHEMA_DEFAULTS,
  personalAppBase
} from '../../shared/userAppContent.js';

const APP_ID = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';
const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const MODEL = 'model-a';
const INSTALLATION = 'jira';
const PROJECT = 'prj_handbook';

/** A principal with resolved permissions. */
function principal(id, { models = ['*'], integrations = ['*'], authMode = 'local' } = {}) {
  return {
    id,
    name: id,
    groups: ['users'],
    authMode,
    permissions: {
      apps: new Set(['*']),
      models: new Set(models),
      integrations: new Set(integrations),
      userApps: true,
      userAppSharing: true
    }
  };
}

/** The settings block with everything on, or with single keys changed. */
function settingsWith(capabilities = {}, limits = {}) {
  return userAppSettings({
    userApps: {
      limits,
      capabilities: {
        modelChoice: true,
        upload: true,
        webSearch: true,
        skills: true,
        projects: true,
        integrations: [{ id: INSTALLATION, actions: ['search', 'read'] }],
        ...capabilities
      }
    }
  });
}

function catalogWith({ webSearch = { owner: true, runner: true }, skills, ...rest } = {}) {
  return {
    models: [
      { id: MODEL, enabled: true, modelType: 'chat' },
      { id: 'model-off', enabled: false, modelType: 'chat' },
      { id: 'model-audio', enabled: true, modelType: 'transcription' }
    ],
    installations: [
      { id: INSTALLATION, definition: 'jira', enabled: true },
      { id: 'wiki', definition: 'confluence', enabled: false }
    ],
    features: { skills: true, integrations: true, projects: true, userProjects: true },
    projects: {
      [PROJECT]: { exists: true, ownership: 'user', name: 'Handbook', owner: true, runner: true }
    },
    webSearch,
    skills: skills || {
      owner: ['write-well', 'only-owner'],
      runner: ['write-well', 'only-runner']
    },
    ...rest
  };
}

/** A stored record that asks for everything. */
function recordWith(content = {}, fields = {}) {
  return {
    version: 1,
    id: APP_ID,
    ownership: 'user',
    owner: { id: 'anna', name: 'Anna Schmidt' },
    ownerPrincipal: { userId: 'anna', authMode: 'local', groups: ['users'], recorded: true },
    ownerPrincipalAt: new Date(NOW).toISOString(),
    members: [],
    language: 'en',
    origin: 'blank',
    state: 'active',
    revision: 3,
    content: {
      name: { en: 'Job ad writer' },
      description: { en: 'Drafts a job ad' },
      system: { en: 'You write job ads.' },
      icon: 'document-text',
      color: '#4F46E5',
      prompt: { en: 'Role: {{role}}\n{{content}}' },
      messagePlaceholder: { en: 'Your notes' },
      variables: [{ name: 'role', label: { en: 'Role' }, type: 'string', required: false }],
      starterPrompts: [{ title: { en: 'Start' }, message: { en: 'Write an ad' } }],
      greeting: { en: { title: 'Job ads', subtitle: 'Tell me the role' } },
      inputMode: { type: 'multiline', rows: 8 },
      preferredOutputFormat: 'text',
      startForm: { enabled: false, submitLabel: { en: 'Write' } },
      variablesPanel: { pinned: false },
      autoStart: true,
      preferredModel: MODEL,
      capabilities: {
        upload: true,
        webSearch: true,
        skills: true,
        integrations: [{ id: INSTALLATION, actions: ['search'] }],
        models: { allowed: [MODEL], lock: true },
        webSearchSettings: { maxPageReads: 3, researchGuidance: 'Check two sources.' },
        projects: [{ id: PROJECT }]
      },
      ...content
    },
    ...fields
  };
}

const ANNA = principal('anna');
const BEN = principal('ben');

const capabilityOf = (result, id) => result.capabilities.find(entry => entry.id === id);

/**
 * Parse a run object with the app schema. The schema refuses the ID of a
 * personal app on purpose (no config app may have one), so the object is
 * parsed under an ordinary ID; every other key is checked as it is.
 */
const parseAsApp = app => appConfigSchema.parse({ ...app, id: 'uap_helper' });
const JIRA = integrationCapabilityId(INSTALLATION);

describe('the run object', () => {
  it('has exactly the keys of USER_APP_RUN_KEYS when everything is granted', () => {
    const { app } = effectiveUserApp(recordWith(), {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.deepEqual(Object.keys(app).sort(), [...USER_APP_RUN_KEYS].sort());
    assert.equal(app.id, APP_ID);
    assert.throws(() => appConfigSchema.parse(app), /reserved for personal apps/);
  });

  it('starts from personalAppBase and keeps its fixed values', () => {
    const { app } = effectiveUserApp(recordWith(), {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    const base = personalAppBase(APP_ID);
    for (const key of Object.keys(base)) {
      // The derived flag, the input line the author may change, and `features`, which the
      // granted project changes (below).
      if (key === 'allowEmptyContent' || key === 'inputMode' || key === 'features') continue;
      assert.deepEqual(app[key], base[key], key);
    }
    // The one project the app links is granted: the app uses projects, people still cannot
    // attach their own (`userProjects` stays off).
    assert.deepEqual(app.features, { projects: true, userProjects: false });
  });

  it('writes how the chat looks and starts, and keeps the microphone of the base', () => {
    const { app } = effectiveUserApp(recordWith(), {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.deepEqual(app.greeting, { en: { title: 'Job ads', subtitle: 'Tell me the role' } });
    assert.deepEqual(app.inputMode, {
      ...personalAppBase(APP_ID).inputMode,
      type: 'multiline',
      rows: 8
    });
    assert.equal(app.preferredOutputFormat, 'text');
    assert.deepEqual(app.startForm, { enabled: false, submitLabel: { en: 'Write' } });
    assert.deepEqual(app.variablesPanel, { pinned: false });
    assert.equal(app.autoStart, true);
    parseAsApp(app);
  });

  it('leaves the looks of the base alone when the author set none', () => {
    const record = recordWith();
    for (const key of [
      'greeting',
      'inputMode',
      'preferredOutputFormat',
      'startForm',
      'variablesPanel',
      'autoStart'
    ]) {
      delete record.content[key];
    }
    const { app } = effectiveUserApp(record, {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.deepEqual(app.inputMode, personalAppBase(APP_ID).inputMode);
    for (const key of ['greeting', 'preferredOutputFormat', 'startForm', 'variablesPanel']) {
      assert.equal(Object.hasOwn(app, key), false, key);
    }
    assert.equal(Object.hasOwn(app, 'autoStart'), false);
  });

  it('checks the looks again, because a record is not trusted', () => {
    const record = recordWith({
      greeting: { en: { title: 'Only a title' }, de: 'text', fr: { title: 'T', subtitle: 'S' } },
      inputMode: { type: 'banner', rows: 99 },
      preferredOutputFormat: 'html',
      startForm: { enabled: 'yes' },
      variablesPanel: { pinned: 'no' },
      autoStart: 'true'
    });
    const { app } = effectiveUserApp(record, {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.deepEqual(app.greeting, { fr: { title: 'T', subtitle: 'S' } });
    assert.deepEqual(app.inputMode, personalAppBase(APP_ID).inputMode);
    for (const key of ['preferredOutputFormat', 'startForm', 'variablesPanel', 'autoStart']) {
      assert.equal(Object.hasOwn(app, key), false, key);
    }
    parseAsApp(app);
  });

  it('derives allowEmptyContent from the message template', () => {
    const context = { runner: ANNA, owner: ANNA, settings: settingsWith(), catalog: catalogWith() };
    assert.equal(
      effectiveUserApp(recordWith(), { ...context, now: NOW }).app.allowEmptyContent,
      true
    );
    const noField = recordWith({ prompt: { en: '{{content}}' } });
    assert.equal(effectiveUserApp(noField, { ...context, now: NOW }).app.allowEmptyContent, false);
    const noTemplate = recordWith({ prompt: undefined });
    assert.equal(
      effectiveUserApp(noTemplate, { ...context, now: NOW }).app.allowEmptyContent,
      false
    );
  });

  it('ignores every key a record must not have, however hostile', () => {
    const hostile = recordWith(
      {
        type: 'iframe',
        iframeConfig: { url: 'https://evil.example', sandbox: ['allow-scripts'] },
        redirectConfig: { url: 'https://evil.example' },
        projects: ['hr-handbook'],
        apps: ['*'],
        workflows: ['payroll'],
        iassistant: { baseUrl: 'https://evil.example' },
        // `html` is not an output format a personal app may choose.
        preferredOutputFormat: 'html',
        // The keys of the app schema beside the real settings of `capabilities`: not read.
        disallowModelSelection: false,
        customResponseRenderer: 'evil',
        rendererConfig: { script: 'x' },
        outputSchema: { type: 'object' },
        toolApproval: { default: 'never' },
        allowedModels: ['*'],
        features: { projects: true, userProjects: true },
        enabled: false,
        sendChatHistory: false,
        inputMode: { type: 'multiline', rows: 99 },
        upload: { enabled: true, fileUpload: { maxFileSizeMB: 9999 } },
        websearch: { enabled: true, useNativeSearch: true, enabledByDefault: true },
        skills: ['*'],
        skillSettings: { enabled: true, autoActivate: true },
        integrations: { '*': {} },
        settings: { model: { enabled: false } },
        category: 'hr',
        variables: [
          { name: 'role', label: { en: 'Role' }, type: 'string', secret: 'x', hidden: true }
        ],
        starterPrompts: [{ title: { en: 'Start' }, message: { en: 'Go' }, autoSend: true }]
      },
      // The same keys beside `content`: the ceiling reads only `content`.
      {
        type: 'iframe',
        projects: ['hr-handbook'],
        apps: ['*'],
        toolApproval: { default: 'never' },
        preferredOutputFormat: 'html'
      }
    );
    const { app } = effectiveUserApp(hostile, {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    // Everything but the output format, which the hostile record sets to `html`.
    assert.deepEqual(
      Object.keys(app).sort(),
      USER_APP_RUN_KEYS.filter(key => key !== 'preferredOutputFormat').sort()
    );
    assert.equal(app.preferredOutputFormat, undefined);
    // `allowedModels: ['*']` beside the real keys is not read; the list is the author's own.
    assert.deepEqual(app.allowedModels, [MODEL]);
    assert.equal(app.disallowModelSelection, true);
    // The row count of 99 is dropped; the type is a valid one and stays.
    assert.equal(app.inputMode.rows, personalAppBase(APP_ID).inputMode.rows);
    assert.equal(app.type, 'chat');
    assert.equal(app.enabled, true);
    assert.equal(app.sendChatHistory, true);
    assert.deepEqual(app.toolApproval, { default: 'always', exemptInternalReads: true });
    // `features: { projects: true, userProjects: true }` of the record is not read: the app uses
    // projects because it links one that both may use, and `userProjects` is never the author's.
    assert.deepEqual(app.features, { projects: true, userProjects: false });
    assert.deepEqual(app.projects, [PROJECT]);
    assert.deepEqual(app.upload, PERSONAL_UPLOAD_ON);
    assert.deepEqual(app.variables, [{ name: 'role', label: { en: 'Role' }, type: 'string' }]);
    assert.deepEqual(app.starterPrompts, [{ title: { en: 'Start' }, message: { en: 'Go' } }]);
    assert.deepEqual(app.skills, ['write-well']);
    assert.deepEqual(Object.keys(app.integrations), [INSTALLATION]);

    // Parsed with the app schema it gains the four schema defaults and nothing else.
    const parsed = parseAsApp(app);
    const added = Object.keys(parsed).filter(key => !USER_APP_RUN_KEYS.includes(key));
    assert.deepEqual(added.sort(), Object.keys(USER_APP_SCHEMA_DEFAULTS).sort());
    for (const [key, value] of Object.entries(USER_APP_SCHEMA_DEFAULTS)) {
      assert.equal(parsed[key], value, key);
    }
  });

  it('passes appConfigSchema with nothing granted too', () => {
    const { app } = effectiveUserApp(recordWith(), {
      runner: BEN,
      owner: null,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    parseAsApp(app);
    for (const key of Object.keys(app)) assert.ok(USER_APP_RUN_KEYS.includes(key), key);
    assert.equal(app.preferredModel, undefined);
    assert.equal(app.skills, undefined);
    assert.equal(app.skillSettings, undefined);
    assert.equal(app.integrations, undefined);
    assert.deepEqual(app.upload, PERSONAL_UPLOAD_OFF);
    assert.deepEqual(app.websearch, { enabled: false });
  });

  it('never hands out the frozen upload objects themselves', () => {
    const { app } = effectiveUserApp(recordWith(), {
      runner: ANNA,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.notEqual(app.upload, PERSONAL_UPLOAD_ON);
    assert.equal(Object.isFrozen(app.upload), false);
    app.upload.fileUpload.maxFileSizeMB = 1;
    assert.equal(PERSONAL_UPLOAD_ON.fileUpload.maxFileSizeMB, 20);
  });

  it('does not return or modify the record', () => {
    const record = recordWith();
    const before = JSON.stringify(record);
    const { app } = effectiveUserApp(record, {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    app.name.en = 'changed';
    app.variables[0].name = 'changed';
    assert.equal(JSON.stringify(record), before);
    for (const key of ['owner', 'ownerPrincipal', 'members', 'content', 'revision']) {
      assert.equal(Object.hasOwn(app, key), false, key);
    }
  });
});

describe('what the app object gets (6.3, last column)', () => {
  const granted = () =>
    effectiveUserApp(recordWith(), {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    }).app;

  it("preferred model: the ID; the models are the author's own list, cut to what both may use", () => {
    assert.equal(granted().preferredModel, MODEL);
    assert.deepEqual(granted().allowedModels, [MODEL]);
    assert.equal(granted().disallowModelSelection, true);
  });

  it('upload: one of the two fixed objects', () => {
    assert.deepEqual(granted().upload, PERSONAL_UPLOAD_ON);
    const off = effectiveUserApp(recordWith(), {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith({ upload: false }),
      catalog: catalogWith(),
      now: NOW
    }).app;
    assert.deepEqual(off.upload, PERSONAL_UPLOAD_OFF);
  });

  it('web search: an installed engine, off until switched on, never native', () => {
    assert.deepEqual(granted().websearch, {
      enabled: true,
      provider: 'auto',
      enabledByDefault: false,
      useNativeSearch: false,
      maxPageReads: 3,
      researchGuidance: 'Check two sources.'
    });
    // Whoever chats: native search is off whenever web search is granted.
    for (const runner of [ANNA, BEN]) {
      const { app } = effectiveUserApp(recordWith(), {
        runner,
        owner: ANNA,
        settings: settingsWith(),
        catalog: catalogWith(),
        now: NOW
      });
      assert.equal(app.websearch.useNativeSearch, false);
      assert.equal(app.websearch.enabledByDefault, false);
    }
  });

  it('skills: only IDs granted to both, never the wildcard', () => {
    const app = granted();
    assert.deepEqual(app.skillSettings, { enabled: true, allowPersonal: true });
    assert.deepEqual(app.skills, ['write-well']);
    assert.equal(app.skills.includes('*'), false);
    assert.equal(app.skills.includes('only-owner'), false);
    assert.equal(app.skills.includes('only-runner'), false);
  });

  it('skills: for the owner, the skills the owner is granted', () => {
    const { app } = effectiveUserApp(recordWith(), {
      runner: ANNA,
      owner: ANNA,
      settings: settingsWith(),
      // A catalog built for the owner's own request names the runner only.
      catalog: catalogWith({ skills: { runner: ['write-well', 'only-owner'] } }),
      now: NOW
    });
    assert.deepEqual(app.skills, ['write-well', 'only-owner']);
  });

  it('connected system: always with named actions, off until switched on', () => {
    const app = granted();
    assert.deepEqual(app.integrations, {
      [INSTALLATION]: { actions: ['search'], required: false, enabledByDefault: false }
    });
  });

  it('every binding in the result has a non-empty actions list', () => {
    const record = recordWith({
      capabilities: {
        upload: false,
        webSearch: false,
        skills: false,
        integrations: [
          { id: INSTALLATION, actions: ['search', 'delete-everything'] },
          { id: 'wiki', actions: ['read'] },
          { id: 'unknown', actions: ['read'] },
          { id: 'no-actions', actions: [] },
          { id: 'ihub', actions: ['ask_user'] },
          { id: '*', actions: ['search'] },
          { id: 'type:jira', actions: ['search'] }
        ]
      }
    });
    const { app, capabilities } = effectiveUserApp(record, {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    // The action the admin did not list is dropped; the binding keeps the rest.
    assert.deepEqual(app.integrations, {
      [INSTALLATION]: { actions: ['search'], required: false, enabledByDefault: false }
    });
    for (const binding of Object.values(app.integrations)) {
      assert.ok(Array.isArray(binding.actions) && binding.actions.length > 0);
    }
    for (const id of ['wiki', 'unknown', 'no-actions', 'ihub']) {
      assert.deepEqual(
        capabilityOf({ capabilities }, integrationCapabilityId(id)),
        {
          id: integrationCapabilityId(id),
          requested: true,
          granted: false,
          reason: CAPABILITY_REASONS.offOnInstallation
        },
        id
      );
    }
    // A wildcard or a definition key is no binding of a personal app at all.
    assert.equal(capabilityOf({ capabilities }, 'integration:*'), undefined);
    assert.equal(capabilityOf({ capabilities }, 'integration:type:jira'), undefined);
  });

  it('a binding whose every action left the admin list is withheld', () => {
    const { app, capabilities } = effectiveUserApp(recordWith(), {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith({ integrations: [{ id: INSTALLATION, actions: ['read'] }] }),
      catalog: catalogWith(),
      now: NOW
    });
    assert.equal(app.integrations, undefined);
    assert.equal(capabilityOf({ capabilities }, JIRA).reason, CAPABILITY_REASONS.offOnInstallation);
  });

  it('no key that adds tools beyond the switches, the models and the linked projects', () => {
    const app = granted();
    for (const key of ['apps', 'workflows', 'iassistant', 'toolChoice', 'toolSearch']) {
      assert.equal(Object.hasOwn(app, key), false, key);
    }
  });
});

describe('approval (6.3)', () => {
  const context = { owner: ANNA, settings: settingsWith(), catalog: catalogWith(), now: NOW };

  it('the owner: writes ask, and a tool can be allowed for the chat', () => {
    const { app, approval } = effectiveUserApp(recordWith(), { ...context, runner: ANNA });
    assert.deepEqual(app.toolApproval, { default: 'writes', exemptInternalReads: true });
    assert.deepEqual(approval, { mode: 'writes', chatGrants: true });
  });

  it('the owner runs content an editor saved under the owner settings: nobody confirms it', () => {
    const edited = recordWith({}, { updatedBy: { id: 'carol', name: 'Carol' } });
    const { app, approval } = effectiveUserApp(edited, { ...context, runner: ANNA });
    assert.deepEqual(app.toolApproval, { default: 'writes', exemptInternalReads: true });
    assert.deepEqual(approval, { mode: 'writes', chatGrants: true });
    // A field an earlier build stored at the accept of an offer is ignored.
    const handedOver = recordWith(
      {},
      {
        updatedBy: { id: 'carol', name: 'Carol' },
        contentHash: 'h2',
        contentConfirmedBy: { id: 'anna', contentHash: 'h1' }
      }
    );
    assert.deepEqual(effectiveUserApp(handedOver, { ...context, runner: ANNA }).approval, {
      mode: 'writes',
      chatGrants: true
    });
  });

  it('everyone else: every call asks, and nothing can be allowed for the chat', () => {
    const editor = principal('carol');
    const admin = { ...principal('root'), isAdmin: true };
    for (const runner of [BEN, editor, admin]) {
      const { app, approval } = effectiveUserApp(recordWith(), { ...context, runner });
      assert.deepEqual(
        app.toolApproval,
        { default: 'always', exemptInternalReads: true },
        runner.id
      );
      assert.deepEqual(approval, { mode: 'always', chatGrants: false }, runner.id);
    }
  });

  it('who the owner is comes from the record, not from the owner argument', () => {
    // Ben passes himself as the owner: he still is not the owner of the record.
    const { approval, app } = effectiveUserApp(recordWith(), {
      ...context,
      runner: BEN,
      owner: BEN
    });
    assert.equal(approval.chatGrants, false);
    assert.equal(app.toolApproval.default, 'always');
  });

  it('the mode does not depend on what the app asks for', () => {
    const plain = recordWith({
      preferredModel: undefined,
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
    });
    assert.equal(
      effectiveUserApp(plain, { ...context, runner: BEN }).app.toolApproval.default,
      'always'
    );
    assert.equal(
      effectiveUserApp(plain, { ...context, runner: ANNA }).app.toolApproval.default,
      'writes'
    );
  });
});

describe('the matrix of 6.3', () => {
  const OWNER_STATES = ['active', 'inactive', 'stale', 'deleted'];
  const YES_NO = [true, false];

  /**
   * One cell: a capability, with the installation's setting, the owner's and
   * the runner's right and the owner's state.
   */
  function cell(capability, { setting, ownerRight, runnerRight, ownerState }) {
    const owner =
      ownerState === 'inactive' || ownerState === 'deleted'
        ? null
        : principal('anna', {
            authMode: ownerState === 'stale' ? 'oidc' : 'local',
            models: ownerRight ? ['*'] : [],
            integrations: ownerRight ? ['*'] : []
          });
    const runner = principal('ben', {
      models: runnerRight ? ['*'] : [],
      integrations: runnerRight ? ['*'] : []
    });
    const record = recordWith(
      {},
      ownerState === 'stale'
        ? {
            ownerPrincipal: { userId: 'anna', authMode: 'oidc', groups: ['users'] },
            ownerPrincipalAt: new Date(NOW - 31 * DAY).toISOString()
          }
        : {}
    );
    const settings = settingsWith({
      modelChoice: capability === 'model' ? setting : true,
      upload: capability === 'upload' ? setting : true,
      webSearch: capability === 'webSearch' ? setting : true,
      skills: capability === 'skills' ? setting : true,
      integrations:
        capability === JIRA && !setting ? [] : [{ id: INSTALLATION, actions: ['search', 'read'] }]
    });
    const catalog = catalogWith({ webSearch: { owner: ownerRight, runner: runnerRight } });
    return effectiveUserApp(record, { runner, owner, settings, catalog, now: NOW });
  }

  /** The verdict the table of 6.3 gives. `perUser`: the capability depends on a personal right. */
  function expected({ setting, ownerRight, runnerRight, ownerState }, perUser) {
    if (!setting) return CAPABILITY_REASONS.offOnInstallation;
    if (ownerState === 'inactive' || ownerState === 'deleted')
      return CAPABILITY_REASONS.ownerInactive;
    if (ownerState === 'stale') return CAPABILITY_REASONS.ownerStale;
    if (perUser && !ownerRight) return CAPABILITY_REASONS.ownerMayNot;
    if (perUser && !runnerRight) return CAPABILITY_REASONS.youMayNot;
    return null;
  }

  const CAPABILITIES = [
    { id: 'model', perUser: true, inApp: app => app.preferredModel === MODEL },
    { id: 'upload', perUser: false, inApp: app => app.upload.enabled === true },
    { id: 'webSearch', perUser: true, inApp: app => app.websearch.enabled === true },
    { id: 'skills', perUser: false, inApp: app => app.skillSettings?.enabled === true },
    { id: JIRA, perUser: true, inApp: app => Boolean(app.integrations?.[INSTALLATION]) }
  ];

  for (const capability of CAPABILITIES) {
    describe(capability.id, () => {
      for (const setting of YES_NO) {
        for (const ownerState of OWNER_STATES) {
          for (const ownerRight of YES_NO) {
            for (const runnerRight of YES_NO) {
              const input = { setting, ownerRight, runnerRight, ownerState };
              const reason = expected(input, capability.perUser);
              const name =
                `setting ${setting ? 'on' : 'off'}, owner ${ownerState}` +
                `${ownerRight ? '' : ' without the right'}, runner` +
                `${runnerRight ? ' with' : ' without'} the right: ${reason || 'granted'}`;
              it(name, () => {
                const result = cell(capability.id, input);
                const entry = capabilityOf(result, capability.id);
                assert.deepEqual(
                  entry,
                  reason
                    ? { id: capability.id, requested: true, granted: false, reason }
                    : { id: capability.id, requested: true, granted: true }
                );
                assert.equal(capability.inApp(result.app), reason === null);
              });
            }
          }
        }
      }
    });
  }

  it('lists the four switches and one entry per binding, in a fixed order', () => {
    const { capabilities } = cell('model', {
      setting: true,
      ownerRight: true,
      runnerRight: true,
      ownerState: 'active'
    });
    assert.deepEqual(
      capabilities.map(entry => entry.id),
      [...USER_APP_CAPABILITY_IDS, JIRA, `project:${PROJECT}`]
    );
  });

  it('what was not asked for is not granted, whatever the rights', () => {
    const record = recordWith({
      preferredModel: undefined,
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
    });
    const { app, capabilities } = effectiveUserApp(record, {
      runner: ANNA,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.deepEqual(
      capabilities,
      USER_APP_CAPABILITY_IDS.map(id => ({
        id,
        requested: false,
        granted: false,
        reason: CAPABILITY_REASONS.notRequested
      }))
    );
    assert.deepEqual(app.upload, PERSONAL_UPLOAD_OFF);
    assert.deepEqual(app.websearch, { enabled: false });
    assert.equal(app.skills, undefined);
    assert.equal(app.integrations, undefined);
  });
});

describe('the preferred model', () => {
  const context = { runner: BEN, owner: ANNA, settings: settingsWith(), now: NOW };

  for (const [id, why] of [
    ['model-off', 'a disabled model'],
    ['model-audio', 'a model that is no chat model'],
    ['model-gone', 'a model that does not exist']
  ]) {
    it(`${why} is dropped, and the standard model applies`, () => {
      const result = effectiveUserApp(recordWith({ preferredModel: id }), {
        ...context,
        catalog: catalogWith()
      });
      assert.equal(result.app.preferredModel, undefined);
      assert.equal(capabilityOf(result, 'model').reason, CAPABILITY_REASONS.offOnInstallation);
    });
  }

  it('a model only one of the two may use is dropped', () => {
    const onlyOther = principal('ben', { models: ['other'] });
    const result = effectiveUserApp(recordWith(), {
      ...context,
      runner: onlyOther,
      catalog: catalogWith()
    });
    assert.equal(result.app.preferredModel, undefined);
    assert.equal(capabilityOf(result, 'model').reason, CAPABILITY_REASONS.youMayNot);
  });
});

describe('the models of an app (design 07, section 2.2)', () => {
  const MODELS = [
    { id: 'model-a', enabled: true, modelType: 'chat' },
    { id: 'model-b', enabled: true, modelType: 'chat' },
    { id: 'model-c', enabled: true, modelType: 'chat' },
    { id: 'model-off', enabled: false, modelType: 'chat' }
  ];
  const asking = (models, extra = {}) =>
    recordWith({
      preferredModel: undefined,
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [], models },
      ...extra
    });
  const run = (record, { runner = BEN, owner = ANNA, settings = settingsWith() } = {}) =>
    effectiveUserApp(record, {
      runner,
      owner,
      settings,
      catalog: catalogWith({ models: MODELS }),
      now: NOW
    });
  const entry = (result, id) => result.capabilities.find(capability => capability.id === id);

  it('narrows the chat to the list, cut to the models the owner and the runner both may use', () => {
    const result = run(
      asking({ allowed: ['model-a', 'model-b', 'model-c', 'model-off', 'nope'] }),
      {
        owner: principal('anna', { models: ['model-a', 'model-b'] }),
        runner: principal('ben', { models: ['model-b', 'model-c'] })
      }
    );
    assert.deepEqual(result.app.allowedModels, ['model-b']);
    assert.equal(result.app.disallowModelSelection, undefined);
    assert.deepEqual(entry(result, 'models'), { id: 'models', requested: true, granted: true });
  });

  it('stops the chat when none is left for the runner, and says it is the runner', () => {
    const result = run(asking({ allowed: ['model-a'] }), {
      owner: principal('anna'),
      runner: principal('ben', { models: ['model-b'] })
    });
    // No model has this ID, so `RequestBuilder` answers `noCompatibleModels`: the restriction is
    // not dropped, because that would give the runner a model the author excluded.
    assert.deepEqual(result.app.allowedModels, [NO_MODEL_AVAILABLE_ID]);
    assert.deepEqual(entry(result, 'models'), {
      id: 'models',
      requested: true,
      granted: false,
      reason: CAPABILITY_REASONS.youMayNot
    });
  });

  it('stops the chat when the owner may use none of them, and says it is the owner', () => {
    const result = run(asking({ allowed: ['model-a'] }), {
      owner: principal('anna', { models: ['model-b'] }),
      runner: BEN
    });
    assert.deepEqual(result.app.allowedModels, [NO_MODEL_AVAILABLE_ID]);
    assert.equal(entry(result, 'models').reason, CAPABILITY_REASONS.ownerMayNot);
  });

  it('locks the choice to the preferred model, which the list names', () => {
    const result = run(
      asking({ allowed: ['model-a', 'model-b'], lock: true }, { preferredModel: 'model-b' })
    );
    assert.equal(result.app.preferredModel, 'model-b');
    assert.equal(result.app.disallowModelSelection, true);
    assert.deepEqual(result.app.allowedModels, ['model-b']);
  });

  it('writes the models of a list as they are configured, once each', () => {
    const result = run(asking({ allowed: ['MODEL-B', 'model-b', 'Model-A'] }));
    assert.deepEqual(result.app.allowedModels, ['model-b', 'model-a']);
  });

  it('names the preferred model of a lock in any letter case', () => {
    const result = run(asking({ allowed: ['MODEL-B'], lock: true }, { preferredModel: 'model-b' }));
    assert.equal(result.app.preferredModel, 'model-b');
    assert.deepEqual(result.app.allowedModels, ['model-b']);
  });

  it('stops the chat when a locked model is one the runner may not use', () => {
    const result = run(asking({ lock: true }, { preferredModel: 'model-a' }), {
      owner: ANNA,
      runner: principal('ben', { models: ['model-b'] })
    });
    assert.deepEqual(result.app.allowedModels, [NO_MODEL_AVAILABLE_ID]);
    assert.equal(result.app.disallowModelSelection, undefined);
    assert.equal(entry(result, 'models').reason, CAPABILITY_REASONS.youMayNot);
  });

  it('stops the chat when the lock has no preferred model, or one outside the list', () => {
    assert.deepEqual(run(asking({ lock: true })).app.allowedModels, [NO_MODEL_AVAILABLE_ID]);
    const outside = run(
      asking({ allowed: ['model-a'], lock: true }, { preferredModel: 'model-b' })
    );
    assert.deepEqual(outside.app.allowedModels, [NO_MODEL_AVAILABLE_ID]);
  });

  it('leaves the chat of the app no model to pick, as the request builder reads allowedModels', () => {
    const models = [
      { id: 'model-a', modelType: 'chat' },
      { id: 'model-b', modelType: 'chat' }
    ];
    const narrowed = run(asking({ allowed: ['model-a', 'model-b'] }), {
      owner: ANNA,
      runner: principal('ben', { models: ['model-b'] })
    }).app;
    // The list is cut to the models both may use; the request builder cuts it again to the
    // models of the person chatting.
    assert.deepEqual(
      filterModelsForApp(models, narrowed).map(model => model.id),
      ['model-b']
    );
    const refused = run(asking({ allowed: ['model-a'] }), {
      owner: ANNA,
      runner: principal('ben', { models: ['model-b'] })
    }).app;
    assert.deepEqual(filterModelsForApp(models, refused), []);
    // An app without a restriction leaves every model.
    assert.equal(filterModelsForApp(models, run(asking(undefined)).app).length, 2);
  });

  it('leaves the preferred model out when the list does not name it', () => {
    const result = run(asking({ allowed: ['model-a'] }, { preferredModel: 'model-b' }));
    assert.deepEqual(result.app.allowedModels, ['model-a']);
    assert.equal(result.app.preferredModel, undefined);
  });

  it('has no effect while the installation does not allow a choice of model', () => {
    const result = run(
      asking({ allowed: ['model-a'], lock: true }, { preferredModel: 'model-a' }),
      {
        settings: settingsWith({ modelChoice: false })
      }
    );
    for (const key of ['allowedModels', 'disallowModelSelection', 'preferredModel']) {
      assert.equal(result.app[key], undefined, key);
    }
    assert.equal(entry(result, 'models').reason, CAPABILITY_REASONS.offOnInstallation);
  });

  it('has no effect on an app that does not ask for it', () => {
    const result = run(asking(undefined));
    assert.equal(result.app.allowedModels, undefined);
    assert.equal(entry(result, 'models').reason, CAPABILITY_REASONS.notRequested);
  });

  it('is refused on a save for a person who may use none of the models', () => {
    const content = asking({ allowed: ['model-a'] }).content;
    const context = {
      actor: principal('carol', { models: ['model-b'] }),
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith({ models: MODELS })
    };
    assert.deepEqual(checkCapabilitiesForSave(content, context), [
      { capability: 'models', reason: CAPABILITY_REASONS.youMayNot }
    ]);
    assert.deepEqual(
      checkCapabilitiesForSave(content, { ...context, actor: principal('carol') }),
      []
    );
  });

  it('may stay or go in a save by an editor, but not change', () => {
    const before = asking({ allowed: ['model-a'] }).content;
    const without = { ...before, capabilities: { ...before.capabilities, models: undefined } };
    assert.equal(removesCapabilitiesOnly(before, without), true);
    assert.equal(removesCapabilitiesOnly(before, before), true);
    const changed = {
      ...before,
      capabilities: { ...before.capabilities, models: { allowed: ['model-a', 'model-b'] } }
    };
    assert.equal(removesCapabilitiesOnly(before, changed), false);
  });
});

describe('how an app researches on the web (design 07, section 2.2)', () => {
  const run = (settings, search) =>
    effectiveUserApp(
      recordWith({
        capabilities: {
          upload: false,
          webSearch: true,
          skills: false,
          integrations: [],
          webSearchSettings: search
        }
      }),
      { runner: BEN, owner: ANNA, settings, catalog: catalogWith(), now: NOW }
    ).app;

  it('sets the pages the page reader may open and the guidance, cut to the limit', () => {
    const app = run(settingsWith({ webSearchLimits: { maxPageReads: 4 } }), {
      maxPageReads: 9,
      researchGuidance: 'Check two sources.'
    });
    assert.equal(app.websearch.maxPageReads, 4);
    assert.equal(app.websearch.researchGuidance, 'Check two sources.');
    assert.equal(app.websearch.useNativeSearch, false);
  });

  it('keeps a smaller value and leaves out what is not of the right kind', () => {
    assert.equal(run(settingsWith(), { maxPageReads: 2 }).websearch.maxPageReads, 2);
    const junk = run(settingsWith(), { maxPageReads: '9', researchGuidance: '   ' }).websearch;
    assert.equal(Object.hasOwn(junk, 'maxPageReads'), false);
    assert.equal(Object.hasOwn(junk, 'researchGuidance'), false);
  });

  it('caps the platform default of pages at a limit below it, and leaves a higher limit alone', () => {
    const low = run(settingsWith({ webSearchLimits: { maxPageReads: 3 } }), {
      researchGuidance: 'Check two sources.'
    });
    assert.equal(low.websearch.maxPageReads, 3);
    const high = run(settingsWith({ webSearchLimits: { maxPageReads: 20 } }), {
      researchGuidance: 'Check two sources.'
    });
    assert.equal(Object.hasOwn(high.websearch, 'maxPageReads'), false);
  });

  it('has no effect while web search is off', () => {
    const app = run(settingsWith({ webSearch: false }), { maxPageReads: 2 });
    assert.deepEqual(app.websearch, { enabled: false });
  });
});

describe('the projects of an app (design 07, section 2.4)', () => {
  const asking = projects =>
    recordWith({
      preferredModel: undefined,
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [], projects }
    });
  const access = (entries = {}) => ({
    [PROJECT]: { exists: true, ownership: 'user', name: 'Handbook', owner: true, runner: true },
    ...entries
  });
  const run = (
    record,
    { catalog = catalogWith({ projects: access() }), settings = settingsWith(), runner = BEN } = {}
  ) => effectiveUserApp(record, { runner, owner: ANNA, settings, catalog, now: NOW });
  const entry = (result, id) => result.capabilities.find(capability => capability.id === id);
  const link = id => ({ id: `project:${id}` });

  it('links the projects both may use, and nothing else, with the picker off', () => {
    const result = run(asking([{ id: PROJECT }]));
    assert.deepEqual(result.app.projects, [PROJECT]);
    assert.deepEqual(result.app.features, { projects: true, userProjects: false });
    assert.deepEqual(entry(result, link(PROJECT).id), {
      id: link(PROJECT).id,
      requested: true,
      granted: true
    });
    // The name and the ownership go to the views and to publish, which decide who may read them.
    assert.deepEqual(
      result.bindings.find(binding => binding.id === link(PROJECT).id),
      { id: link(PROJECT).id, name: 'Handbook', ownership: 'user' }
    );
    parseAsApp(result.app);
  });

  it('gives a runner who may not use the project nothing from it, and says so', () => {
    const result = run(asking([{ id: PROJECT }]), {
      catalog: catalogWith({
        projects: access({
          [PROJECT]: { exists: true, ownership: 'user', name: 'H', owner: true, runner: false }
        })
      })
    });
    assert.equal(Object.hasOwn(result.app, 'projects'), false);
    assert.deepEqual(result.app.features, { projects: false, userProjects: false });
    assert.equal(entry(result, link(PROJECT).id).reason, CAPABILITY_REASONS.youMayNot);
  });

  it('gives nobody the project when the owner lost it', () => {
    const result = run(asking([{ id: PROJECT }]), {
      catalog: catalogWith({
        projects: access({
          [PROJECT]: { exists: true, ownership: 'user', name: 'H', owner: false, runner: true }
        })
      })
    });
    assert.equal(Object.hasOwn(result.app, 'projects'), false);
    assert.equal(entry(result, link(PROJECT).id).reason, CAPABILITY_REASONS.ownerMayNot);
  });

  it('decides each link on its own', () => {
    const result = run(asking([{ id: PROJECT }, { id: 'faq' }, { id: 'gone' }]), {
      catalog: catalogWith({
        projects: access({
          faq: { exists: true, ownership: 'admin', name: 'FAQ', owner: true, runner: true },
          gone: { exists: false, ownership: null, name: '', owner: false, runner: false }
        })
      })
    });
    assert.deepEqual(result.app.projects, [PROJECT, 'faq']);
    assert.equal(entry(result, link('gone').id).granted, false);
  });

  it('is off while the administrator did not switch it on, or the feature is off', () => {
    for (const [settings, catalog] of [
      [settingsWith({ projects: false }), catalogWith({ projects: access() })],
      [settingsWith(), catalogWith({ projects: access(), features: { projects: false } })],
      // A user project also needs the feature of user projects; an admin project does not.
      [
        settingsWith(),
        catalogWith({
          projects: access(),
          features: { projects: true, userProjects: false }
        })
      ]
    ]) {
      const result = run(asking([{ id: PROJECT }]), { settings, catalog });
      assert.equal(Object.hasOwn(result.app, 'projects'), false);
      assert.equal(entry(result, link(PROJECT).id).reason, CAPABILITY_REASONS.offOnInstallation);
    }
    const admin = run(asking([{ id: 'faq' }]), {
      catalog: catalogWith({
        projects: access({
          faq: { exists: true, ownership: 'admin', name: 'FAQ', owner: true, runner: true }
        }),
        features: { projects: true, userProjects: false }
      })
    });
    assert.deepEqual(admin.app.projects, ['faq']);
  });

  it('is withheld with everything else when the owner cannot be checked', () => {
    const result = effectiveUserApp(asking([{ id: PROJECT }]), {
      runner: BEN,
      owner: null,
      settings: settingsWith(),
      catalog: catalogWith({ projects: access() }),
      now: NOW
    });
    assert.equal(Object.hasOwn(result.app, 'projects'), false);
    assert.equal(entry(result, link(PROJECT).id).reason, CAPABILITY_REASONS.ownerInactive);
  });

  it('does not read a `projects` key or a `features` key beside the real ones', () => {
    const result = run(
      recordWith({
        projects: ['hr-handbook'],
        features: { projects: true, userProjects: true },
        capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
      })
    );
    assert.equal(Object.hasOwn(result.app, 'projects'), false);
    assert.deepEqual(result.app.features, { projects: false, userProjects: false });
  });

  it('is refused on a save for a person who may not use the project, or for a project that is gone', () => {
    const content = asking([{ id: PROJECT }]).content;
    const context = {
      actor: ANNA,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith({ projects: access() })
    };
    assert.deepEqual(checkCapabilitiesForSave(content, context), []);
    assert.deepEqual(
      checkCapabilitiesForSave(content, {
        ...context,
        catalog: catalogWith({
          projects: access({
            [PROJECT]: { exists: true, ownership: 'user', name: 'H', owner: true, runner: false }
          })
        })
      }),
      [{ capability: link(PROJECT).id, reason: CAPABILITY_REASONS.youMayNot }]
    );
    assert.deepEqual(
      checkCapabilitiesForSave(content, {
        ...context,
        catalog: catalogWith({
          projects: access({
            [PROJECT]: { exists: false, ownership: null, name: '', owner: false, runner: false }
          })
        })
      }),
      [{ capability: link(PROJECT).id, reason: CAPABILITY_REASONS.offOnInstallation }]
    );
  });

  it('may be taken away in a save by an editor, not added', () => {
    const before = asking([{ id: PROJECT }]).content;
    const without = { ...before, capabilities: { ...before.capabilities, projects: undefined } };
    assert.equal(removesCapabilitiesOnly(before, without), true);
    const more = {
      ...before,
      capabilities: { ...before.capabilities, projects: [{ id: PROJECT }, { id: 'other' }] }
    };
    assert.equal(removesCapabilitiesOnly(before, more), false);
  });
});

describe('the owner snapshot (6.2)', () => {
  const oidcRecord = ageDays =>
    recordWith(
      {},
      {
        ownerPrincipal: { userId: 'anna', authMode: 'oidc', groups: ['users'] },
        ownerPrincipalAt: new Date(NOW - ageDays * DAY).toISOString()
      }
    );
  const oidcOwner = principal('anna', { authMode: 'oidc' });

  it('an identity-provider owner with a snapshot of 31 days: everything withheld as ownerStale', () => {
    const result = effectiveUserApp(oidcRecord(31), {
      runner: BEN,
      owner: oidcOwner,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    for (const entry of result.capabilities) {
      assert.equal(entry.granted, false, entry.id);
      assert.equal(entry.reason, CAPABILITY_REASONS.ownerStale, entry.id);
    }
    // Plain chat: the texts stay, nothing else.
    assert.deepEqual(result.app.system, { en: 'You write job ads.' });
    assert.deepEqual(result.app.upload, PERSONAL_UPLOAD_OFF);
    assert.deepEqual(result.app.websearch, { enabled: false });
    assert.equal(result.app.preferredModel, undefined);
    assert.equal(result.app.integrations, undefined);
    assert.equal(result.app.skills, undefined);
  });

  it('30 days is not stale yet', () => {
    const result = effectiveUserApp(oidcRecord(30), {
      runner: BEN,
      owner: oidcOwner,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.ok(result.capabilities.every(entry => entry.granted));
  });

  it('a snapshot of today with changed groups: the ceiling follows the new groups', () => {
    // The owner principal is rebuilt from the snapshot; today it grants no model.
    const narrowed = principal('anna', { authMode: 'oidc', models: [] });
    const result = effectiveUserApp(oidcRecord(0), {
      runner: BEN,
      owner: narrowed,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.equal(capabilityOf(result, 'model').reason, CAPABILITY_REASONS.ownerMayNot);
    assert.equal(capabilityOf(result, 'upload').granted, true);
  });

  it('a local owner is never stale', () => {
    const old = recordWith({}, { ownerPrincipalAt: new Date(NOW - 400 * DAY).toISOString() });
    const result = effectiveUserApp(old, {
      runner: BEN,
      owner: ANNA,
      settings: settingsWith(),
      catalog: catalogWith(),
      now: NOW
    });
    assert.ok(result.capabilities.every(entry => entry.granted));
  });

  it('ownerSnapshotMaxAgeDays of 0 never distrusts a snapshot', () => {
    const result = effectiveUserApp(oidcRecord(4000), {
      runner: BEN,
      owner: oidcOwner,
      settings: settingsWith({}, { ownerSnapshotMaxAgeDays: 0 }),
      catalog: catalogWith(),
      now: NOW
    });
    assert.ok(result.capabilities.every(entry => entry.granted));
  });

  it('the owner chatting is never stale and never inactive: the request is the owner', () => {
    const result = effectiveUserApp(oidcRecord(400), {
      runner: oidcOwner,
      owner: null,
      settings: settingsWith(),
      catalog: catalogWith({ webSearch: { runner: true }, skills: { runner: ['write-well'] } }),
      now: NOW
    });
    assert.ok(result.capabilities.every(entry => entry.granted));
  });
});

describe('checkCapabilitiesForSave', () => {
  const content = recordWith().content;
  const context = { actor: ANNA, owner: ANNA, settings: settingsWith(), catalog: catalogWith() };

  it('accepts what the installation, the owner and the actor allow', () => {
    assert.deepEqual(checkCapabilitiesForSave(content, context), []);
  });

  it('accepts an app that asks for nothing, with everything switched off', () => {
    const plain = {
      ...content,
      preferredModel: undefined,
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
    };
    assert.deepEqual(
      checkCapabilitiesForSave(plain, {
        ...context,
        settings: settingsWith({
          modelChoice: false,
          upload: false,
          webSearch: false,
          skills: false,
          integrations: []
        })
      }),
      []
    );
  });

  it('names every capability the installation does not offer', () => {
    const denied = checkCapabilitiesForSave(content, {
      ...context,
      settings: settingsWith({
        modelChoice: false,
        upload: false,
        webSearch: false,
        skills: false,
        integrations: []
      })
    });
    assert.deepEqual(
      denied,
      ['model', 'models', 'upload', 'webSearch', 'skills', JIRA].map(capability => ({
        capability,
        reason: CAPABILITY_REASONS.offOnInstallation
      }))
    );
  });

  it('an action the admin did not list refuses the save', () => {
    const withExtra = {
      ...content,
      capabilities: {
        ...content.capabilities,
        integrations: [{ id: INSTALLATION, actions: ['search', 'delete-everything'] }]
      }
    };
    assert.deepEqual(checkCapabilitiesForSave(withExtra, context), [
      { capability: JIRA, reason: CAPABILITY_REASONS.offOnInstallation }
    ]);
  });

  it('an editor who may not use what the app uses is refused with youMayNot', () => {
    const editor = principal('carol', { models: [], integrations: [] });
    const denied = checkCapabilitiesForSave(content, {
      ...context,
      actor: editor,
      catalog: catalogWith({ webSearch: { owner: true, runner: false } })
    });
    assert.deepEqual(denied, [
      { capability: 'model', reason: CAPABILITY_REASONS.youMayNot },
      { capability: 'models', reason: CAPABILITY_REASONS.youMayNot },
      { capability: 'webSearch', reason: CAPABILITY_REASONS.youMayNot },
      { capability: JIRA, reason: CAPABILITY_REASONS.youMayNot }
    ]);
  });

  it('an editor cannot add what the owner may not use', () => {
    const owner = principal('anna', { models: [], integrations: [] });
    const denied = checkCapabilitiesForSave(content, {
      ...context,
      actor: principal('carol'),
      owner,
      catalog: catalogWith({ webSearch: { owner: false, runner: true } })
    });
    assert.deepEqual(
      denied.map(entry => entry.reason),
      [
        CAPABILITY_REASONS.ownerMayNot,
        CAPABILITY_REASONS.ownerMayNot,
        CAPABILITY_REASONS.ownerMayNot,
        CAPABILITY_REASONS.ownerMayNot
      ]
    );
  });

  it('with no owner principal every requested capability is refused', () => {
    const denied = checkCapabilitiesForSave(content, { ...context, actor: BEN, owner: null });
    assert.deepEqual(
      denied.map(entry => entry.capability),
      ['model', 'models', 'upload', 'webSearch', 'skills', JIRA, `project:${PROJECT}`]
    );
    assert.ok(denied.every(entry => entry.reason === CAPABILITY_REASONS.ownerInactive));
  });
});

describe('removesCapabilitiesOnly', () => {
  const before = recordWith().content;

  it('is true for a save that only takes capabilities away', () => {
    assert.equal(
      removesCapabilitiesOnly(before, {
        ...before,
        preferredModel: undefined,
        capabilities: { upload: true, webSearch: false, skills: false, integrations: [] }
      }),
      true
    );
    assert.equal(removesCapabilitiesOnly(before, structuredClone(before)), true);
  });

  it('is false when the instructions change too', () => {
    assert.equal(
      removesCapabilitiesOnly(before, {
        ...before,
        system: { en: 'Something else.' },
        capabilities: { ...before.capabilities, integrations: [] }
      }),
      false
    );
  });

  it('is false when anything is added: a switch, a binding, an action, another model', () => {
    const plain = {
      ...before,
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
    };
    assert.equal(removesCapabilitiesOnly(plain, before), false);
    assert.equal(
      removesCapabilitiesOnly(before, {
        ...before,
        capabilities: {
          ...before.capabilities,
          integrations: [{ id: INSTALLATION, actions: ['search', 'read'] }]
        }
      }),
      false
    );
    assert.equal(removesCapabilitiesOnly(before, { ...before, preferredModel: 'model-b' }), false);
  });
});

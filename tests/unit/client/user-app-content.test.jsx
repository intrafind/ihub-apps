// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared contract of personal apps (`shared/userAppContent.js`): the ID
 * shape, the content keys and caps, the verdict on every key of the app
 * schema, the fixed parts of the run object, and the body builder
 * `pickUserAppContent`. Also the two places that follow from it:
 * `shared/appId.js` refuses the personal shape, and `shared/apiErrors.js`
 * holds the codes of the user routes.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 4.2, 4.4 and 9.1.
 */
import {
  PERSONAL_UPLOAD_OFF,
  PERSONAL_UPLOAD_ON,
  USER_APP_CAPABILITY_KEYS,
  USER_APP_COLOR_PATTERN,
  USER_APP_CONTENT_KEYS,
  USER_APP_FIELD_POLICY,
  USER_APP_ICON_PATTERN,
  USER_APP_ID_PREFIX,
  USER_APP_INTEGRATION_KEYS,
  USER_APP_LIMITS,
  USER_APP_LOCALIZED_KEYS,
  USER_APP_MEMBER_ROLES,
  USER_APP_MEMBER_TYPES,
  USER_APP_ORIGINS,
  USER_APP_REQUIRED_KEYS,
  USER_APP_RUN_KEYS,
  USER_APP_SCHEMA_DEFAULTS,
  USER_APP_STARTER_PROMPT_KEYS,
  USER_APP_STATES,
  USER_APP_VARIABLE_KEYS,
  isUserAppId,
  personalAppBase,
  pickUserAppContent
} from '../../../shared/userAppContent.js';
import { appIdProblem, isValidAppId, uniqueAppId } from '../../../shared/appId.js';
import {
  API_ERROR_CODES,
  USER_APP_ERROR_CODES,
  isApiErrorCode
} from '../../../shared/apiErrors.js';
import {
  DEFAULT_APP_COLOR,
  DEFAULT_APP_ICON,
  newAppDefaults
} from '../../../shared/appDefaults.js';
import { APP_ID_MAX_LENGTH, APP_ID_PATTERN } from '../../../shared/validationPatterns.js';
import { appConfigSchema, knownAppKeys } from '../../../server/validators/appConfigSchema.js';

const MINTED = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';

/** A value of the right kind for every top-level key of the app schema. */
function appWithEverySchemaKey() {
  const values = {
    id: 'every-key',
    name: { en: 'Everything', de: 'Alles' },
    description: { en: 'Has every key' },
    color: '#112233',
    icon: 'sparkles',
    type: 'iframe',
    redirectConfig: { url: 'https://example.org' },
    iframeConfig: { url: 'https://example.org' },
    system: { en: 'You help.' },
    order: 3,
    preferredModel: 'model-a',
    preferredOutputFormat: 'html',
    preferredStyle: 'formal',
    sendChatHistory: false,
    thinking: { enabled: true },
    imageGeneration: { enabled: true },
    messagePlaceholder: { en: 'Type here' },
    prompt: { en: '{{content}}' },
    variables: [
      {
        name: 'tone',
        label: { en: 'Tone' },
        type: 'select',
        required: true,
        defaultValue: { en: 'formal' },
        predefinedValues: [{ label: { en: 'Formal' }, value: 'formal' }],
        description: { en: 'not a personal key' }
      }
    ],
    startForm: { enabled: true },
    variablesPanel: { enabled: true },
    settings: { enabled: true },
    inputMode: { type: 'multiline' },
    upload: { enabled: true },
    features: { magicPrompt: { enabled: true } },
    greeting: { en: { title: 'Hi', subtitle: 'there' } },
    aiDisclosure: { firstTurnNotice: { enabled: false } },
    starterPrompts: [
      { title: { en: 'Start' }, message: { en: 'Go' }, variables: { tone: 'formal' } }
    ],
    usageGuide: { enabled: true },
    projects: ['secret-project'],
    allowedModels: ['model-a'],
    disallowModelSelection: true,
    allowEmptyContent: true,
    autoStart: true,
    ephemeral: true,
    websearch: { enabled: true, useNativeSearch: true },
    toolChoice: 'required',
    toolApproval: { default: 'never' },
    workflows: ['wf'],
    toolSearch: { mode: 'off' },
    apps: ['other-app'],
    skills: ['*'],
    skillSettings: { enabled: true },
    documentTemplate: 'corporate',
    allowUserTemplateUploads: true,
    uploads: { storageMode: 'original_and_text' },
    outputSchema: '{}',
    customResponseRenderer: 'evil',
    rendererConfig: {},
    category: 'utility',
    enabled: false,
    requiredFeatures: [],
    requiredIntegrations: [],
    iassistant: { enabled: true },
    integrations: {
      jira: { actions: ['searchIssues', 'getIssue'], required: true },
      mail: {},
      '*': { exclude: ['x'] },
      'type:jira': { actions: ['searchIssues'] }
    },
    allowInheritance: true,
    parentId: 'parent',
    inheritanceLevel: 1,
    overriddenFields: ['name'],
    sourceUserAppId: 'uap_0123456789abcdef0123456789abcdef'
  };
  return values;
}

describe('isUserAppId', () => {
  test('accepts the prefix and 32 lower-case hex characters', () => {
    expect(isUserAppId(MINTED)).toBe(true);
    expect(isUserAppId(`${USER_APP_ID_PREFIX}${'0'.repeat(32)}`)).toBe(true);
    expect(isUserAppId(`${USER_APP_ID_PREFIX}${'abcdef0123456789'.repeat(2)}`)).toBe(true);
  });

  test.each([
    ['a readable ID with the prefix', 'uap_helper'],
    ['the prefix alone', 'uap_'],
    ['31 hex characters', `uap_${'a'.repeat(31)}`],
    ['33 hex characters', `uap_${'a'.repeat(33)}`],
    ['upper-case hex', `uap_${'A'.repeat(32)}`],
    ['an upper-case prefix', `UAP_${'a'.repeat(32)}`],
    ['a character outside hex', `uap_${'g'.repeat(32)}`],
    ['another prefix', `app_${'a'.repeat(32)}`],
    ['no prefix', 'a'.repeat(36)],
    ['a leading space', ` ${MINTED}`],
    ['a trailing newline', `${MINTED}\n`],
    ['a suffix', `${MINTED}-2`],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an array holding an ID', [MINTED]],
    ['an object with toString', { toString: () => MINTED }]
  ])('refuses %s', (_label, value) => {
    expect(isUserAppId(value)).toBe(false);
  });

  test('a minted ID is 36 characters and passes the character rule of every app ID', () => {
    expect(MINTED).toHaveLength(36);
    expect(MINTED.length).toBeLessThanOrEqual(APP_ID_MAX_LENGTH);
    expect(APP_ID_PATTERN.test(MINTED)).toBe(true);
  });
});

describe('shared/appId.js and the personal shape', () => {
  test('isValidAppId refuses the personal shape', () => {
    expect(isValidAppId(MINTED)).toBe(false);
    expect(appIdProblem(MINTED)).toBe('reserved');
  });

  test('isValidAppId accepts an ID that only starts with the prefix', () => {
    expect(isValidAppId('uap_helper')).toBe(true);
    expect(appIdProblem('uap_helper')).toBeNull();
    expect(isValidAppId(`uap_${'a'.repeat(31)}`)).toBe(true);
    expect(isValidAppId(`uap_${'a'.repeat(33)}`)).toBe(true);
    expect(isValidAppId('uap')).toBe(true);
  });

  test('uniqueAppId never returns the personal shape', () => {
    const id = uniqueAppId(MINTED, () => false);
    expect(id).toBe(`${MINTED}-2`);
    expect(isUserAppId(id)).toBe(false);
    expect(isValidAppId(id)).toBe(true);
  });
});

describe('the content keys and caps', () => {
  test('the content keys are those of section 4.4, without category', () => {
    expect([...USER_APP_CONTENT_KEYS].sort()).toEqual(
      [
        'capabilities',
        'color',
        'description',
        'icon',
        'messagePlaceholder',
        'name',
        'preferredModel',
        'prompt',
        'starterPrompts',
        'system',
        'variables'
      ].sort()
    );
    expect(USER_APP_CONTENT_KEYS).not.toContain('category');
    expect(USER_APP_CONTENT_KEYS).not.toContain('id');
  });

  test('the localized and the required keys are content keys', () => {
    expect(USER_APP_LOCALIZED_KEYS).toEqual([
      'name',
      'description',
      'system',
      'prompt',
      'messagePlaceholder'
    ]);
    expect(USER_APP_REQUIRED_KEYS).toEqual(['name', 'description', 'system']);
    for (const key of USER_APP_LOCALIZED_KEYS) expect(USER_APP_CONTENT_KEYS).toContain(key);
  });

  test('the sub-keys are those of section 4.4', () => {
    expect(USER_APP_VARIABLE_KEYS).toEqual([
      'name',
      'label',
      'type',
      'required',
      'defaultValue',
      'predefinedValues'
    ]);
    expect(USER_APP_STARTER_PROMPT_KEYS).toEqual(['title', 'message']);
    expect(USER_APP_CAPABILITY_KEYS).toEqual(['upload', 'webSearch', 'skills', 'integrations']);
    expect(USER_APP_INTEGRATION_KEYS).toEqual(['id', 'actions']);
  });

  test('the caps are those of section 4.4', () => {
    expect(USER_APP_LIMITS).toMatchObject({
      languages: 5,
      name: 100,
      description: 500,
      system: 8000,
      prompt: 4000,
      messagePlaceholder: 200,
      variables: 8,
      starterPrompts: 4,
      starterTitle: 80,
      starterMessage: 500,
      integrations: 5,
      integrationActions: 30,
      members: 100
    });
  });

  test('the caps of a generated draft have the same names and values here', () => {
    // `DRAFT_LIMITS` of `server/services/appGenerator.js`, written out: that
    // module loads the config cache and cannot be imported here. The generator
    // is to import its limits from this object (section 4.4).
    const draftLimits = {
      name: 100,
      description: 500,
      system: 8000,
      prompt: 4000,
      messagePlaceholder: 200,
      variables: 8,
      variableLabel: 80,
      variableDefault: 200,
      options: 20,
      optionValue: 200,
      optionLabel: 100,
      starterPrompts: 4,
      starterTitle: 80,
      starterMessage: 500
    };
    expect(USER_APP_LIMITS).toMatchObject(draftLimits);
    expect(Object.keys(USER_APP_LIMITS).sort()).toEqual(
      [
        ...Object.keys(draftLimits),
        'languages',
        'integrations',
        'integrationActions',
        'members'
      ].sort()
    );
  });

  test('the icon and colour rules', () => {
    expect(USER_APP_ICON_PATTERN.test(DEFAULT_APP_ICON)).toBe(true);
    expect(USER_APP_ICON_PATTERN.test('a'.repeat(40))).toBe(true);
    expect(USER_APP_ICON_PATTERN.test('a'.repeat(41))).toBe(false);
    expect(USER_APP_ICON_PATTERN.test('../icon')).toBe(false);
    expect(USER_APP_ICON_PATTERN.test('Icon')).toBe(false);
    expect(USER_APP_ICON_PATTERN.test('')).toBe(false);
    expect(USER_APP_COLOR_PATTERN.test(DEFAULT_APP_COLOR)).toBe(true);
    expect(USER_APP_COLOR_PATTERN.test('#fff')).toBe(false);
    expect(USER_APP_COLOR_PATTERN.test('red')).toBe(false);
  });

  test('the vocabulary of the record', () => {
    expect(USER_APP_ORIGINS).toEqual(['blank', 'template', 'generated', 'copy']);
    expect(USER_APP_ORIGINS).not.toContain('chat');
    expect(USER_APP_MEMBER_ROLES).toEqual(['editor', 'user']);
    expect(USER_APP_MEMBER_TYPES).toEqual(['user', 'group', 'everyone']);
    expect(USER_APP_STATES).toEqual(['active', 'promoted']);
  });

  test('the exported lists cannot be changed', () => {
    for (const list of [
      USER_APP_CONTENT_KEYS,
      USER_APP_LIMITS,
      USER_APP_FIELD_POLICY,
      USER_APP_RUN_KEYS,
      USER_APP_SCHEMA_DEFAULTS,
      USER_APP_VARIABLE_KEYS,
      USER_APP_STARTER_PROMPT_KEYS
    ]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});

describe('USER_APP_FIELD_POLICY', () => {
  const keysOf = verdict =>
    Object.keys(USER_APP_FIELD_POLICY).filter(key => USER_APP_FIELD_POLICY[key] === verdict);

  test('gives every key of the app schema a verdict, and names no other key', () => {
    expect(Object.keys(USER_APP_FIELD_POLICY).sort()).toEqual([...knownAppKeys].sort());
  });

  test('knows four verdicts', () => {
    expect([...new Set(Object.values(USER_APP_FIELD_POLICY))].sort()).toEqual([
      'capability',
      'content',
      'fixed',
      'never'
    ]);
  });

  test('content: the nine keys copied from the record', () => {
    expect(keysOf('content').sort()).toEqual(
      [
        'name',
        'description',
        'icon',
        'color',
        'system',
        'prompt',
        'messagePlaceholder',
        'variables',
        'starterPrompts'
      ].sort()
    );
    for (const key of keysOf('content')) expect(USER_APP_CONTENT_KEYS).toContain(key);
  });

  test('capability: the seven keys only the ceiling writes', () => {
    expect(keysOf('capability').sort()).toEqual(
      [
        'preferredModel',
        'upload',
        'websearch',
        'skills',
        'skillSettings',
        'integrations',
        'toolApproval'
      ].sort()
    );
  });

  test('fixed: exactly the keys of personalAppBase', () => {
    expect(keysOf('fixed').sort()).toEqual(Object.keys(personalAppBase(MINTED)).sort());
  });

  test('never: what lets an author decide about another person’s browser, knowledge or tools', () => {
    for (const key of [
      'redirectConfig',
      'iframeConfig',
      'preferredOutputFormat',
      'outputSchema',
      'customResponseRenderer',
      'rendererConfig',
      'projects',
      'apps',
      'workflows',
      'iassistant',
      'toolChoice',
      'allowedModels',
      'category',
      'parentId'
    ]) {
      expect([key, USER_APP_FIELD_POLICY[key]]).toEqual([key, 'never']);
    }
  });
});

describe('the run object', () => {
  test('USER_APP_RUN_KEYS is the fixed, content and capability keys: 23, each once', () => {
    expect(USER_APP_RUN_KEYS).toHaveLength(23);
    expect(new Set(USER_APP_RUN_KEYS).size).toBe(23);
    for (const key of USER_APP_RUN_KEYS) {
      expect(['fixed', 'content', 'capability']).toContain(USER_APP_FIELD_POLICY[key]);
    }
    for (const [key, verdict] of Object.entries(USER_APP_FIELD_POLICY)) {
      expect([key, USER_APP_RUN_KEYS.includes(key)]).toEqual([key, verdict !== 'never']);
    }
  });

  test('personalAppBase writes the seven fixed values and a new object on every call', () => {
    const base = personalAppBase(MINTED);
    expect(base).toEqual({
      id: MINTED,
      type: 'chat',
      enabled: true,
      sendChatHistory: true,
      allowEmptyContent: false,
      inputMode: {
        type: 'singleline',
        rows: 5,
        microphone: { enabled: true, mode: 'manual', showTranscript: true }
      },
      features: { projects: false, userProjects: false }
    });
    const other = personalAppBase(MINTED);
    expect(other).not.toBe(base);
    expect(other.inputMode).not.toBe(base.inputMode);
    expect(other.inputMode.microphone).not.toBe(base.inputMode.microphone);
    expect(other.features).not.toBe(base.features);
  });

  test('the copied values of personalAppBase equal those of newAppDefaults()', () => {
    const defaults = newAppDefaults();
    const base = personalAppBase(MINTED);
    expect(base.type).toBe(defaults.type);
    expect(base.sendChatHistory).toBe(defaults.sendChatHistory);
    expect(base.allowEmptyContent).toBe(defaults.allowEmptyContent);
    expect(base.inputMode).toEqual(defaults.inputMode);
  });

  test('the upload objects equal the upload block of newAppDefaults(), switched on and off', () => {
    const upload = newAppDefaults().upload;
    expect(PERSONAL_UPLOAD_ON).toEqual({
      ...upload,
      enabled: true,
      imageUpload: { ...upload.imageUpload, enabled: true },
      fileUpload: { ...upload.fileUpload, enabled: true }
    });
    expect(PERSONAL_UPLOAD_OFF).toEqual({ enabled: upload.enabled });
    expect(PERSONAL_UPLOAD_OFF).toEqual({ enabled: false });
  });

  test('the upload objects are frozen down to the format lists', () => {
    expect(Object.isFrozen(PERSONAL_UPLOAD_ON)).toBe(true);
    expect(Object.isFrozen(PERSONAL_UPLOAD_ON.imageUpload)).toBe(true);
    expect(Object.isFrozen(PERSONAL_UPLOAD_ON.fileUpload.supportedFormats)).toBe(true);
    expect(Object.isFrozen(PERSONAL_UPLOAD_OFF)).toBe(true);
  });

  test('a run object passes the app schema and gains only the four schema defaults', () => {
    const app = {
      ...personalAppBase(MINTED),
      name: { de: 'Helfer' },
      description: { de: 'Hilft' },
      system: { de: 'Du hilfst.' },
      icon: DEFAULT_APP_ICON,
      color: DEFAULT_APP_COLOR,
      upload: structuredClone(PERSONAL_UPLOAD_ON),
      websearch: { enabled: false },
      toolApproval: { default: 'always' }
    };
    // The schema of the app files refuses the personal shape (4.2), so the
    // shape of the object is checked under an ordinary ID.
    const parsed = appConfigSchema.safeParse({ ...app, id: 'uap_helper' });
    expect(parsed.error?.issues).toBeUndefined();
    const added = Object.keys(parsed.data).filter(key => !Object.hasOwn(app, key));
    expect(added.sort()).toEqual(Object.keys(USER_APP_SCHEMA_DEFAULTS).sort());
    for (const key of added) expect(parsed.data[key]).toBe(USER_APP_SCHEMA_DEFAULTS[key]);
    for (const key of Object.keys(USER_APP_SCHEMA_DEFAULTS)) {
      expect(USER_APP_FIELD_POLICY[key]).toBe('never');
    }
    for (const key of Object.keys(app)) expect(USER_APP_RUN_KEYS).toContain(key);
  });
});

describe('pickUserAppContent', () => {
  test('the fixture sets every key of the app schema', () => {
    expect(Object.keys(appWithEverySchemaKey()).sort()).toEqual([...knownAppKeys].sort());
  });

  test('returns only the keys of section 4.4 for an app with every schema key set', () => {
    const content = pickUserAppContent(appWithEverySchemaKey());
    expect(Object.keys(content).sort()).toEqual([...USER_APP_CONTENT_KEYS].sort());
    expect(content).toEqual({
      name: { en: 'Everything', de: 'Alles' },
      description: { en: 'Has every key' },
      system: { en: 'You help.' },
      icon: 'sparkles',
      color: '#112233',
      prompt: { en: '{{content}}' },
      messagePlaceholder: { en: 'Type here' },
      variables: [
        {
          name: 'tone',
          label: { en: 'Tone' },
          type: 'select',
          required: true,
          defaultValue: { en: 'formal' },
          predefinedValues: [{ label: { en: 'Formal' }, value: 'formal' }]
        }
      ],
      starterPrompts: [{ title: { en: 'Start' }, message: { en: 'Go' } }],
      preferredModel: 'model-a',
      capabilities: {
        upload: true,
        webSearch: true,
        skills: true,
        integrations: [{ id: 'jira', actions: ['searchIssues', 'getIssue'] }]
      }
    });
  });

  test('a binding of everything, of a definition or without named actions has no personal form', () => {
    const { capabilities } = pickUserAppContent({
      integrations: {
        '*': {},
        'type:jira': { actions: ['searchIssues'] },
        whole: {},
        empty: { actions: [] },
        junk: { actions: [null, 7, ''] },
        jira: { actions: ['getIssue', 'getIssue', 'searchIssues'] }
      }
    });
    expect(capabilities.integrations).toEqual([
      { id: 'jira', actions: ['getIssue', 'searchIssues'] }
    ]);
  });

  test('a new empty app yields its texts, icon, colour and every capability off', () => {
    const content = pickUserAppContent(newAppDefaults('de'));
    expect(content).toEqual({
      name: { de: '' },
      description: { de: '' },
      system: { de: '' },
      icon: DEFAULT_APP_ICON,
      color: DEFAULT_APP_COLOR,
      variables: [],
      starterPrompts: [],
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
    });
  });

  test('a personal body passes through, and is picked again to the same value', () => {
    const body = {
      name: { de: 'Stellenanzeigen schreiben' },
      description: { de: 'Schreibt Stellenanzeigen' },
      system: { de: 'Du schreibst Stellenanzeigen.' },
      icon: 'document-text',
      color: '#4F46E5',
      variables: [],
      starterPrompts: [],
      preferredModel: 'model-a',
      capabilities: {
        upload: true,
        webSearch: false,
        skills: false,
        integrations: [{ id: 'jira', actions: ['searchIssues'] }]
      }
    };
    const content = pickUserAppContent(body);
    expect(content).toEqual(body);
    expect(pickUserAppContent(content)).toEqual(body);
  });

  test('what `capabilities` says wins over the keys of an app config', () => {
    const { capabilities } = pickUserAppContent({
      capabilities: { webSearch: false, integrations: [] },
      upload: { enabled: true },
      websearch: { enabled: true },
      integrations: { jira: { actions: ['searchIssues'] } }
    });
    expect(capabilities).toEqual({
      upload: true,
      webSearch: false,
      skills: false,
      integrations: []
    });
  });

  test('entries of the personal integration list keep only id and actions', () => {
    const { capabilities } = pickUserAppContent({
      capabilities: {
        integrations: [
          { id: 'jira', actions: ['searchIssues'], required: true, scopes: ['x'] },
          { id: 'jira', actions: ['getIssue'] },
          { id: '*', actions: ['x'] },
          { id: 'type:jira', actions: ['x'] },
          { id: 'mail' },
          'jira',
          null
        ]
      }
    });
    expect(capabilities.integrations).toEqual([{ id: 'jira', actions: ['searchIssues'] }]);
  });

  test('leaves out what is not set, and never sets an empty preferred model', () => {
    expect(pickUserAppContent({ name: { en: 'A' }, preferredModel: '' })).toEqual({
      name: { en: 'A' },
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
    });
    expect(pickUserAppContent({ preferredModel: null })).not.toHaveProperty('preferredModel');
  });

  test('ignores a value of the wrong kind', () => {
    const content = pickUserAppContent({
      name: 'a plain string',
      description: ['x'],
      icon: 7,
      color: null,
      variables: 'none',
      starterPrompts: {},
      preferredModel: { id: 'model-a' },
      capabilities: 'all',
      upload: true,
      websearch: 'yes'
    });
    expect(content).toEqual({
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
    });
  });

  test.each([[null], [undefined], ['text'], [[]], [42]])(
    '%p yields only the capabilities',
    draft => {
      expect(pickUserAppContent(draft)).toEqual({
        capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
      });
    }
  );

  test('does not select by limit: the server names what is too long or too many', () => {
    const variables = Array.from({ length: USER_APP_LIMITS.variables + 3 }, (_, index) => ({
      name: `field${index}`,
      label: { en: 'Field' },
      type: 'string'
    }));
    const content = pickUserAppContent({
      name: { en: 'x'.repeat(USER_APP_LIMITS.name + 1) },
      variables
    });
    expect(content.name.en).toHaveLength(USER_APP_LIMITS.name + 1);
    expect(content.variables).toHaveLength(USER_APP_LIMITS.variables + 3);
  });

  test('does not modify the draft and shares no object with it', () => {
    const draft = appWithEverySchemaKey();
    const before = structuredClone(draft);
    const content = pickUserAppContent(draft);
    expect(draft).toEqual(before);

    content.name.en = 'changed';
    content.variables[0].label.en = 'changed';
    content.variables[0].predefinedValues.push({ value: 'x' });
    content.starterPrompts[0].title.en = 'changed';
    content.capabilities.integrations[0].actions.push('deleteIssue');
    expect(draft).toEqual(before);
  });
});

describe('the error codes of the user routes', () => {
  test('are in the registry with the statuses of section 9.1', () => {
    const expected = {
      USER_APPS_DISABLED: 403,
      USER_APPS_UNAVAILABLE: 503,
      QUOTA_USER_APPS: 409,
      QUOTA_USER_APP_OFFERS: 409,
      USER_APP_CAPABILITY_DENIED: 403,
      USER_APP_ACCESS_CHANGED: 403
    };
    expect(USER_APP_ERROR_CODES).toEqual(expected);
    for (const [code, status] of Object.entries(expected)) {
      expect(isApiErrorCode(code)).toBe(true);
      expect([code, API_ERROR_CODES[code]]).toEqual([code, status]);
    }
  });

  test('the codes the routes reuse exist with the status the table names', () => {
    expect(API_ERROR_CODES).toMatchObject({
      AUTH_REQUIRED: 401,
      NOT_FOUND: 404,
      VALIDATION_FAILED: 400,
      CONFLICT: 409,
      ETAG_MISMATCH: 409,
      SHARE_TARGET_INVALID: 400,
      SHARE_TARGET_NOT_ALLOWED: 403
    });
    expect(isApiErrorCode('PERMISSION_DENIED')).toBe(true);
  });
});

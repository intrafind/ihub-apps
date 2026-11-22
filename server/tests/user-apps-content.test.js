// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a personal app may store (feature `userApps`, design section 4.4).
 *
 * Pinned here:
 *
 *  - the content schema is an allow-list: an unknown key is refused at every
 *    level, every cap holds (5 languages, 100 members, a binding without
 *    `actions`), and hidden characters are gone from every text key;
 *  - every key of the app schema has a verdict in `USER_APP_FIELD_POLICY`, so
 *    the app schema cannot gain a key that silently reaches a personal app;
 *  - the values `personalAppBase` and the two upload objects copy equal those
 *    of `newAppDefaults()`;
 *  - `appConfigSchema` refuses an ID of the personal shape.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { appConfigSchema, knownAppKeys } from '../validators/appConfigSchema.js';
import {
  mergeUserAppContent,
  stripHiddenCharacters,
  userAppContentSchema,
  userAppCreateSchema,
  userAppMembersSchema,
  userAppOwnerOfferSchema,
  userAppPatchSchema,
  userAppSettingsSchema
} from '../validators/userAppSchema.js';
import {
  PERSONAL_UPLOAD_OFF,
  PERSONAL_UPLOAD_ON,
  USER_APP_CONTENT_KEYS,
  USER_APP_FIELD_POLICY,
  USER_APP_LIMITS,
  isUserAppId,
  personalAppBase
} from '../../shared/userAppContent.js';
import { newAppDefaults } from '../../shared/appDefaults.js';

const PERSONAL_ID = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';

const content = (extra = {}) => ({
  name: { en: 'Job ad writer' },
  description: { en: 'Writes job ads' },
  system: { en: 'You write job ads.' },
  icon: 'document-text',
  color: '#4F46E5',
  ...extra
});

const everyKey = () =>
  content({
    prompt: { en: 'Write an ad for {{role}}.' },
    messagePlaceholder: { en: 'Which role?' },
    variables: [
      {
        name: 'role',
        label: { en: 'Role' },
        type: 'select',
        required: true,
        defaultValue: { en: 'dev' },
        predefinedValues: [{ value: 'dev', label: { en: 'Developer' } }]
      }
    ],
    starterPrompts: [{ title: { en: 'Developer' }, message: { en: 'An ad for a developer' } }],
    preferredModel: 'gpt-4o',
    capabilities: {
      upload: true,
      webSearch: true,
      skills: true,
      integrations: [{ id: 'jira', actions: ['search_issues'] }]
    }
  });

const accepts = (schema, value) => schema.safeParse(value).success;
const issuesOf = (schema, value) => {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, 'expected the value to be refused');
  return parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
};
const languages = count =>
  Object.fromEntries(['en', 'de', 'fr', 'es', 'it', 'nl', 'pt'].slice(0, count).map(l => [l, 'x']));

describe('the content schema is an allow-list', () => {
  it('accepts an app with every allowed key and keeps exactly the content keys', () => {
    const parsed = userAppContentSchema.parse(everyKey());
    assert.deepEqual(Object.keys(parsed).sort(), [...USER_APP_CONTENT_KEYS].sort());
    assert.deepEqual(parsed.capabilities.integrations, [
      { id: 'jira', actions: ['search_issues'] }
    ]);
  });

  it('fills what a minimal app leaves out, and leaves optional texts absent', () => {
    const parsed = userAppContentSchema.parse({
      name: { de: 'Helfer' },
      description: { de: 'Hilft' },
      system: { de: 'Du hilfst.' }
    });
    assert.deepEqual(parsed.capabilities, {
      upload: false,
      webSearch: false,
      skills: false,
      integrations: []
    });
    assert.deepEqual(parsed.variables, []);
    assert.deepEqual(parsed.starterPrompts, []);
    assert.match(parsed.icon, /^[a-z0-9-]+$/);
    assert.match(parsed.color, /^#[0-9A-Fa-f]{6}$/);
    for (const key of ['prompt', 'messagePlaceholder', 'preferredModel']) {
      assert.equal(Object.hasOwn(parsed, key), false, `${key} must be absent`);
    }
  });

  it('refuses an unknown key at the top level', () => {
    for (const key of ['type', 'iframeConfig', 'projects', 'toolApproval', 'category', 'id']) {
      const issues = issuesOf(userAppContentSchema, content({ [key]: 'x' }));
      assert.ok(
        issues.some(issue => issue.includes(key)),
        `${key}: ${issues.join('; ')}`
      );
    }
  });

  it('refuses an unknown key in an input field, a starter, the capabilities and a binding', () => {
    const variable = { name: 'role', label: { en: 'Role' }, type: 'string' };
    assert.equal(
      accepts(
        userAppContentSchema,
        content({ variables: [{ ...variable, description: { en: 'x' } }] })
      ),
      false
    );
    assert.equal(
      accepts(
        userAppContentSchema,
        content({
          starterPrompts: [{ title: { en: 'a' }, message: { en: 'b' }, autoSend: true }]
        })
      ),
      false
    );
    assert.equal(
      accepts(userAppContentSchema, content({ capabilities: { imageGeneration: true } })),
      false
    );
    assert.equal(
      accepts(
        userAppContentSchema,
        content({
          capabilities: { integrations: [{ id: 'jira', actions: ['a'], required: true }] }
        })
      ),
      false
    );
  });

  it('requires name, description and instructions, each with a text', () => {
    for (const key of ['name', 'description', 'system']) {
      const { [key]: _removed, ...rest } = content();
      assert.equal(accepts(userAppContentSchema, rest), false, `${key} missing`);
      assert.equal(accepts(userAppContentSchema, content({ [key]: {} })), false, `${key} empty`);
      assert.equal(
        accepts(userAppContentSchema, content({ [key]: { en: '   ' } })),
        false,
        `${key} blank`
      );
    }
  });
});

describe('every cap holds', () => {
  it('accepts 5 languages and refuses 6, for every localized key', () => {
    for (const key of ['name', 'description', 'system', 'prompt', 'messagePlaceholder']) {
      assert.equal(accepts(userAppContentSchema, content({ [key]: languages(5) })), true, key);
      const issues = issuesOf(userAppContentSchema, content({ [key]: languages(6) }));
      assert.ok(
        issues.some(issue => issue.startsWith(`${key}: At most 5 languages`)),
        `${key}: ${issues.join('; ')}`
      );
    }
  });

  it('holds the length of each text per language', () => {
    for (const key of ['name', 'description', 'system', 'prompt', 'messagePlaceholder']) {
      const max = USER_APP_LIMITS[key];
      assert.equal(
        accepts(userAppContentSchema, content({ [key]: { en: 'a'.repeat(max) } })),
        true
      );
      assert.equal(
        accepts(userAppContentSchema, content({ [key]: { en: 'a'.repeat(max + 1) } })),
        false,
        `${key} over ${max}`
      );
    }
  });

  it('holds 8 input fields and 4 conversation starters', () => {
    const variables = count =>
      Array.from({ length: count }, (_, i) => ({
        name: `field${i}`,
        label: { en: `Field ${i}` },
        type: 'string'
      }));
    const starters = count =>
      Array.from({ length: count }, (_, i) => ({ title: { en: `T${i}` }, message: { en: 'm' } }));
    assert.equal(accepts(userAppContentSchema, content({ variables: variables(8) })), true);
    assert.equal(accepts(userAppContentSchema, content({ variables: variables(9) })), false);
    assert.equal(accepts(userAppContentSchema, content({ starterPrompts: starters(4) })), true);
    assert.equal(accepts(userAppContentSchema, content({ starterPrompts: starters(5) })), false);
  });

  it('holds 5 bound installations with at most 30 named actions each', () => {
    const bindings = count =>
      Array.from({ length: count }, (_, i) => ({ id: `system${i}`, actions: ['read'] }));
    const actions = count => Array.from({ length: count }, (_, i) => `action${i}`);
    const withBindings = integrations => content({ capabilities: { integrations } });
    assert.equal(accepts(userAppContentSchema, withBindings(bindings(5))), true);
    assert.equal(accepts(userAppContentSchema, withBindings(bindings(6))), false);
    assert.equal(
      accepts(userAppContentSchema, withBindings([{ id: 'jira', actions: actions(30) }])),
      true
    );
    assert.equal(
      accepts(userAppContentSchema, withBindings([{ id: 'jira', actions: actions(31) }])),
      false
    );
  });

  it('refuses a binding without actions, with an empty list, with "*" and of a definition', () => {
    const withBinding = binding => content({ capabilities: { integrations: [binding] } });
    assert.equal(accepts(userAppContentSchema, withBinding({ id: 'jira' })), false);
    assert.equal(accepts(userAppContentSchema, withBinding({ id: 'jira', actions: [] })), false);
    assert.equal(accepts(userAppContentSchema, withBinding({ id: 'jira', actions: ['*'] })), false);
    assert.equal(accepts(userAppContentSchema, withBinding({ id: '*', actions: ['a'] })), false);
    assert.equal(
      accepts(userAppContentSchema, withBinding({ id: 'type:people-directory', actions: ['a'] })),
      false
    );
    assert.equal(
      accepts(
        userAppContentSchema,
        withBinding({ id: 'com.intrafind/ldap-directory', actions: ['a'] })
      ),
      false
    );
    assert.equal(accepts(userAppContentSchema, withBinding({ id: 'ihub', actions: ['a'] })), false);
    const issues = issuesOf(userAppContentSchema, withBinding({ id: 'jira' }));
    assert.ok(issues.some(issue => issue.startsWith('capabilities.integrations.0.actions')));
  });

  it('refuses the same installation twice', () => {
    assert.equal(
      accepts(
        userAppContentSchema,
        content({
          capabilities: {
            integrations: [
              { id: 'jira', actions: ['a'] },
              { id: 'jira', actions: ['b'] }
            ]
          }
        })
      ),
      false
    );
  });

  it('accepts 100 members and refuses 101', () => {
    const members = count =>
      Array.from({ length: count }, (_, i) => ({ type: 'user', id: `user-${i}`, role: 'user' }));
    assert.equal(accepts(userAppMembersSchema, { members: members(100) }), true);
    const issues = issuesOf(userAppMembersSchema, { members: members(101) });
    assert.ok(issues.some(issue => issue.startsWith('members: At most 100 members')));
  });

  it('knows the two roles and the three kinds of member, and nothing else', () => {
    const one = member => ({ members: [member] });
    assert.equal(
      accepts(userAppMembersSchema, one({ type: 'group', id: 'hr', role: 'editor' })),
      true
    );
    assert.equal(accepts(userAppMembersSchema, one({ type: 'everyone', role: 'user' })), true);
    assert.equal(
      accepts(userAppMembersSchema, one({ type: 'user', id: 'ben', role: 'owner' })),
      false
    );
    assert.equal(accepts(userAppMembersSchema, one({ type: 'user', role: 'user' })), false);
    assert.equal(accepts(userAppMembersSchema, one({ type: 'app', id: 'x', role: 'user' })), false);
    assert.equal(accepts(userAppMembersSchema, { members: [], extra: 1 }), false);
    assert.equal(accepts(userAppOwnerOfferSchema, { ownerId: 'ben' }), true);
    assert.equal(accepts(userAppOwnerOfferSchema, { ownerId: '' }), false);
  });

  it('refuses an icon that could be a path and a colour that is not #RRGGBB', () => {
    assert.equal(accepts(userAppContentSchema, content({ icon: '../etc/passwd' })), false);
    assert.equal(accepts(userAppContentSchema, content({ icon: 'Chat' })), false);
    assert.equal(accepts(userAppContentSchema, content({ color: 'red' })), false);
    assert.equal(accepts(userAppContentSchema, content({ color: '#FFF' })), false);
  });
});

describe('hidden characters are gone after a save', () => {
  // Zero-width space, right-to-left override, a tag character, a NUL and a
  // soft hyphen: none of them shows in a text field.
  const HIDDEN = '​‮\u{E0041}\u0000­';
  const dirty = text => `${text.slice(0, 1)}${HIDDEN}${text.slice(1)}`;
  const hasHidden = text => /[​‮\u0000­]|\u{E0041}/u.test(text);

  it('strips controls, format characters and the tag block, and keeps newline and tab', () => {
    assert.equal(stripHiddenCharacters(`a${HIDDEN}b`), 'ab');
    assert.equal(stripHiddenCharacters('line 1\n\tline 2'), 'line 1\n\tline 2');
    assert.equal(stripHiddenCharacters('a\r\nb'), 'a\nb');
    assert.equal(stripHiddenCharacters('Grüße, 你好, emoji 😀'), 'Grüße, 你好, emoji 😀');
  });

  it('cleans every text key of the content', () => {
    const parsed = userAppContentSchema.parse({
      name: { en: dirty('Name') },
      description: { en: dirty('Description') },
      system: { en: dirty('Instructions') },
      prompt: { en: dirty('Template') },
      messagePlaceholder: { en: dirty('Hint') },
      variables: [
        {
          name: 'role',
          label: { en: dirty('Label') },
          type: 'select',
          defaultValue: { en: dirty('value') },
          predefinedValues: [{ value: dirty('value'), label: { en: dirty('Option') } }]
        }
      ],
      starterPrompts: [{ title: { en: dirty('Title') }, message: { en: dirty('Message') } }]
    });
    const texts = [];
    const walk = value => {
      if (typeof value === 'string') texts.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(parsed);
    assert.ok(texts.length >= 11);
    for (const text of texts) assert.equal(hasHidden(text), false, JSON.stringify(text));
    assert.equal(parsed.system.en, 'Instructions');
    assert.equal(parsed.variables[0].predefinedValues[0].value, 'value');
  });

  it('counts the length after cleaning, and refuses a text that is only hidden characters', () => {
    const padded = `${'a'.repeat(USER_APP_LIMITS.name)}${HIDDEN}`;
    assert.equal(accepts(userAppContentSchema, content({ name: { en: padded } })), true);
    assert.equal(accepts(userAppContentSchema, content({ system: { en: HIDDEN } })), false);
  });
});

describe('the bodies of create and update', () => {
  it('create takes the content keys at the top level, plus language and origin', () => {
    const parsed = userAppCreateSchema.parse({
      ...everyKey(),
      language: 'de',
      origin: 'generated'
    });
    assert.equal(parsed.language, 'de');
    assert.equal(parsed.origin, 'generated');
    assert.deepEqual(parsed.content, userAppContentSchema.parse(everyKey()));
  });

  it('create defaults to the first language of the name and to the origin "blank"', () => {
    const parsed = userAppCreateSchema.parse(content({ name: { de: 'Helfer' } }));
    assert.equal(parsed.language, 'de');
    assert.equal(parsed.origin, 'blank');
  });

  it('create refuses an unknown origin, an unknown key and a null preferred model stays unset', () => {
    assert.equal(accepts(userAppCreateSchema, content({ origin: 'chat' })), false);
    assert.equal(accepts(userAppCreateSchema, content({ revision: 3 })), false);
    assert.equal(accepts(userAppCreateSchema, content({ id: PERSONAL_ID })), false);
    const parsed = userAppCreateSchema.parse(content({ preferredModel: null }));
    assert.equal(Object.hasOwn(parsed.content, 'preferredModel'), false);
  });

  it('a patch names content keys only and is not empty', () => {
    assert.equal(accepts(userAppPatchSchema, { name: { en: 'New' } }), true);
    assert.equal(accepts(userAppPatchSchema, {}), false);
    assert.equal(accepts(userAppPatchSchema, { language: 'de' }), false);
    assert.equal(accepts(userAppPatchSchema, { state: 'active' }), false);
    assert.equal(accepts(userAppPatchSchema, { members: [] }), false);
  });

  it('a merge patch changes one language, removes a key with null and replaces lists', () => {
    const stored = userAppContentSchema.parse(everyKey());
    const merged = mergeUserAppContent(stored, {
      name: { de: 'Stellenanzeigen' },
      prompt: null,
      preferredModel: null,
      starterPrompts: [],
      capabilities: { webSearch: false }
    });
    assert.deepEqual(merged.name, { en: 'Job ad writer', de: 'Stellenanzeigen' });
    assert.equal(Object.hasOwn(merged, 'prompt'), false);
    assert.equal(Object.hasOwn(merged, 'preferredModel'), false);
    assert.deepEqual(merged.starterPrompts, []);
    assert.equal(merged.capabilities.webSearch, false);
    assert.equal(merged.capabilities.upload, true, 'what the patch does not name stays');
    assert.deepEqual(merged.capabilities.integrations, stored.capabilities.integrations);
    assert.deepEqual(stored.name, { en: 'Job ad writer' }, 'the stored content is not modified');
  });

  it('a merge patch is checked as a whole: the sixth language and a removed name are refused', () => {
    const stored = userAppContentSchema.parse(content({ name: languages(5) }));
    assert.throws(() => mergeUserAppContent(stored, { name: { pt: 'x' } }), /At most 5 languages/);
    assert.throws(
      () => mergeUserAppContent(stored, { system: { en: null } }),
      /At least one language/
    );
    assert.throws(() => mergeUserAppContent(stored, { type: 'iframe' }));
    assert.throws(() =>
      mergeUserAppContent(stored, { capabilities: { integrations: [{ id: 'jira' }] } })
    );
  });
});

describe('the settings body', () => {
  it('is partial: any one key passes', () => {
    assert.equal(accepts(userAppSettingsSchema, {}), true);
    assert.equal(accepts(userAppSettingsSchema, { sharing: { allowPublish: true } }), true);
    assert.equal(accepts(userAppSettingsSchema, { limits: { maxAppsPerUser: 0 } }), true);
    assert.equal(accepts(userAppSettingsSchema, { publishing: { adminEnables: 'always' } }), true);
    assert.equal(accepts(userAppSettingsSchema, { blockedOwners: ['mallory'] }), true);
    assert.equal(
      accepts(userAppSettingsSchema, {
        capabilities: { integrations: [{ id: 'jira', actions: ['search_issues'] }] }
      }),
      true
    );
  });

  it('refuses an unknown key at every level', () => {
    assert.equal(accepts(userAppSettingsSchema, { enabled: true }), false);
    assert.equal(accepts(userAppSettingsSchema, { sharing: { allowCatalog: true } }), false);
    assert.equal(accepts(userAppSettingsSchema, { limits: { maxFiles: 3 } }), false);
    assert.equal(
      accepts(userAppSettingsSchema, { capabilities: { imageGeneration: true } }),
      false
    );
    assert.equal(accepts(userAppSettingsSchema, { publishing: { mode: 'request' } }), false);
    assert.equal(accepts(userAppSettingsSchema, { publishing: { adminEnables: 'never' } }), false);
  });

  it('refuses the installation "ihub" and an entry without actions', () => {
    const withEntry = entry => ({ capabilities: { integrations: [entry] } });
    const ihub = issuesOf(userAppSettingsSchema, withEntry({ id: 'ihub', actions: ['ask_user'] }));
    assert.ok(ihub.some(issue => issue.startsWith('capabilities.integrations.0.id')));
    assert.equal(accepts(userAppSettingsSchema, withEntry({ id: 'jira' })), false);
    assert.equal(accepts(userAppSettingsSchema, withEntry({ id: 'jira', actions: [] })), false);
    assert.equal(accepts(userAppSettingsSchema, withEntry({ id: 'jira', actions: ['*'] })), false);
  });
});

describe('every key of the app schema has a verdict', () => {
  it('USER_APP_FIELD_POLICY covers knownAppKeys exactly', () => {
    const policyKeys = Object.keys(USER_APP_FIELD_POLICY).sort();
    const schemaKeys = [...knownAppKeys].sort();
    const withoutVerdict = schemaKeys.filter(key => !policyKeys.includes(key));
    const unknownToSchema = policyKeys.filter(key => !schemaKeys.includes(key));
    assert.deepEqual(
      withoutVerdict,
      [],
      'The app schema has a key without a verdict. Decide in shared/userAppContent.js whether ' +
        'a personal app may carry it (content, capability, fixed or never).'
    );
    assert.deepEqual(unknownToSchema, [], 'The policy names a key the app schema does not have.');
  });

  it('knows the four verdicts only', () => {
    const verdicts = new Set(Object.values(USER_APP_FIELD_POLICY));
    assert.deepEqual([...verdicts].sort(), ['capability', 'content', 'fixed', 'never']);
  });

  it('stores exactly the keys with the verdict "content", plus the capability switches', () => {
    const contentKeys = Object.keys(USER_APP_FIELD_POLICY).filter(
      key => USER_APP_FIELD_POLICY[key] === 'content'
    );
    assert.deepEqual(
      [...USER_APP_CONTENT_KEYS].sort(),
      [...contentKeys, 'preferredModel', 'capabilities'].sort()
    );
  });
});

describe('the copied defaults equal those of newAppDefaults()', () => {
  const defaults = newAppDefaults('en');

  it('personalAppBase copies the type, the chat history switch and the input mode', () => {
    const base = personalAppBase(PERSONAL_ID);
    assert.equal(base.id, PERSONAL_ID);
    assert.equal(base.type, defaults.type);
    assert.equal(base.sendChatHistory, defaults.sendChatHistory);
    assert.equal(base.allowEmptyContent, defaults.allowEmptyContent);
    assert.deepEqual(base.inputMode, defaults.inputMode);
    assert.equal(base.enabled, true);
    assert.deepEqual(base.features, { projects: false, userProjects: false });
  });

  it('the upload object for "on" has the sizes and formats of the defaults, switched on', () => {
    const on = structuredClone(defaults.upload);
    on.enabled = true;
    on.imageUpload.enabled = true;
    on.fileUpload.enabled = true;
    assert.deepEqual(PERSONAL_UPLOAD_ON, on);
    assert.deepEqual(PERSONAL_UPLOAD_OFF, { enabled: false });
  });
});

describe('appConfigSchema refuses an ID of the personal shape', () => {
  const app = id => ({
    id,
    name: { en: 'Chat helper' },
    description: { en: 'Answers questions' },
    color: '#4F46E5',
    icon: 'chat-bubbles',
    system: { en: 'You are a helpful assistant.' }
  });

  it('refuses the shape the server mints', () => {
    assert.equal(isUserAppId(PERSONAL_ID), true);
    const parsed = appConfigSchema.safeParse(app(PERSONAL_ID));
    assert.equal(parsed.success, false);
    assert.deepEqual(
      parsed.error.issues.map(issue => [issue.path.join('.'), issue.message]),
      [['id', 'This ID is reserved for personal apps']]
    );
  });

  it('accepts an ID that only starts with the prefix, or is one character longer or shorter', () => {
    assert.equal(appConfigSchema.safeParse(app('uap_helper')).success, true);
    assert.equal(appConfigSchema.safeParse(app(`${PERSONAL_ID}0`)).success, true);
    assert.equal(appConfigSchema.safeParse(app(PERSONAL_ID.slice(0, -1))).success, true);
  });
});

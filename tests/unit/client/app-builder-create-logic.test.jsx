// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The parts of the "New app" page that need no screen: the state between the
 * two screens and what the tab keeps of it (`draftState.js`), what each start
 * hands over and what the create request carries (`createFlow.js`), the
 * checks before the request and the reading of the server's answer
 * (`createErrors.js`), the keys picked by a value (`createKeys.js`), and the
 * name of a copy in every language of its source (`copyLanguages.js`).
 *
 * The last block checks the files of the slice themselves: their size, their
 * colour classes, and that no reusable part names a path or carries fallback
 * text.
 */

import fs from 'fs';
import path from 'path';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import emailTemplate from '../../../server/appTemplates/email-composer.json';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { newAppDefaults } from '../../../shared/appDefaults.js';
import { APP_CREATE_ORIGINS } from '../../../shared/appGenerator.js';
import {
  COPY_NAME_KEY,
  copyLabelWith,
  copyLanguagesToLoad,
  loadCopyLanguages
} from '../../../client/src/features/admin/components/app-create/copyLanguages.js';
import {
  CREATE_ERROR_KEYS,
  idError,
  isLinkDraft,
  isWebAddress,
  linkUrlOf,
  readCreateFailure,
  validateDraft
} from '../../../client/src/features/admin/components/app-create/createErrors.js';
import {
  beginBlank,
  beginCopy,
  beginGenerated,
  beginLink,
  beginTemplate,
  derivedAppId,
  fieldsLosingLanguages,
  modelDisplayName,
  payloadFromState,
  pickDraftModel
} from '../../../client/src/features/admin/components/app-create/createFlow.js';
import {
  DETAIL_FIELDS,
  FIELD_LABEL_KEYS,
  FIELD_ORDER,
  HEADING_KEYS,
  NOTE_KEYS,
  SCREENS,
  START_KINDS,
  STEP_KEYS,
  fieldDomId
} from '../../../client/src/features/admin/components/app-create/createKeys.js';
import {
  INITIAL_EXTRAS,
  draftReducer,
  initialDraftState,
  parseDraftState,
  serializeDraftState
} from '../../../client/src/features/admin/components/app-create/draftState.js';

const lookup = (locale, key) =>
  key
    .split('.')
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), locale);

/** The state after a start, as the page's reducer builds it. */
const begun = start => draftReducer(initialDraftState(), { type: 'begin', ...start });

/** A failed request as axios rejects it. */
const problem = (status, data) => ({ response: { status, data } });

const SOURCE_APP = {
  ...newAppDefaults('en'),
  id: 'travel-policy',
  order: 4,
  name: { en: 'Travel policy', de: 'Reiserichtlinie' },
  description: { en: 'Answers travel questions.', de: 'Beantwortet Reisefragen.' },
  system: { en: 'You answer travel questions.', de: 'Sie beantworten Reisefragen.' },
  enabled: true,
  parentId: 'chat',
  inheritanceLevel: 2,
  overriddenFields: ['system']
};

describe('keys picked by a value', () => {
  it('every start is a value the create request may name as origin', () => {
    for (const start of START_KINDS) {
      expect(APP_CREATE_ORIGINS).toContain(start);
    }
    // "upload" is the list's own start; the page has no screen for it.
    expect(START_KINDS).not.toContain('upload');
  });

  it('every start has a heading and an entry for its notice; every screen has a step name', () => {
    expect(Object.keys(HEADING_KEYS).sort()).toEqual([...START_KINDS].sort());
    expect(Object.keys(NOTE_KEYS).sort()).toEqual([...START_KINDS].sort());
    expect(Object.keys(STEP_KEYS)).toEqual([...SCREENS]);
    expect(NOTE_KEYS.template).not.toBe(NOTE_KEYS.copy);
    expect(NOTE_KEYS.blank).toBeNull();
  });

  it.each([
    ['STEP_KEYS', STEP_KEYS],
    ['HEADING_KEYS', HEADING_KEYS],
    ['NOTE_KEYS', NOTE_KEYS],
    ['FIELD_LABEL_KEYS', FIELD_LABEL_KEYS],
    ['CREATE_ERROR_KEYS', CREATE_ERROR_KEYS]
  ])('every key of %s is a text in English and German', (_name, map) => {
    for (const key of Object.values(map).filter(Boolean)) {
      for (const locale of [en, de]) {
        const text = lookup(locale, key) ?? lookup(locale, `${key}_other`);
        expect(typeof text === 'string' && text.trim() !== '').toBe(true);
      }
    }
  });

  it('every field has a label, an order and a DOM id', () => {
    expect([...FIELD_ORDER].sort()).toEqual(Object.keys(FIELD_LABEL_KEYS).sort());
    expect(DETAIL_FIELDS.every(field => FIELD_ORDER.includes(field))).toBe(true);
    expect(fieldDomId('name')).toBe('app-create-name');
  });
});

describe('which model drafts', () => {
  const chat = { id: 'a', name: { en: 'Alpha', de: 'Alfa' } };
  const standard = { id: 'b', name: 'Beta', default: true };

  it('takes the standard chat model, else the first chat model', () => {
    expect(pickDraftModel([chat, standard])).toBe(standard);
    expect(pickDraftModel([chat])).toBe(chat);
  });

  it('leaves out models that cannot answer a one-off request', () => {
    expect(
      pickDraftModel([
        { id: 'img', default: true, supportsImageGeneration: true },
        { id: 'voice', modelType: 'transcription' },
        { id: 'ia', provider: 'iAssistant-Conversation' }
      ])
    ).toBeNull();
    expect(pickDraftModel([])).toBeNull();
    expect(pickDraftModel(null)).toBeNull();
    expect(pickDraftModel(undefined)).toBeNull();
  });

  it("names a model in the author's language, else by its ID", () => {
    expect(modelDisplayName(chat, 'de')).toBe('Alfa');
    expect(modelDisplayName(standard, 'de')).toBe('Beta');
    expect(modelDisplayName({ id: 'x' }, 'en')).toBe('x');
    expect(modelDisplayName(null, 'en')).toBeNull();
  });
});

describe('what each start hands to the Essentials screen', () => {
  it('empty: the defaults of a new app in one language, without an ID', () => {
    const start = beginBlank({ language: 'de' });
    expect(start).toMatchObject({ start: 'blank', language: 'de' });
    expect(start.draft).toEqual(newAppDefaults('de'));
    expect(start.draft.enabled).toBe(false);
  });

  it('link: a link app that opens a website, without instructions', () => {
    const start = beginLink({ language: 'en' });
    expect(start.start).toBe('link');
    expect(start.draft.type).toBe('redirect');
    expect(start.draft).not.toHaveProperty('system');
    expect(isLinkDraft(start.draft)).toBe(true);
  });

  it("template: one language, a free ID, the template's name for the notice", () => {
    const { id, ...app } = emailTemplate;
    const item = { id, name: emailTemplate.name, description: emailTemplate.description, app };
    const start = beginTemplate(item, {
      language: 'de',
      isTaken: taken => taken === 'e-mail-verfasser'
    });
    expect(start.start).toBe('template');
    expect(start.source).toEqual({ id: 'email-composer', name: 'E-Mail-Verfasser' });
    expect(start.draft.name).toEqual({ de: 'E-Mail-Verfasser' });
    expect(start.draft.id).toBe('e-mail-verfasser-2');
  });

  it("copy: every language, no lineage, the language the author edits, the source's name", () => {
    const start = beginCopy(SOURCE_APP, {
      uiLanguage: 'de-DE',
      platformDefault: 'en',
      isTaken: () => false,
      copyLabel: (name, language) => `${name} (${language === 'de' ? 'Kopie' : 'copy'})`
    });
    expect(start.start).toBe('copy');
    expect(start.language).toBe('de');
    expect(start.source).toEqual({
      id: 'travel-policy',
      name: 'Reiserichtlinie',
      noInstructions: false
    });
    expect(start.draft.name).toEqual({ en: 'Travel policy (copy)', de: 'Reiserichtlinie (Kopie)' });
    expect(start.draft.id).toBe('reiserichtlinie-kopie');
    expect(start.draft.enabled).toBe(false);
    for (const key of ['parentId', 'inheritanceLevel', 'overriddenFields', 'order']) {
      expect(start.draft).not.toHaveProperty(key);
    }
    // The source is not touched.
    expect(SOURCE_APP.parentId).toBe('chat');
    expect(SOURCE_APP.name.en).toBe('Travel policy');
  });

  it('copy: a text stored as a plain string becomes the text of the edited language', () => {
    const start = beginCopy(
      { id: 'old', name: 'Old app', description: 'An old app.', system: 'Be helpful.' },
      { uiLanguage: 'en' }
    );
    expect(start.language).toBe('en');
    expect(start.draft.name).toEqual({ en: 'Old app' });
    expect(start.draft.system).toEqual({ en: 'Be helpful.' });
    expect(start.source.noInstructions).toBe(false);
  });

  it('copy: notes an app without instructions', () => {
    const { system, ...plain } = SOURCE_APP;
    void system;
    expect(beginCopy(plain, { uiLanguage: 'en' }).source.noInstructions).toBe(true);
    expect(
      beginCopy({ ...plain, system: { en: '  ' } }, { uiLanguage: 'en' }).source.noInstructions
    ).toBe(true);
  });

  it('copy: a text the source lacks in the edited language starts from the text users get', () => {
    // The shape of the shipped app `idea-coach`: instructions in English only.
    const source = {
      ...SOURCE_APP,
      description: { fr: 'Répond aux questions.', de: '' },
      system: { en: 'You answer questions about travel.' }
    };
    const start = beginCopy(source, { uiLanguage: 'de-DE', platformDefault: 'en' });
    expect(start.language).toBe('de');
    expect(start.draft.system).toEqual({
      en: 'You answer questions about travel.',
      de: 'You answer questions about travel.'
    });
    // No English text: the first language that has one.
    expect(start.draft.description.de).toBe('Répond aux questions.');

    let state = begun(start);
    expect(state.edited).toEqual([]);
    expect(validateDraft(state.draft, { language: state.language, isTaken: () => false })).toEqual(
      {}
    );
    // Untouched, the copy keeps the source's own text.
    expect(fieldsLosingLanguages(state)).toEqual([]);
    expect(payloadFromState(state).system.en).toBe('You answer questions about travel.');

    // Rewritten, the text the author saw is replaced in every language.
    state = draftReducer(state, { type: 'text', field: 'system', value: 'Neu.' });
    expect(fieldsLosingLanguages(state)).toEqual(['system']);
    expect(payloadFromState(state).system).toEqual({ de: 'Neu.' });
  });

  it("AI draft: the server's app as it is, with the answer kept beside it", () => {
    const result = {
      app: { ...newAppDefaults('de'), id: 'x', name: { de: 'X' } },
      suggestions: { websearch: true }
    };
    const start = beginGenerated(result, { description: 'An app.', language: 'de' });
    expect(start).toMatchObject({ start: 'generated', language: 'de', description: 'An app.' });
    expect(start.draft).toEqual(result.app);
    expect(start.draft).not.toBe(result.app);
    expect(start.generated).toBe(result);
  });

  it('the app ID follows the name, and there is none without a name', () => {
    expect(derivedAppId('Plain-language summary', () => false)).toBe('plain-language-summary');
    expect(derivedAppId('Chat', id => id === 'chat')).toBe('chat-2');
    expect(derivedAppId('要約', () => false)).toBe('app');
    expect(derivedAppId('', () => false)).toBe('');
    expect(derivedAppId('   ', () => false)).toBe('');
  });
});

describe('the name of a copy in every language of its source', () => {
  /** A UI as the browser has it: the texts of its own language only, until another is loaded. */
  async function uiWith(languages) {
    const all = { en: { translation: en }, de: { translation: de } };
    const instance = i18next.createInstance();
    await instance.init({
      lng: languages[0],
      fallbackLng: 'en',
      resources: Object.fromEntries(
        ['en', 'de'].map(lng => [lng, languages.includes(lng) ? all[lng] : { translation: {} }])
      ),
      interpolation: { escapeValue: false }
    });
    const loadLanguage = jest.fn(async lng => {
      if (all[lng])
        instance.addResourceBundle(lng, 'translation', all[lng].translation, true, true);
    });
    return { i18n: instance, loadLanguage };
  }

  it('is a text in both languages', () => {
    expect(lookup(en, COPY_NAME_KEY)).toBe('{{name}} (copy)');
    expect(lookup(de, COPY_NAME_KEY)).toBe('{{name}} (Kopie)');
  });

  it('needs nothing loaded when the UI holds every language of the name', async () => {
    const { i18n, loadLanguage } = await uiWith(['en', 'de']);
    expect(copyLanguagesToLoad(SOURCE_APP, i18n)).toEqual([]);
    // Null, not a promise: the copy opens at once.
    expect(loadCopyLanguages(SOURCE_APP, { i18n, loadLanguage })).toBeNull();
    expect(loadLanguage).not.toHaveBeenCalled();
  });

  it('an English UI loads German for a name that has a German version', async () => {
    const { i18n, loadLanguage } = await uiWith(['en']);
    const label = copyLabelWith(i18n.t.bind(i18n));
    // Before: the fallback language answers, which is the defect this module prevents.
    expect(label('Reiserichtlinie', 'de')).toBe('Reiserichtlinie (copy)');
    expect(copyLanguagesToLoad(SOURCE_APP, i18n)).toEqual(['de']);

    await loadCopyLanguages(SOURCE_APP, { i18n, loadLanguage });
    expect(loadLanguage.mock.calls).toEqual([['de']]);
    expect(label('Reiserichtlinie', 'de')).toBe('Reiserichtlinie (Kopie)');
    expect(label('Travel policy', 'en')).toBe('Travel policy (copy)');
    expect(copyLanguagesToLoad(SOURCE_APP, i18n)).toEqual([]);

    const start = beginCopy(SOURCE_APP, { uiLanguage: 'en', copyLabel: label });
    expect(start.draft.name).toEqual({ en: 'Travel policy (copy)', de: 'Reiserichtlinie (Kopie)' });
  });

  it('a name stored as plain text, or no name, needs no language', async () => {
    const { i18n } = await uiWith(['en']);
    expect(copyLanguagesToLoad({ name: 'Old app' }, i18n)).toEqual([]);
    expect(copyLanguagesToLoad({}, i18n)).toEqual([]);
    expect(copyLanguagesToLoad(null, i18n)).toEqual([]);
  });

  it('a language that cannot be loaded does not stop the copy', async () => {
    const { i18n } = await uiWith(['en']);
    const failing = jest.fn(() => {
      throw new Error('offline');
    });
    await expect(
      loadCopyLanguages(SOURCE_APP, { i18n, loadLanguage: failing })
    ).resolves.toBeUndefined();
    const rejecting = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(
      loadCopyLanguages(SOURCE_APP, { i18n, loadLanguage: rejecting })
    ).resolves.toBeUndefined();
    // The fallback language names the copy.
    expect(copyLabelWith(i18n.t.bind(i18n))('Reiserichtlinie', 'de')).toBe(
      'Reiserichtlinie (copy)'
    );
  });

  it('does not wait longer than it was told for a language that never arrives', async () => {
    const { i18n } = await uiWith(['en']);
    const never = jest.fn(() => new Promise(() => {}));
    const started = Date.now();
    await loadCopyLanguages(SOURCE_APP, { i18n, loadLanguage: never, waitMs: 20 });
    expect(never).toHaveBeenCalledWith('de');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('state of the page', () => {
  const blank = () => begun(beginBlank({ language: 'en' }));

  it('starts on the Start screen with nothing ticked and nothing edited', () => {
    const state = initialDraftState();
    expect(state).toMatchObject({ screen: 'start', start: null, draft: null, dirty: false });
    expect(state.extras).toEqual({ inputFields: true, webSearch: false, integrationIds: [] });
    expect(INITIAL_EXTRAS.webSearch).toBe(false);
  });

  it('a start opens Essentials clean; the description stays', () => {
    const described = draftReducer(initialDraftState(), { type: 'describe', description: 'Text' });
    const state = draftReducer(described, { type: 'begin', ...beginBlank({ language: 'en' }) });
    expect(state).toMatchObject({ screen: 'essentials', start: 'blank', language: 'en' });
    expect(state.description).toBe('Text');
    expect(state.dirty).toBe(false);
    expect(state.edited).toEqual([]);
    // Typing a description is not a change of the app.
    expect(described.dirty).toBe(false);
  });

  it("a text is stored in the screen's language and counts as an edit", () => {
    const state = draftReducer(blank(), {
      type: 'text',
      field: 'name',
      value: 'My app',
      id: 'my-app'
    });
    expect(state.draft.name).toEqual({ en: 'My app' });
    expect(state.draft.id).toBe('my-app');
    expect(state.edited).toEqual(['name']);
    expect(state.dirty).toBe(true);
    // Twice the same field is one entry.
    const again = draftReducer(state, {
      type: 'text',
      field: 'name',
      value: 'My apps',
      id: 'my-apps'
    });
    expect(again.edited).toEqual(['name']);
  });

  it('the ID stops following the name once the author edits it', () => {
    let state = draftReducer(blank(), { type: 'id', value: 'chosen', touched: true });
    expect(state.idTouched).toBe(true);
    state = draftReducer(state, { type: 'text', field: 'name', value: 'Other', id: 'other' });
    expect(state.draft.id).toBe('chosen');
    // An ID the page derives never overrides the author's.
    state = draftReducer(state, { type: 'id', value: 'derived', touched: false });
    expect(state.draft.id).toBe('chosen');
  });

  it('an ID the page derived is not an edit', () => {
    const state = draftReducer(blank(), { type: 'id', value: 'derived', touched: false });
    expect(state.draft.id).toBe('derived');
    expect(state.dirty).toBe(false);
    expect(state.idTouched).toBe(false);
  });

  it('icon, colour and category are edits; unknown fields are ignored', () => {
    const state = draftReducer(blank(), { type: 'meta', field: 'color', value: '#DC2626' });
    expect(state.draft.color).toBe('#DC2626');
    expect(state.edited).toEqual(['color']);
    const same = draftReducer(state, { type: 'meta', field: 'enabled', value: true });
    expect(same).toBe(state);
    expect(draftReducer(state, { type: 'text', field: 'prompt', value: 'x' })).toBe(state);
  });

  it('a link app keeps its address when the way it opens changes', () => {
    let state = begun(beginLink({ language: 'en' }));
    state = draftReducer(state, { type: 'link', url: 'https://example.org' });
    expect(linkUrlOf(state.draft)).toBe('https://example.org');
    expect(state.edited).toEqual(['url']);
    state = draftReducer(state, { type: 'link', mode: 'iframe' });
    expect(state.draft.type).toBe('iframe');
    expect(state.draft.iframeConfig.url).toBe('https://example.org');
    expect(state.draft).not.toHaveProperty('redirectConfig');
    state = draftReducer(state, { type: 'link', mode: 'redirect' });
    expect(state.draft.redirectConfig.url).toBe('https://example.org');
    expect(state.draft).not.toHaveProperty('iframeConfig');
    // A chat app has no address.
    expect(
      draftReducer(blank(), { type: 'link', url: 'https://x.example' }).draft
    ).not.toHaveProperty('redirectConfig');
  });

  it('ticking a suggestion is a change; Back keeps the description; reset keeps nothing', () => {
    let state = draftReducer(blank(), { type: 'describe', description: 'Text' });
    state = draftReducer(state, { type: 'extras', extras: { webSearch: true } });
    expect(state.extras).toEqual({ inputFields: true, webSearch: true, integrationIds: [] });
    expect(state.dirty).toBe(true);
    const back = draftReducer(state, { type: 'back' });
    expect(back).toMatchObject({ screen: 'start', draft: null, description: 'Text', dirty: false });
    expect(back.extras.webSearch).toBe(false);
    expect(draftReducer(state, { type: 'reset' })).toEqual(initialDraftState());
  });

  it('no action modifies the state it was given', () => {
    const state = blank();
    const frozen = JSON.stringify(state);
    draftReducer(state, { type: 'text', field: 'name', value: 'A', id: 'a' });
    draftReducer(state, { type: 'meta', field: 'icon', value: 'star' });
    draftReducer(state, { type: 'extras', extras: { integrationIds: ['jira'] } });
    expect(JSON.stringify(state)).toBe(frozen);
  });
});

describe('what the tab keeps', () => {
  it('keeps nothing for an untouched Start screen', () => {
    expect(serializeDraftState(initialDraftState())).toBeNull();
    expect(
      serializeDraftState(
        draftReducer(initialDraftState(), { type: 'describe', description: '  ' })
      )
    ).toBeNull();
  });

  it('brings back a description and an Essentials screen, marked as restored', () => {
    const described = draftReducer(initialDraftState(), { type: 'describe', description: 'Text' });
    expect(parseDraftState(serializeDraftState(described))).toEqual({
      ...described,
      restored: true
    });

    let state = begun(beginBlank({ language: 'de' }));
    state = draftReducer(state, {
      type: 'text',
      field: 'name',
      value: 'Meine App',
      id: 'meine-app'
    });
    const restored = parseDraftState(serializeDraftState(state));
    expect(restored).toEqual({ ...state, restored: true });
    // A later start is no longer "restored".
    expect(draftReducer(restored, { type: 'back' }).restored).toBe(false);
  });

  it.each([
    ['nothing', null],
    ['no JSON', '{oops'],
    ['another version', JSON.stringify({ version: 0, state: initialDraftState() })],
    [
      'an unknown screen',
      JSON.stringify({ version: 1, state: { screen: 'other', description: '' } })
    ],
    [
      'Essentials without a draft',
      JSON.stringify({
        version: 1,
        state: { screen: 'essentials', description: '', start: 'blank', language: 'en' }
      })
    ],
    [
      'an unknown start',
      JSON.stringify({
        version: 1,
        state: { screen: 'essentials', description: '', start: 'upload', language: 'en', draft: {} }
      })
    ],
    [
      'an array as draft',
      JSON.stringify({
        version: 1,
        state: { screen: 'essentials', description: '', start: 'blank', language: 'en', draft: [] }
      })
    ]
  ])('ignores %s', (_case, text) => {
    expect(parseDraftState(text)).toBeNull();
  });

  it('repairs what a stored entry leaves out and drops keys it does not know', () => {
    const text = JSON.stringify({
      version: 1,
      state: {
        screen: 'essentials',
        start: 'blank',
        language: 'en',
        description: '',
        draft: { id: 'x' },
        extras: { webSearch: true, integrationIds: 'jira' },
        edited: ['name', 3],
        injected: '<script>'
      }
    });
    const state = parseDraftState(text);
    expect(state).not.toHaveProperty('injected');
    expect(state.extras).toEqual({ inputFields: true, webSearch: true, integrationIds: [] });
    expect(state.edited).toEqual(['name']);
    expect(state.idTouched).toBe(false);
  });
});

describe('the body of the create request', () => {
  const filled = start => {
    let state = begun(start);
    state = draftReducer(state, { type: 'text', field: 'name', value: 'My app', id: 'my-app' });
    state = draftReducer(state, { type: 'text', field: 'description', value: 'Does a thing.' });
    return draftReducer(state, { type: 'text', field: 'system', value: 'You do a thing.' });
  };

  it('empty start: one language, not published, valid for the server', () => {
    const payload = payloadFromState(filled(beginBlank({ language: 'de' })));
    expect(payload.name).toEqual({ de: 'My app' });
    expect(payload.enabled).toBe(false);
    expect(appConfigSchema.safeParse(payload).success).toBe(true);
  });

  it("carries no key of the page's own state", () => {
    const state = filled(beginBlank({ language: 'en' }));
    const payload = payloadFromState(state);
    // `description` is both: the page's text for the AI, and the app's short description.
    for (const key of Object.keys(initialDraftState()).filter(key => key !== 'description')) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(payload.description).toEqual({ en: 'Does a thing.' });
  });

  it('AI draft: only what the author ticked is bound', () => {
    const result = {
      app: {
        ...newAppDefaults('en'),
        id: 'helper',
        name: { en: 'Helper' },
        description: { en: 'Helps.' },
        system: { en: 'You help.' },
        prompt: { en: 'Tone: {{tone}}\n\n{{content}}' },
        allowEmptyContent: true,
        variables: [{ name: 'tone', label: { en: 'Tone' }, type: 'string', required: false }],
        // Whatever the answer carries, nothing is bound without a tick.
        websearch: { enabled: true },
        integrations: { jira: {} }
      },
      suggestions: {
        websearch: true,
        integrations: [
          { id: 'jira', label: 'Jira', actions: ['searchIssues'] },
          { id: 'wiki', label: 'Wiki', actions: [] }
        ]
      }
    };
    let state = begun(beginGenerated(result, { description: 'Help.', language: 'en' }));
    const plain = payloadFromState(state);
    expect(plain).not.toHaveProperty('websearch');
    expect(plain).not.toHaveProperty('integrations');
    expect(plain.variables).toHaveLength(1);

    state = draftReducer(state, {
      type: 'extras',
      extras: { integrationIds: ['wiki', 'unknown'] }
    });
    expect(payloadFromState(state).integrations).toEqual({ wiki: {} });
    expect(payloadFromState(state)).not.toHaveProperty('websearch');

    state = draftReducer(state, {
      type: 'extras',
      extras: { inputFields: false, webSearch: true }
    });
    const stripped = payloadFromState(state);
    expect(stripped.websearch).toEqual({ enabled: true });
    expect(stripped.variables).toEqual([]);
    expect(JSON.stringify(stripped.prompt ?? {})).not.toContain('{{tone}}');
    expect(stripped.allowEmptyContent).toBe(false);
    expect(appConfigSchema.safeParse(stripped).success).toBe(true);
  });

  it('copy: a changed text loses its other languages, an untouched one keeps them', () => {
    let state = begun(beginCopy(SOURCE_APP, { uiLanguage: 'en', copyLabel: '(copy)' }));
    expect(fieldsLosingLanguages(state)).toEqual([]);
    expect(Object.keys(payloadFromState(state).system).sort()).toEqual(['de', 'en']);

    state = draftReducer(state, {
      type: 'text',
      field: 'system',
      value: 'You answer new questions.'
    });
    expect(fieldsLosingLanguages(state)).toEqual(['system']);
    const payload = payloadFromState(state);
    expect(payload.system).toEqual({ en: 'You answer new questions.' });
    expect(Object.keys(payload.name).sort()).toEqual(['de', 'en']);
    expect(payload).not.toHaveProperty('parentId');
    expect(payload.enabled).toBe(false);
  });

  it('only a copy loses languages, and only where another language has text', () => {
    const blank = filled(beginBlank({ language: 'en' }));
    expect(fieldsLosingLanguages(blank)).toEqual([]);
    const oneLanguage = begun(
      beginCopy({ ...SOURCE_APP, system: { en: 'Only English.' } }, { uiLanguage: 'en' })
    );
    const edited = draftReducer(oneLanguage, { type: 'text', field: 'system', value: 'Changed.' });
    expect(fieldsLosingLanguages(edited)).toEqual([]);
    expect(fieldsLosingLanguages(initialDraftState())).toEqual([]);
  });

  it('refuses an ID a route shadows', () => {
    const state = draftReducer(filled(beginBlank({ language: 'en' })), {
      type: 'id',
      value: 'new',
      touched: true
    });
    expect(() => payloadFromState(state)).toThrow(
      expect.objectContaining({ code: 'APP_ID_INVALID' })
    );
  });
});

describe('checks before the request', () => {
  const draft = overrides => ({
    ...newAppDefaults('en'),
    id: 'my-app',
    name: { en: 'My app' },
    description: { en: 'Does a thing.' },
    system: { en: 'You do a thing.' },
    ...overrides
  });

  it('accepts a complete draft', () => {
    expect(validateDraft(draft(), { language: 'en', isTaken: () => false })).toEqual({});
  });

  it('requires name, short description and instructions in the edited language', () => {
    const errors = validateDraft(
      draft({
        name: { en: ' ', de: 'Name' },
        description: { en: '' },
        system: { de: 'Anweisung' }
      }),
      { language: 'en' }
    );
    expect(errors.name.key).toBe(CREATE_ERROR_KEYS.nameRequired);
    expect(errors.description.key).toBe(CREATE_ERROR_KEYS.descriptionRequired);
    expect(errors.system.key).toBe(CREATE_ERROR_KEYS.instructionsRequired);
  });

  it('lets a copy of an app without instructions stay without them', () => {
    const noSystem = draft({ system: undefined });
    expect(validateDraft(noSystem, { language: 'en' }).system).toBeDefined();
    expect(
      validateDraft(noSystem, { language: 'en', instructionsOptional: true }).system
    ).toBeUndefined();
  });

  it('a link app needs a full http(s) address instead of instructions', () => {
    const link = {
      ...beginLink({ language: 'en' }).draft,
      id: 'l',
      name: { en: 'L' },
      description: { en: 'D' }
    };
    expect(validateDraft(link, { language: 'en' }).url.key).toBe(CREATE_ERROR_KEYS.urlFormat);
    expect(validateDraft(link, { language: 'en' })).not.toHaveProperty('system');
    link.redirectConfig = { ...link.redirectConfig, url: 'https://example.org/x' };
    expect(validateDraft(link, { language: 'en' })).toEqual({});
  });

  it.each([
    ['https://example.org', true],
    ['http://intranet/start', true],
    ['  https://example.org  ', true],
    ['example.org', false],
    ['ftp://example.org', false],
    ['javascript:alert(1)', false],
    ['https://', false],
    ['https://exa mple.org', false],
    ['', false],
    [undefined, false]
  ])('isWebAddress(%p) is %p', (value, expected) => {
    expect(isWebAddress(value)).toBe(expected);
  });

  it.each([
    ['', CREATE_ERROR_KEYS.idRequired],
    ['a'.repeat(51), CREATE_ERROR_KEYS.idTooLong],
    ['My App', CREATE_ERROR_KEYS.idFormat],
    ['new', CREATE_ERROR_KEYS.idReserved],
    ['templates', CREATE_ERROR_KEYS.idReserved],
    ['_toggle', CREATE_ERROR_KEYS.idReserved],
    ['chat', CREATE_ERROR_KEYS.idTaken]
  ])('the ID %p gives %s', (id, key) => {
    expect(idError(id, { isTaken: taken => taken === 'chat' }).key).toBe(key);
  });

  it('gives the format message an example made from the name', () => {
    expect(idError('My App', { name: 'My App' }).values.example).toBe('my-app');
    expect(idError('??', {}).values.example).toBe('my-app');
    expect(idError('free-id', { isTaken: () => false })).toBeNull();
    // Without a list of apps nothing is known to be taken.
    expect(idError('chat', {})).toBeNull();
  });

  it('says nothing about a missing ID while it follows a missing name', () => {
    const empty = draft({ id: '', name: { en: '' } });
    expect(validateDraft(empty, { language: 'en', idFollowsName: true })).not.toHaveProperty('id');
    expect(validateDraft(empty, { language: 'en' }).id.key).toBe(CREATE_ERROR_KEYS.idRequired);
    // An ID the author emptied is theirs to fill in.
    expect(validateDraft(draft({ id: '' }), { language: 'en', idFollowsName: true }).id.key).toBe(
      CREATE_ERROR_KEYS.idRequired
    );
  });
});

describe('reading a failed create request', () => {
  it('no answer: the server cannot be reached', () => {
    expect(readCreateFailure(new Error('Network Error'))).toEqual({
      conflict: false,
      fields: {},
      general: { key: CREATE_ERROR_KEYS.offline, values: {} }
    });
  });

  it('409 or CONFLICT: the ID is taken', () => {
    for (const error of [problem(409, {}), problem(400, { code: 'CONFLICT' })]) {
      const failure = readCreateFailure(error, { id: 'chat' });
      expect(failure.conflict).toBe(true);
      expect(failure.fields.id).toEqual({ key: CREATE_ERROR_KEYS.idTaken, values: { id: 'chat' } });
      expect(failure.general).toBeNull();
    }
  });

  it('401 and 403: not allowed', () => {
    for (const status of [401, 403]) {
      expect(readCreateFailure(problem(status, { code: 'FORBIDDEN' })).general.key).toBe(
        CREATE_ERROR_KEYS.forbidden
      );
    }
  });

  it('400 with pointers: marks the fields and names them by label, other paths as they are', () => {
    const failure = readCreateFailure(
      problem(400, {
        code: 'VALIDATION_FAILED',
        detail: 'Invalid app configuration: name.en: Too big',
        errors: [
          { pointer: '/name/en', message: 'Too big' },
          { pointer: '/name/de', message: 'Too big' },
          { pointer: '/redirectConfig/url', message: 'Invalid' },
          { pointer: '/upload/fileUpload/maxFileSizeMB', message: 'Too big' }
        ]
      }),
      { labelOf: field => ({ name: 'Name', url: 'Website address' })[field] }
    );
    expect(failure.conflict).toBe(false);
    expect(failure.fields).toEqual({
      name: { key: null, values: {} },
      url: { key: null, values: {} }
    });
    expect(failure.general).toEqual({
      key: CREATE_ERROR_KEYS.validation,
      values: { fields: 'Name, Website address, upload.fileUpload.maxFileSizeMB' }
    });
  });

  it('400 with details.issues: the same reading', () => {
    const failure = readCreateFailure(
      problem(400, { details: { issues: [{ path: 'system.en', message: 'Too big' }] } })
    );
    expect(failure.fields).toEqual({ system: { key: null, values: {} } });
    expect(failure.general.values.fields).toBe('system');
  });

  it('never decides by a message text', () => {
    const failure = readCreateFailure(
      problem(500, { code: 'INTERNAL_ERROR', detail: 'App with this ID already exists' })
    );
    expect(failure.conflict).toBe(false);
    expect(failure.general).toEqual({
      key: CREATE_ERROR_KEYS.unknown,
      values: { detail: 'App with this ID already exists' }
    });
  });

  it("anything else: the server's own sentence, through the caller's reader when given", () => {
    expect(
      readCreateFailure(problem(400, { code: 'BAD_REQUEST', detail: 'Missing required fields' }))
        .general
    ).toEqual({
      key: CREATE_ERROR_KEYS.unknown,
      values: { detail: 'Missing required fields' }
    });
    expect(
      readCreateFailure(problem(500, {}), { detailOf: () => 'Übersetzt.' }).general.values.detail
    ).toBe('Übersetzt.');
    expect(readCreateFailure(problem(500, {})).general.values.detail).toBe('');
  });
});

describe('the files of the slice', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const CREATE_DIR = path.join(ROOT, 'client/src/features/admin/components/app-create');
  // The describe start belongs to another slice and has a test of its own.
  const FOREIGN = ['DescribeStart.jsx', 'DraftExtras.jsx', 'generateErrors.js'];
  const parts = fs
    .readdirSync(CREATE_DIR)
    .filter(name => /\.(js|jsx)$/.test(name) && !FOREIGN.includes(name))
    .map(name => path.join(CREATE_DIR, name));
  const page = path.join(ROOT, 'client/src/features/admin/pages/AdminAppCreatePage.jsx');
  const all = [...parts, page];
  const read = file => fs.readFileSync(file, 'utf8');
  const name = file => path.relative(ROOT, file);

  it('finds them', () => {
    expect(parts.length).toBeGreaterThan(15);
  });

  it('no file has more than 300 lines', () => {
    const long = all.filter(file => read(file).split('\n').length > 301).map(name);
    expect(long).toEqual([]);
  });

  it('no file uses purple or green-700', () => {
    const offenders = all.filter(file => /purple|green-700/.test(read(file))).map(name);
    expect(offenders).toEqual([]);
  });

  it('every text colour of a new component has its dark variant', () => {
    const offenders = [];
    for (const file of all.filter(file => file.endsWith('.jsx') || file.endsWith('Styles.js'))) {
      for (const literal of read(file).match(/(['"`])(?:(?!\1)[^\\\n]|\\.)*\1/g) || []) {
        const light =
          /(?:^|[\s'"`])(?:text|bg|border)-(?:gray|red|amber|green|blue|indigo)-\d{2,3}/.test(
            literal
          );
        if (light && !/dark:/.test(literal)) offenders.push(`${name(file)}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no reusable part names a path of the admin area or imports the admin API', () => {
    const offenders = parts
      .filter(file => /['"`]\/admin\b|api\/adminApi|makeAdminApiCall/.test(read(file)))
      .map(name);
    expect(offenders).toEqual([]);
  });

  it('no call of t() carries fallback text', () => {
    const offenders = all
      .filter(file => /\bt\(\s*(['"`])[\w.-]+\1\s*,\s*['"`]/.test(read(file)))
      .map(name);
    expect(offenders).toEqual([]);
  });

  it('nothing imports or mocks the deleted creation flow', () => {
    const sources = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) sources.push(full);
      }
    };
    walk(path.join(ROOT, 'client/src'));
    walk(path.join(ROOT, 'tests'));
    const self = path.resolve(__filename);
    const gone = /AppCreationWizard|AppTemplateSelector|appWizardPayload/;
    expect(sources.filter(file => file !== self && gone.test(read(file))).map(name)).toEqual([]);
    for (const file of [
      'client/src/features/apps/components/AppCreationWizard.jsx',
      'client/src/features/apps/components/AppTemplateSelector.jsx',
      'client/src/features/admin/utils/appWizardPayload.js'
    ]) {
      expect(fs.existsSync(path.join(ROOT, file))).toBe(false);
    }
  });

  it('the create route stands before the editor route, and "admin" is the only top-level segment', () => {
    const app = read(path.join(ROOT, 'client/src/App.jsx'));
    const create = app.indexOf(
      '<Route path="apps/new" element={<LazyAdminRoute component={AdminAppCreatePage} />} />'
    );
    const editor = app.indexOf(
      '<Route path="apps/:appId" element={<LazyAdminRoute component={AdminAppEditPage} />} />'
    );
    expect(create).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(-1);
    expect(create).toBeLessThan(editor);
    // Every entry point names the same page.
    for (const file of [
      'client/src/features/admin/components/AdminCommandPalette.jsx',
      'client/src/features/setup/SetupWizard.jsx',
      'client/src/features/admin/pages/AdminAppsPage.jsx'
    ]) {
      expect(read(path.join(ROOT, file))).toContain('/admin/apps/new');
    }
  });
});

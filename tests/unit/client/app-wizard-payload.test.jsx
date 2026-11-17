/**
 * The app creation wizard keeps its own UI state next to the app fields. The
 * server validates `POST /api/admin/apps` against the app schema, which allows
 * no unknown top-level keys, so the payload carries only app configuration.
 */
import {
  WIZARD_ONLY_KEYS,
  appCategoryOptions,
  buildAppPayloadFromWizard,
  wizardLanguage
} from '../../../client/src/features/admin/utils/appWizardPayload';

const wizardState = (extra = {}) => ({
  id: 'helper',
  name: { en: 'Helper' },
  description: { en: 'Answers questions' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  system: { en: 'You are a helpful assistant.' },
  messagePlaceholder: { en: '' },
  prompt: { en: '{{content}}' },
  parentId: null,
  inheritanceLevel: 0,
  overriddenFields: [],
  ...extra
});

describe('buildAppPayloadFromWizard', () => {
  test.each(WIZARD_ONLY_KEYS)('drops the wizard-only key %s', key => {
    const payload = buildAppPayloadFromWizard(wizardState({ [key]: true }));

    expect(payload).not.toHaveProperty(key);
  });

  test('drops the creation method and AI generation state together', () => {
    const payload = buildAppPayloadFromWizard(
      wizardState({
        useAI: true,
        useTemplate: false,
        useManual: false,
        aiGenerated: true,
        aiPrompt: 'An app that answers questions',
        imageUpload: { enabled: true }
      })
    );

    expect(Object.keys(payload).sort()).toEqual(
      [
        'color',
        'description',
        'icon',
        'id',
        'inheritanceLevel',
        'name',
        'overriddenFields',
        'prompt',
        'system'
      ].sort()
    );
  });

  test('drops a null parentId but keeps the template a copy is based on', () => {
    expect(buildAppPayloadFromWizard(wizardState())).not.toHaveProperty('parentId');
    expect(buildAppPayloadFromWizard(wizardState({ parentId: 'chat' })).parentId).toBe('chat');
  });

  test('drops empty languages from optional localized fields', () => {
    const payload = buildAppPayloadFromWizard(
      wizardState({ messagePlaceholder: { en: 'Ask me', de: '  ' }, prompt: { en: '', de: '' } })
    );

    expect(payload.messagePlaceholder).toEqual({ en: 'Ask me' });
    expect(payload).not.toHaveProperty('prompt');
  });

  test('does not modify the wizard state', () => {
    const state = wizardState({ useManual: true });
    const snapshot = JSON.parse(JSON.stringify(state));

    buildAppPayloadFromWizard(state);

    expect(state).toEqual(snapshot);
  });
});

describe('wizardLanguage', () => {
  test.each([
    ['de-DE', 'de'],
    ['en-US', 'en'],
    ['EN', 'en'],
    ['fr', 'fr'],
    [undefined, 'en'],
    ['', 'en']
  ])('%p → %p', (language, expected) => {
    expect(wizardLanguage(language)).toBe(expected);
  });
});

describe('required localized fields', () => {
  test('drop the empty languages the draft started with', () => {
    const payload = buildAppPayloadFromWizard(
      wizardState({
        name: { en: '', de: 'Helfer' },
        description: { en: ' ', de: 'Hilft' },
        system: { en: '', de: 'Du hilfst.' }
      })
    );

    expect(payload.name).toEqual({ de: 'Helfer' });
    expect(payload.description).toEqual({ de: 'Hilft' });
    expect(payload.system).toEqual({ de: 'Du hilfst.' });
  });

  test('stay as they are when no language has text, so the server names the field', () => {
    const payload = buildAppPayloadFromWizard(wizardState({ name: { en: '' } }));

    expect(payload.name).toEqual({ en: '' });
  });
});

describe('appCategoryOptions', () => {
  const uiConfig = {
    appsList: {
      categories: {
        list: [
          { id: 'all', name: { en: 'All' } },
          { id: 'writing', name: { en: 'Writing' } }
        ]
      }
    }
  };

  test('lists the ui.json categories without "all"', () => {
    expect(appCategoryOptions(uiConfig).map(c => c.id)).toEqual(['writing']);
  });

  test('keeps a category the app has that the list does not know', () => {
    expect(appCategoryOptions(uiConfig, 'legal').map(c => c.id)).toEqual(['writing', 'legal']);
  });

  test('is empty without a UI configuration', () => {
    expect(appCategoryOptions(null)).toEqual([]);
  });
});

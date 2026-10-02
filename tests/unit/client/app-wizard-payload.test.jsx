/**
 * The app creation wizard keeps its own UI state next to the app fields. The
 * server validates `POST /api/admin/apps` against the app schema, which allows
 * no unknown top-level keys, so the payload carries only app configuration.
 */
import {
  WIZARD_ONLY_KEYS,
  buildAppPayloadFromWizard
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

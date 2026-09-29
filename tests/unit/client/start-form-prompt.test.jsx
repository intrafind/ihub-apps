/**
 * The first message of a form-started chat (issue #2581): the app's `prompt`
 * rendered with the form's answers, once, on the client.
 */
import {
  getMissingRequiredVariables,
  isStartFormEnabled,
  renderStartFormPrompt,
  resolveVariableValues
} from '../../../client/src/features/chat/utils/startForm';

const APP = {
  id: 'email',
  prompt: {
    en: 'Write a {{type}} email to {{recipient}} about {{subject}}.\n\n{{content}}',
    de: 'Schreibe eine {{type}} E-Mail an {{recipient}} zu {{subject}}.\n\n{{content}}'
  },
  variables: [
    {
      name: 'type',
      label: { en: 'Email type', de: 'E-Mail-Typ' },
      type: 'select',
      defaultValue: { en: 'professional', de: 'professionell' },
      predefinedValues: [
        { value: 'professional', label: { en: 'Professional', de: 'Professionell' } },
        { value: 'follow-up', label: { en: 'Follow-up', de: 'Nachfassen' } }
      ]
    },
    {
      name: 'recipient',
      label: { en: 'Recipient', de: 'Empfänger' },
      type: 'string',
      required: true
    },
    { name: 'subject', label: { en: 'Subject', de: 'Betreff' }, type: 'text' }
  ]
};

describe('isStartFormEnabled', () => {
  test('only for an explicit startForm.enabled', () => {
    expect(isStartFormEnabled({ startForm: { enabled: true } })).toBe(true);
    expect(isStartFormEnabled({ startForm: { enabled: false } })).toBe(false);
    expect(isStartFormEnabled({ startForm: {} })).toBe(false);
    expect(isStartFormEnabled({})).toBe(false);
    expect(isStartFormEnabled(null)).toBe(false);
  });
});

describe('resolveVariableValues', () => {
  test('falls back to the default for an empty or blank answer', () => {
    expect(
      resolveVariableValues(APP, { type: '  ', recipient: 'Ada', subject: 'Q3' }, 'de')
    ).toEqual({ type: 'professionell', recipient: 'Ada', subject: 'Q3' });
    expect(resolveVariableValues(APP, {}, 'en')).toEqual({
      type: 'professional',
      recipient: '',
      subject: ''
    });
  });
});

describe('getMissingRequiredVariables', () => {
  test('lists required variables without a value, blank counting as none', () => {
    expect(getMissingRequiredVariables(APP, { recipient: '   ' }).map(v => v.name)).toEqual([
      'recipient'
    ]);
    expect(getMissingRequiredVariables(APP, { recipient: 'Ada' })).toEqual([]);
  });
});

describe('renderStartFormPrompt', () => {
  const values = { type: 'follow-up', recipient: 'Ada', subject: 'the Q3 report' };

  test('fills the variables and drops {{content}}', () => {
    expect(renderStartFormPrompt(APP, values, 'en')).toBe(
      'Write a follow-up email to Ada about the Q3 report.'
    );
  });

  test('uses the template of the language', () => {
    expect(renderStartFormPrompt(APP, values, 'de')).toBe(
      'Schreibe eine follow-up E-Mail an Ada zu the Q3 report.'
    );
  });

  test('leaves other placeholders for the server', () => {
    const app = {
      ...APP,
      prompt: { en: 'Hi {{user_name}}, today is {{date}}. To: {{recipient}}' }
    };
    expect(renderStartFormPrompt(app, values, 'en')).toBe(
      'Hi {{user_name}}, today is {{date}}. To: Ada'
    );
  });

  test('never expands a placeholder typed into an answer', () => {
    const answers = { ...values, recipient: '{{subject}} $& {{content}}' };
    expect(renderStartFormPrompt(APP, answers, 'en')).toBe(
      'Write a follow-up email to {{subject}} $& {{content}} about the Q3 report.'
    );
  });

  test('without a template, lists the answers with their labels', () => {
    const app = { ...APP, prompt: undefined };
    expect(renderStartFormPrompt(app, { ...values, subject: ' ' }, 'de')).toBe(
      'E-Mail-Typ: Nachfassen\nEmpfänger: Ada'
    );
  });

  test('a template that is empty in the language counts as none', () => {
    const app = { ...APP, prompt: { en: '   ' } };
    expect(renderStartFormPrompt(app, values, 'en')).toBe(
      'Email type: Follow-up\nRecipient: Ada\nSubject: the Q3 report'
    );
  });
});

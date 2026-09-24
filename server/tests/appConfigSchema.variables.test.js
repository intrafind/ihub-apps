/**
 * App variables keep their `description` and `placeholder`.
 *
 * The chat UI renders both (InputVariables), and shipped apps such as the
 * translator carry them, but the variable schema did not declare them. Zod
 * strips undeclared keys and the loader keeps the parsed object, so both were
 * dropped on load without a warning.
 */

import { appConfigSchema } from '../validators/appConfigSchema.js';

const app = {
  id: 'translator',
  name: { en: 'Translator' },
  description: { en: 'Translates text' },
  color: '#4F46E5',
  icon: 'globe',
  variables: [
    {
      name: 'language',
      label: { en: 'Target Language' },
      type: 'string',
      description: { en: 'Select the target language.', de: 'Wähle die Zielsprache.' },
      placeholder: { en: 'Choose a language', de: 'Sprache wählen' }
    }
  ]
};

describe('app variable schema', () => {
  test('keeps description and placeholder', () => {
    const result = appConfigSchema.safeParse(app);

    expect(result.success).toBe(true);
    expect(result.data.variables[0].description).toEqual(app.variables[0].description);
    expect(result.data.variables[0].placeholder).toEqual(app.variables[0].placeholder);
  });

  test('rejects an empty localized placeholder', () => {
    const invalid = structuredClone(app);
    invalid.variables[0].placeholder = { en: '' };

    expect(appConfigSchema.safeParse(invalid).success).toBe(false);
  });
});

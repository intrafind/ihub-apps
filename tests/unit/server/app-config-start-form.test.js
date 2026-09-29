import { describe, expect, it } from '@jest/globals';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { getJsonSchemaByType } from '../../../server/utils/schemaExport.js';
import { validateWithSchema } from '../../../client/src/utils/schemaValidation.js';

/**
 * `startForm` — a new chat opens with the app's variables as a form (issue
 * #2581). The app schema is strict at the top level, so the key has to be
 * declared for an app carrying it to load at all, and the admin editor's JSON
 * Schema (exported from the same Zod schema) has to accept it too.
 */

const app = {
  id: 'email',
  name: { en: 'Email' },
  description: { en: 'Drafts emails' },
  color: '#4F46E5',
  icon: 'mail',
  prompt: { en: 'Write to {{recipient}}.' },
  variables: [{ name: 'recipient', label: { en: 'Recipient' }, type: 'string' }],
  startForm: { enabled: true, submitLabel: { en: 'Draft', de: 'Entwerfen' } }
};

describe('app startForm', () => {
  it('is kept on load', () => {
    const result = appConfigSchema.safeParse(app);

    expect(result.success).toBe(true);
    expect(result.data.startForm).toEqual(app.startForm);
  });

  it('defaults to off and is absent from apps that do not set it', () => {
    const { startForm: _startForm, ...withoutForm } = app;

    expect(appConfigSchema.parse({ ...app, startForm: {} }).startForm).toEqual({
      enabled: false
    });
    expect(appConfigSchema.parse(withoutForm).startForm).toBeUndefined();
  });

  it('accepts an emptied send button label, which falls back to the built-in one', () => {
    const emptied = { ...app, startForm: { enabled: true, submitLabel: { en: '' } } };

    expect(appConfigSchema.safeParse(emptied).success).toBe(true);
  });

  it('rejects a non-boolean enabled', () => {
    const invalid = { ...app, startForm: { enabled: 'yes' } };

    expect(appConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('passes the admin editor schema', () => {
    const result = validateWithSchema(app, getJsonSchemaByType('app'));

    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });
});

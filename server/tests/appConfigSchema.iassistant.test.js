// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iAssistant scope settings of an app: an iFinder iAssistant by id, and
 * searching all of the user's search profiles. Both are kept by the schema —
 * Zod strips unknown keys, so an undeclared setting would silently do nothing.
 */

import { appConfigSchema } from '../validators/appConfigSchema.js';

const app = iassistant => ({
  id: 'legal-assistant',
  name: { en: 'Legal assistant' },
  description: { en: 'Answers from the legal documents' },
  color: '#4F46E5',
  icon: 'chat',
  iassistant
});

describe('app iAssistant scope', () => {
  test('keeps an iFinder iAssistant id', () => {
    const result = appConfigSchema.safeParse(
      app({ enabled: true, assistantId: 'legal.advisor_2' })
    );

    expect(result.success).toBe(true);
    expect(result.data.iassistant.assistantId).toBe('legal.advisor_2');
  });

  test('accepts an empty iAssistant id', () => {
    expect(appConfigSchema.safeParse(app({ assistantId: '' })).success).toBe(true);
  });

  test('rejects an id iFinder would not accept', () => {
    expect(appConfigSchema.safeParse(app({ assistantId: 'legal advisor' })).success).toBe(false);
    expect(appConfigSchema.safeParse(app({ assistantId: '-legal' })).success).toBe(false);
    expect(appConfigSchema.safeParse(app({ assistantId: 'a'.repeat(257) })).success).toBe(false);
  });

  test('keeps allSearchProfiles, and leaves it unset when not given', () => {
    expect(
      appConfigSchema.safeParse(app({ allSearchProfiles: true })).data.iassistant.allSearchProfiles
    ).toBe(true);
    expect(
      appConfigSchema.safeParse(app({ enabled: true })).data.iassistant.allSearchProfiles
    ).toBeUndefined();
  });
});

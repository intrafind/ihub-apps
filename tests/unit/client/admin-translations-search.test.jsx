// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import TranslationOverridesEditor from '../../../client/src/features/admin/components/TranslationOverridesEditor';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';

/**
 * Admin → Localization → Translation overrides.
 *
 * - CU-B7: a search finds labels that were never changed. "Changed only" is
 *   off when the editor opens, so following the hint "Search above to find a
 *   label to change" does not dead-end in "No matching translations".
 * - CU-B8: an unsaved edit belongs to its language. Switching the language
 *   does not show (or save) the English draft in the German row.
 * - R6: the language selector and a note name the languages that still hold
 *   unsaved edits, so switching away does not lose them silently.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => {
      if (typeof fallback === 'string') return fallback;
      const text = fallback?.defaultValue ?? key;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(fallback?.[name] ?? ''));
    },
    i18n: { language: 'en', removeResourceBundle: jest.fn() }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message
}));

jest.mock('../../../client/src/services/i18nService', () => ({
  __esModule: true,
  default: { clearCache: jest.fn(), loadFullTranslations: jest.fn() }
}));

const BASE = { en: 'Send', de: 'Senden' };

/** The server: one built-in key, never changed; `changedOnly` filters it out. */
function answer(url) {
  const [pathname, query] = url.split('?');
  const language = pathname.split('/').pop();
  const params = new URLSearchParams(query);
  const items =
    params.get('changedOnly') === 'true'
      ? []
      : [{ key: 'common.send', path: ['common', 'send'], base: BASE[language], override: null }];
  return { data: { items, total: items.length, changedCount: 0 } };
}

async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  makeAdminApiCall.mockReset();
  makeAdminApiCall.mockImplementation(async url => answer(url));
});

afterEach(() => {
  jest.useRealTimers();
});

test('"Changed only" starts off, so a search finds an unchanged label (CU-B7)', async () => {
  render(<TranslationOverridesEditor languages={['en', 'de']} initialLanguage="en" />);
  await settle();

  expect(screen.getByRole('checkbox', { name: /Changed only/ })).not.toBeChecked();
  expect(makeAdminApiCall.mock.calls[0][0]).toContain('changedOnly=false');

  fireEvent.change(screen.getByLabelText('Search translations'), { target: { value: 'Send' } });
  await settle();
  expect(screen.getByLabelText('common.send')).toHaveValue('Send');
  expect(screen.queryByText('No matching translations.')).not.toBeInTheDocument();
});

test('a draft stays with its language when the language changes (CU-B8)', async () => {
  render(<TranslationOverridesEditor languages={['en', 'de']} initialLanguage="en" />);
  await settle();

  fireEvent.change(screen.getByLabelText('common.send'), { target: { value: 'Send now' } });
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'de' } });
  await settle();
  // The German row shows the German text, not the English draft, and has nothing to save.
  expect(screen.getByLabelText('common.send')).toHaveValue('Senden');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en' } });
  await settle();
  expect(screen.getByLabelText('common.send')).toHaveValue('Send now');
});

test('unsaved edits in another language are named, and typing the text back clears them (R6)', async () => {
  render(<TranslationOverridesEditor languages={['en', 'de']} initialLanguage="en" />);
  await settle();
  expect(screen.getByRole('status')).toBeEmptyDOMElement();

  fireEvent.change(screen.getByLabelText('common.send'), { target: { value: 'Send now' } });
  // The shown language's own draft is on screen; only the selector counts it.
  expect(screen.getByRole('option', { name: 'en (1 unsaved)' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toBeEmptyDOMElement();

  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'de' } });
  await settle();
  expect(screen.getByRole('status')).toHaveTextContent('Unsaved edits in en (1).');

  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en' } });
  await settle();
  fireEvent.change(screen.getByLabelText('common.send'), { target: { value: 'Send' } });
  expect(screen.getByRole('option', { name: 'en' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'de' } });
  await settle();
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});

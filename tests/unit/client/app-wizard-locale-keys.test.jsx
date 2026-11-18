// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import AppCreationWizard from '../../../client/src/features/apps/components/AppCreationWizard';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';
import { useUIConfig } from '../../../client/src/shared/contexts/UIConfigContext';

/**
 * The app wizard on a browser with a regional locale (AI-B1, AI-B6).
 *
 * `i18n.language` is `de-DE` or `en-US` on most browsers; the wizard used it
 * as the key of the texts it collected, so the app went out with `name['de-DE']`
 * next to an empty `name.en` and the server refused it. The texts belong under
 * the base language, and the category list is the one `ui.json` defines.
 */

let mockLanguage = 'de-DE';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: mockLanguage }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));

jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn().mockResolvedValue([])
}));

jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: jest.fn()
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));

async function walkToReview() {
  render(
    <MemoryRouter>
      <AppCreationWizard onClose={jest.fn()} />
    </MemoryRouter>
  );
  await flush();
  fireEvent.click(screen.getByDisplayValue('manual'));
  next();
  await flush();

  fireEvent.change(screen.getByPlaceholderText('e.g., my-awesome-app'), {
    target: { value: 'helper' }
  });
  fireEvent.change(screen.getByPlaceholderText('Enter app name'), {
    target: { value: 'Helfer' }
  });
  fireEvent.change(screen.getByPlaceholderText('Enter app description'), {
    target: { value: 'Beantwortet Fragen' }
  });
  next();
  await flush();

  fireEvent.change(
    screen.getByPlaceholderText(
      'Enter system instructions that define how the AI should behave...'
    ),
    { target: { value: 'Du bist hilfreich.' } }
  );
  next(); // → variables
  await flush();
  next(); // → advanced
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLanguage = 'de-DE';
  makeAdminApiCall.mockResolvedValue({ data: {} });
  useUIConfig.mockReturnValue({
    uiConfig: {
      appsList: {
        categories: {
          list: [
            { id: 'all', name: { en: 'All', de: 'Alle' } },
            { id: 'writing', name: { en: 'Writing', de: 'Schreiben' } },
            { id: 'utility', name: { en: 'Utility', de: 'Werkzeuge' } }
          ]
        }
      }
    }
  });
});

test.each([
  ['de-DE', 'de'],
  ['en-US', 'en']
])('on a %s browser the texts are sent under %s', async (locale, base) => {
  mockLanguage = locale;
  await walkToReview();
  next(); // → review
  await flush();
  expect(screen.getByRole('heading', { name: 'Helfer' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Create App' }));
  await flush();

  expect(makeAdminApiCall).toHaveBeenCalledWith('/admin/apps', expect.any(Object));
  const { body } = makeAdminApiCall.mock.calls[0][1];
  expect(body.name).toEqual({ [base]: 'Helfer' });
  expect(body.description).toEqual({ [base]: 'Beantwortet Fragen' });
  expect(body.system).toEqual({ [base]: 'Du bist hilfreich.' });
});

test('the category list is the one ui.json defines, without "all"', async () => {
  await walkToReview();
  const select = screen.getByDisplayValue('Werkzeuge');
  const values = Array.from(select.querySelectorAll('option')).map(o => o.value);
  expect(values).toEqual(['', 'writing', 'utility']);
  expect(values).not.toContain('productivity');
  expect(values).not.toContain('creativity');
});

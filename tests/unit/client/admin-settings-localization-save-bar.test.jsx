// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Localization page saves its default language through the shared bottom bar: no bar until
 * the language changed (and none at all when the stored language could not be loaded, so the
 * initial "en" is never saved over it), Discard puts the stored language back, Save writes
 * only `defaultLanguage`, and a refused save keeps the bar and says why in it.
 *
 * The translation overrides below the language keep their own per-key Save; they are not
 * under test here.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockApi(...args),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
const mockRefreshUIConfig = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  __esModule: true,
  useUIConfig: () => ({
    uiConfig: { header: { title: { en: 'iHub', de: 'iHub', fr: 'iHub' } } },
    refreshUIConfig: mockRefreshUIConfig
  })
}));
jest.mock('../../../client/src/features/admin/components/TranslationOverridesEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => {
  // One `t` for every render, as in the app: the page's load effect depends on it.
  const translation = {
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  };
  return { useTranslation: () => translation };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const AdminLocalizationPage =
  require('../../../client/src/features/admin/pages/AdminLocalizationPage').default;

let stored;
let failNextPost;

beforeEach(() => {
  jest.clearAllMocks();
  stored = { defaultLanguage: 'de' };
  failNextPost = false;
  mockApi.mockImplementation(async (url, options = {}) => {
    if ((options.method || 'GET') === 'POST') {
      if (failNextPost) {
        failNextPost = false;
        throw new Error('the server said no');
      }
      stored = { ...stored, ...options.body };
      return { data: {} };
    }
    return { data: stored };
  });
});

const bar = () => screen.queryByRole('region', { name: /save changes/i });
const saveButton = () => {
  const buttons = within(bar()).getAllByRole('button');
  return buttons[buttons.length - 1];
};
const language = () => screen.getByLabelText('Default Language');
const settle = () => act(async () => {});

const open = async () => {
  render(<AdminLocalizationPage />);
  await waitFor(() => expect(language()).toHaveValue('de'));
  await settle();
};

describe('Localization save bar', () => {
  test('no bar until the language changed; choosing another one shows it', async () => {
    await open();
    expect(bar()).not.toBeInTheDocument();

    fireEvent.change(language(), { target: { value: 'fr' } });

    expect(bar()).toBeInTheDocument();
  });

  test('choosing the stored language again leaves nothing to save', async () => {
    await open();
    fireEvent.change(language(), { target: { value: 'fr' } });
    fireEvent.change(language(), { target: { value: 'de' } });
    expect(bar()).not.toBeInTheDocument();
  });

  test('Discard puts the stored language back and takes the bar away', async () => {
    await open();
    fireEvent.change(language(), { target: { value: 'fr' } });

    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }));

    expect(language()).toHaveValue('de');
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save writes only the default language, refreshes the UI config, and the bar goes away', async () => {
    await open();
    fireEvent.change(language(), { target: { value: 'fr' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() => expect(stored.defaultLanguage).toBe('fr'));
    const post = mockApi.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(post[1].body).toEqual({ defaultLanguage: 'fr' });
    expect(mockRefreshUIConfig).toHaveBeenCalled();
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  test('a refused save keeps the bar, says why in it, and can be tried again', async () => {
    await open();
    const original = language().value;
    fireEvent.change(language(), { target: { value: 'fr' } });
    failNextPost = true;

    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() => expect(within(bar()).getByText(/the server said no/)).toBeVisible());

    // Back at the stored language the form is clean, but the write may have gone through and
    // only its answer been lost: the bar stays, so the shown value can be sent again.
    fireEvent.change(language(), { target: { value: original } });
    expect(bar()).toBeInTheDocument();
    fireEvent.change(language(), { target: { value: 'fr' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(stored.defaultLanguage).toBe('fr'));
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  test('no bar when the stored language could not be loaded: "en" is never saved over it', async () => {
    mockApi.mockRejectedValue(new Error('offline'));
    render(<AdminLocalizationPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load');

    fireEvent.change(language(), { target: { value: 'fr' } });

    expect(bar()).not.toBeInTheDocument();
  });
});

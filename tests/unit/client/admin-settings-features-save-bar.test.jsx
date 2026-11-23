// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Features saves through the shared bottom bar: no bar until something changed,
 * gone when the change is put back or discarded, Save writes the toggled features, and a
 * failed save keeps the bar (the server's state can be unknown) with the error next to it.
 * Uses the real dirty tracking.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockAdminApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockAdminApi(...args)
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});
const mockRefreshConfig = jest.fn();
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ refreshConfig: mockRefreshConfig })
}));
jest.mock('../../../client/src/features/admin/components/UnsavedChangesDialog', () => ({
  __esModule: true,
  default: () => null
}));

const en = require('../../../shared/i18n/en.json');
const AdminFeaturesPage =
  require('../../../client/src/features/admin/pages/AdminFeaturesPage').default;

const FEATURES = {
  items: [
    {
      id: 'chatSharing',
      name: { en: 'Chat sharing' },
      description: { en: 'Share chats' },
      category: 'content',
      enabled: true
    },
    {
      id: 'voiceMode',
      name: { en: 'Voice mode' },
      description: { en: 'Talk' },
      category: 'content',
      enabled: false
    }
  ],
  categories: { content: { name: { en: 'Content' }, order: 1 } }
};

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
const discardButton = () =>
  within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard });
const sharing = () => screen.getByRole('switch', { name: 'Chat sharing' });
const voice = () => screen.getByRole('switch', { name: 'Voice mode' });

const puts = () =>
  mockAdminApi.mock.calls.filter(
    ([url, options]) => url === '/admin/features' && options?.method === 'PUT'
  );

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  jest.clearAllMocks();
  mockAdminApi.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/features' && (!options.method || options.method === 'GET')) {
      return { data: FEATURES };
    }
    if (url === '/admin/configs/platform') return { data: {} };
    if (url === '/admin/models') return { data: { items: [] } };
    return { data: {} };
  });
});

describe('Admin → Features save bar', () => {
  test('there is no bar until a feature is switched, and none once it is put back', async () => {
    render(<AdminFeaturesPage />);
    await screen.findByRole('switch', { name: 'Chat sharing' });
    expect(bar()).not.toBeInTheDocument();

    fireEvent.click(sharing());
    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText(en.admin.ui.saveBar.unsaved)).toBeInTheDocument();

    fireEvent.click(sharing());
    expect(bar()).not.toBeInTheDocument();
  });

  test('Discard puts every switch back', async () => {
    render(<AdminFeaturesPage />);
    await screen.findByRole('switch', { name: 'Chat sharing' });

    fireEvent.click(sharing());
    fireEvent.click(voice());
    expect(sharing()).not.toBeChecked();
    expect(voice()).toBeChecked();

    fireEvent.click(discardButton());

    expect(sharing()).toBeChecked();
    expect(voice()).not.toBeChecked();
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save writes the switched features and the bar goes away', async () => {
    render(<AdminFeaturesPage />);
    await screen.findByRole('switch', { name: 'Chat sharing' });

    fireEvent.click(voice());
    fireEvent.click(saveButton());

    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]).toEqual({ method: 'PUT', body: { voiceMode: true } });
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
    expect(await screen.findByText('Features updated successfully')).toBeInTheDocument();
    expect(mockRefreshConfig).toHaveBeenCalled();
  });

  test('a failed save keeps the bar and shows the error next to it', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockAdminApi.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/features' && options.method === 'PUT') throw new Error('refused');
      if (url === '/admin/features') return { data: FEATURES };
      if (url === '/admin/models') return { data: { items: [] } };
      return { data: {} };
    });
    render(<AdminFeaturesPage />);
    await screen.findByRole('switch', { name: 'Chat sharing' });

    fireEvent.click(voice());
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(within(bar()).getByText('Failed to save features')).toBeInTheDocument()
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to save features');
    console.error.mockRestore();
  });

  test('after a failed save the bar stays when the switch is put back, and Save sends it', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let failNext = true;
    mockAdminApi.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/features' && options.method === 'PUT') {
        if (failNext) {
          failNext = false;
          throw new Error('response lost');
        }
        return { data: {} };
      }
      if (url === '/admin/features') return { data: FEATURES };
      if (url === '/admin/models') return { data: { items: [] } };
      return { data: {} };
    });
    render(<AdminFeaturesPage />);
    await screen.findByRole('switch', { name: 'Chat sharing' });

    fireEvent.click(voice());
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(within(bar()).getByText('Failed to save features')).toBeInTheDocument()
    );

    // The server may hold voiceMode: true. Putting the switch back must still be savable.
    fireEvent.click(voice());
    expect(voice()).not.toBeChecked();
    expect(bar()).toBeInTheDocument();
    fireEvent.click(saveButton());

    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1][1]).toEqual({ method: 'PUT', body: { voiceMode: false } });
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
    console.error.mockRestore();
  });

  test('after a failed draft-model save, putting the select back still sends the model again', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const MODELS = [
      { id: 'small', name: { en: 'Small' }, enabled: true, modelType: 'chat' },
      { id: 'big', name: { en: 'Big' }, enabled: true, modelType: 'chat' }
    ];
    let failPatch = true;
    mockAdminApi.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/features' && options.method === 'GET') {
        return {
          data: {
            items: [
              {
                id: 'appGenerator',
                name: { en: 'App Drafts with AI' },
                description: { en: 'Drafts' },
                category: 'content',
                enabled: true
              }
            ],
            categories: FEATURES.categories
          }
        };
      }
      if (url === '/admin/configs/platform' && options.method === 'GET') {
        return { data: { appGenerator: { modelId: 'small' } } };
      }
      if (url === '/admin/configs/platform' && options.method === 'PATCH') {
        if (failPatch) {
          failPatch = false;
          throw new Error('response lost');
        }
        return { data: {} };
      }
      if (url === '/admin/models') return { data: { items: MODELS } };
      return { data: {} };
    });
    render(<AdminFeaturesPage />);
    const select = await screen.findByLabelText('Model for drafts');
    expect(select).toHaveValue('small');
    const patches = () =>
      mockAdminApi.mock.calls.filter(([, options]) => options?.method === 'PATCH');

    fireEvent.change(select, { target: { value: 'big' } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(within(bar()).getByText('Failed to save features')).toBeInTheDocument()
    );

    // The server may hold "big". Putting the select back to "small" must reach the server.
    fireEvent.change(select, { target: { value: 'small' } });
    expect(bar()).toBeInTheDocument();
    fireEvent.click(saveButton());

    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1][1].body).toEqual({ appGenerator: { modelId: 'small' } });
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
    console.error.mockRestore();
  });

  test('no bar while the features could not be loaded', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockAdminApi.mockImplementation(async () => {
      throw new Error('down');
    });
    render(<AdminFeaturesPage />);
    expect(await screen.findByText('Failed to load features')).toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
    console.error.mockRestore();
  });
});

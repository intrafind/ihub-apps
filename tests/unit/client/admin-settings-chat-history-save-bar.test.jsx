// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Chat History saves its settings through the shared bottom bar: no bar until a setting
 * changed (also one nested two levels deep), gone when it is put back or discarded, Save sends
 * the settings blocks, a failed save keeps the bar with the error next to it, and nothing is
 * offered while the overview could not be loaded. Uses the real dirty tracking.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockApi(...args)
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UnsavedChangesDialog', () => ({
  __esModule: true,
  default: () => null
}));

const en = require('../../../shared/i18n/en.json');
const AdminChatHistoryPage =
  require('../../../client/src/features/admin/pages/AdminChatHistoryPage').default;

const SETTINGS = {
  chats: {
    enabled: true,
    maxChatsPerUser: 50,
    maxMessagesPerChat: 200,
    retentionDays: 90,
    temporaryRetentionHours: 24
  },
  titles: { enabled: false, modelId: '' },
  compaction: { modelId: '' },
  evidence: { enabled: true },
  runLog: {
    enabled: true,
    cleanupEnabled: true,
    flushIntervalMs: 1000,
    identityMode: 'default',
    retentionDays: 30,
    spillThresholdBytes: 1024
  },
  sharing: {
    enabled: true,
    allowArtifacts: true,
    allowAuthenticated: true,
    allowPublic: false,
    allowUsers: true,
    defaultExpiryDays: 30,
    embedAllowedOrigins: [],
    embedEnabled: false,
    maxExpiryDays: 365,
    maxViewsCap: 0
  },
  uploads: {
    enabled: true,
    evictOldestOriginalsOnQuota: false,
    originalRetentionDays: 30,
    storageMode: 'local',
    quotas: {
      maxApiBytes: 1000,
      maxApiFiles: 10,
      maxChatBytes: 2000,
      maxChatFiles: 20,
      maxFileBytes: 3000,
      maxServerBytes: 4000,
      maxUserBytes: 5000
    }
  }
};
const OVERVIEW = { status: {}, stats: {}, settings: SETTINGS };

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
const discardButton = () =>
  within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard });
const chatsPerUser = () => screen.getByLabelText('Chats per user');
const puts = () =>
  mockApi.mock.calls.filter(
    ([url, options]) => url === '/admin/chat-history/settings' && options?.method === 'PUT'
  );

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const renderPage = async () => {
  render(
    <MemoryRouter>
      <AdminChatHistoryPage />
    </MemoryRouter>
  );
  await screen.findByLabelText('Chats per user');
  await settle();
};

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  jest.clearAllMocks();
  mockApi.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/chat-history' && !options.method) return { data: OVERVIEW };
    if (url === '/admin/chat-history/settings' && options.method === 'PUT') return { data: {} };
    if (url === '/admin/chat-history/shares') return { data: { items: [] } };
    if (url === '/admin/models') return { data: { items: [] } };
    return { data: {} };
  });
});

const apiFiles = () => screen.getByLabelText('Inference API: files per user');

describe('Admin → Chat History save bar', () => {
  test('no bar after loading; a change shows it, putting it back hides it', async () => {
    await renderPage();
    expect(bar()).not.toBeInTheDocument();

    fireEvent.change(chatsPerUser(), { target: { value: '75' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.change(chatsPerUser(), { target: { value: '50' } });
    expect(bar()).not.toBeInTheDocument();
  });

  test('a change two levels deep (an upload quota) shows the bar, and Discard puts it back', async () => {
    await renderPage();
    expect(apiFiles()).toHaveValue(10);

    fireEvent.change(apiFiles(), { target: { value: '99' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());

    expect(apiFiles()).toHaveValue(10);
    expect(bar()).not.toBeInTheDocument();
  });

  test('Discard puts back every edit on the page', async () => {
    await renderPage();
    fireEvent.change(chatsPerUser(), { target: { value: '75' } });
    fireEvent.change(apiFiles(), { target: { value: '99' } });

    fireEvent.click(discardButton());

    expect(chatsPerUser()).toHaveValue(50);
    expect(apiFiles()).toHaveValue(10);
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save sends the settings blocks, then reloads them, and the bar goes away', async () => {
    await renderPage();
    fireEvent.change(chatsPerUser(), { target: { value: '75' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() => expect(puts()).toHaveLength(1));
    const { body } = puts()[0][1];
    expect(Object.keys(body).sort()).toEqual(
      ['chats', 'compaction', 'evidence', 'runLog', 'sharing', 'titles', 'uploads'].sort()
    );
    expect(body.chats.maxChatsPerUser).toBe(75);
    expect(body.uploads.quotas.maxApiFiles).toBe(10);
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
    expect(await screen.findByText('Settings saved and applied.')).toBeInTheDocument();
  });

  test('a failed save keeps the bar and shows the error next to it; Discard clears both', async () => {
    mockApi.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/chat-history/settings' && options.method === 'PUT') {
        const error = new Error('refused');
        error.response = { data: { detail: 'The retention is out of range' } };
        throw error;
      }
      if (url === '/admin/chat-history') return { data: OVERVIEW };
      return { data: { items: [] } };
    });
    await renderPage();
    fireEvent.change(chatsPerUser(), { target: { value: '75' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() =>
      expect(within(bar()).getByText('The retention is out of range')).toBeInTheDocument()
    );
    fireEvent.click(discardButton());
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByText('The retention is out of range')).not.toBeInTheDocument();
  });

  test('after a failed save the bar stays when the field is put back, and Save sends it', async () => {
    let attempt = 0;
    mockApi.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/chat-history/settings' && options.method === 'PUT') {
        attempt += 1;
        if (attempt === 1) throw new Error('response lost');
        return { data: {} };
      }
      if (url === '/admin/chat-history') return { data: OVERVIEW };
      return { data: { items: [] } };
    });
    await renderPage();
    fireEvent.change(chatsPerUser(), { target: { value: '75' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(within(bar()).getByText('response lost')).toBeInTheDocument());

    // The server may hold 75. Putting 50 back must still be savable.
    fireEvent.change(chatsPerUser(), { target: { value: '50' } });
    expect(bar()).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1][1].body.chats.maxChatsPerUser).toBe(50);
  });

  test('no bar, and nothing to save, when the overview could not be loaded', async () => {
    mockApi.mockImplementation(async url => {
      if (url === '/admin/chat-history') throw new Error('down');
      return { data: { items: [] } };
    });
    render(
      <MemoryRouter>
        <AdminChatHistoryPage />
      </MemoryRouter>
    );
    expect(await screen.findByText('down')).toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });
});

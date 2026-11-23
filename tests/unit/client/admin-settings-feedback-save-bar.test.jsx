// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Feedback (Settings tab) saves through the shared bottom bar: no bar until a setting
 * changed, gone when it is put back or discarded, Save writes only what changed, a failed save
 * keeps the bar with the error next to it. The per-app switches save at once and are not part of
 * the bar. Uses the real dirty tracking.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockApi = {
  makeAdminApiCall: jest.fn(),
  fetchAdminApps: jest.fn(),
  fetchAdminUsageMeta: jest.fn(),
  updateAdminUsageTrackingMode: jest.fn(),
  setAppFeedbackEnabled: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || '',
  makeAdminApiCall: (...a) => mockApi.makeAdminApiCall(...a),
  fetchAdminApps: (...a) => mockApi.fetchAdminApps(...a),
  fetchAdminUsageMeta: (...a) => mockApi.fetchAdminUsageMeta(...a),
  updateAdminUsageTrackingMode: (...a) => mockApi.updateAdminUsageTrackingMode(...a),
  setAppFeedbackEnabled: (...a) => mockApi.setAppFeedbackEnabled(...a)
}));
jest.mock('../../../client/src/api/usageReportsAdminApi', () => ({
  __esModule: true,
  fetchUsageFeedbackSummary: jest.fn().mockResolvedValue(null)
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});
jest.mock('react-router-dom', () => ({
  __esModule: true,
  ...jest.requireActual('react-router-dom'),
  Link: ({ children }) => <span>{children}</span>
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ refreshConfig: jest.fn() })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/feedback/FeedbackReview', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UnsavedChangesDialog', () => ({
  __esModule: true,
  default: () => null
}));

const en = require('../../../shared/i18n/en.json');
const AdminFeedbackPage =
  require('../../../client/src/features/admin/pages/AdminFeedbackPage').default;

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
const discardButton = () =>
  within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard });
const collect = () => screen.getByRole('switch', { name: 'Collect feedback' });
const store = () => screen.getByRole('switch', { name: 'Store feedback' });
const mode = () => screen.getByRole('combobox');

const writes = () =>
  mockApi.makeAdminApiCall.mock.calls.filter(([, options]) => options?.method !== 'GET');

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  jest.clearAllMocks();
  mockApi.makeAdminApiCall.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/features' && options.method === 'GET') {
      return { data: { items: [{ id: 'feedback', enabled: true }] } };
    }
    if (url === '/admin/configs/platform' && options.method === 'GET') {
      return { data: { features: { feedbackTracking: true, usageTrackingMode: 'pseudonymous' } } };
    }
    return { data: {} };
  });
  mockApi.fetchAdminApps.mockResolvedValue([]);
  mockApi.fetchAdminUsageMeta.mockResolvedValue({ trackingMode: 'pseudonymous' });
  mockApi.updateAdminUsageTrackingMode.mockResolvedValue({});
  mockApi.setAppFeedbackEnabled.mockResolvedValue({});
});

const renderPage = async () => {
  render(<AdminFeedbackPage />);
  await screen.findByRole('switch', { name: 'Store feedback' });
};

describe('Admin → Feedback save bar', () => {
  test('no bar until a setting changed, and none once it is put back', async () => {
    await renderPage();
    expect(bar()).not.toBeInTheDocument();

    fireEvent.click(store());
    expect(bar()).toBeInTheDocument();

    fireEvent.click(store());
    expect(bar()).not.toBeInTheDocument();
  });

  test('a change of the identification mode alone shows the bar; Discard puts every setting back', async () => {
    await renderPage();

    fireEvent.change(mode(), { target: { value: 'anonymous' } });
    fireEvent.click(collect());
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());

    expect(mode()).toHaveValue('pseudonymous');
    expect(collect()).toBeChecked();
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save writes only what changed and the bar goes away', async () => {
    await renderPage();

    fireEvent.click(store());
    fireEvent.click(saveButton());

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      '/admin/configs/platform',
      { method: 'PATCH', body: { features: { feedbackTracking: false } } }
    ]);
    expect(mockApi.updateAdminUsageTrackingMode).not.toHaveBeenCalled();
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
    expect(await screen.findByText('Feedback settings saved')).toBeInTheDocument();
  });

  test('a failed save keeps the bar and shows the error next to it', async () => {
    mockApi.updateAdminUsageTrackingMode.mockRejectedValue(new Error('mode refused'));
    await renderPage();

    fireEvent.change(mode(), { target: { value: 'identified' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(within(bar()).getByText('mode refused')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('mode refused');
  });

  test('after a failed save the bar stays when the setting is put back, and Save sends it', async () => {
    mockApi.updateAdminUsageTrackingMode
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue({});
    await renderPage();

    fireEvent.change(mode(), { target: { value: 'identified' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(bar()).getByText('response lost')).toBeInTheDocument());

    // The server may hold "identified". Putting the select back must still be savable.
    fireEvent.change(mode(), { target: { value: 'pseudonymous' } });
    expect(bar()).toBeInTheDocument();
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockApi.updateAdminUsageTrackingMode).toHaveBeenCalledTimes(2));
    expect(mockApi.updateAdminUsageTrackingMode).toHaveBeenLastCalledWith('pseudonymous');
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  test('a field whose write failed is kept when a later save fails on another field first', async () => {
    const real = mockApi.makeAdminApiCall.getMockImplementation();
    const fail = { patch: 1, put: 1 };
    mockApi.makeAdminApiCall.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/configs/platform' && options.method === 'PATCH' && fail.patch-- > 0) {
        throw new Error('storage response lost');
      }
      if (url === '/admin/features' && options.method === 'PUT' && fail.put-- > 0) {
        throw new Error('features refused');
      }
      return real(url, options);
    });
    await renderPage();

    // Save 1: "Store feedback" is written and its answer is lost.
    fireEvent.click(store());
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(within(bar()).getByText('storage response lost')).toBeInTheDocument()
    );

    // Save 2 fails on "Collect feedback", which is written before it.
    fireEvent.click(store());
    fireEvent.click(collect());
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(bar()).getByText('features refused')).toBeInTheDocument());

    // Both are back at their loaded values, yet the first write may have gone through: Save
    // sends both again.
    fireEvent.click(collect());
    expect(bar()).toBeInTheDocument();
    fireEvent.click(saveButton());

    await waitFor(() => expect(bar()).not.toBeInTheDocument());
    const patches = writes().filter(([, options]) => options.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1][1].body).toEqual({ features: { feedbackTracking: true } });
  });

  test('no bar while the settings could not be loaded', async () => {
    mockApi.makeAdminApiCall.mockRejectedValue(new Error('down'));
    render(<AdminFeedbackPage />);
    await screen.findByRole('alert');
    expect(bar()).not.toBeInTheDocument();
  });
});

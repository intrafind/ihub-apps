// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cache settings of Admin → Projects → Project settings (#3650): the panel
 * shows them and sends only what changed; an empty share goes back as null.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ProjectSharingSettingsPanel from '../../../client/src/features/admin/components/ProjectSharingSettingsPanel';
import { fetchProjectSettings, saveProjectSettings } from '../../../client/src/api/adminApi';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchProjectSettings: jest.fn(),
  saveProjectSettings: jest.fn(),
  getAdminApiErrorMessage: err => String(err?.message)
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ refreshConfig: jest.fn() })
}));
jest.mock('../../../client/src/features/projects/components/ProjectAppSelect', () => () => null);

const SETTINGS = {
  sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowCatalog: false },
  tierPolicy: 'ihub',
  defaultAppId: '',
  limits: {
    maxFiles: 100,
    maxFileBytes: 20971520,
    maxProjectBytes: 524288000,
    maxProjectsPerUser: 20
  },
  indexCache: { maxEntries: 32, maxHeapShare: null },
  textCache: { maxHeapShare: 0.06 },
  maxFilesCeiling: 200
};

beforeEach(() => {
  fetchProjectSettings.mockResolvedValue(SETTINGS);
  saveProjectSettings.mockImplementation(async body => ({
    ...SETTINGS,
    indexCache: { ...SETTINGS.indexCache, ...body.indexCache },
    textCache: { ...SETTINGS.textCache, ...body.textCache }
  }));
});

test('shows the stored values and saves only the changes', async () => {
  render(<ProjectSharingSettingsPanel />);
  const entries = await screen.findByLabelText('Search indexes kept in memory');
  expect(entries).toHaveValue(32);
  expect(screen.getByLabelText('Memory share of the search indexes (%)')).toHaveValue(null);
  expect(screen.getByLabelText('Memory share of the cached document texts (%)')).toHaveValue(6);

  fireEvent.change(entries, { target: { value: '100' } });
  fireEvent.change(screen.getByLabelText('Memory share of the search indexes (%)'), {
    target: { value: '20' }
  });
  fireEvent.change(screen.getByLabelText('Memory share of the cached document texts (%)'), {
    target: { value: '' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(saveProjectSettings).toHaveBeenCalled());
  const body = saveProjectSettings.mock.calls[0][0];
  expect(body.indexCache).toEqual({ maxEntries: 100, maxHeapShare: 0.2 });
  expect(body.textCache).toEqual({ maxHeapShare: null });
});

test('an out-of-range share blocks the save', async () => {
  render(<ProjectSharingSettingsPanel />);
  const share = await screen.findByLabelText('Memory share of the search indexes (%)');
  fireEvent.change(share, { target: { value: '80' } });
  expect(screen.getByText('Enter 1 to 50, or leave empty.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

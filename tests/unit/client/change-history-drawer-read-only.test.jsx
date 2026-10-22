// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The history drawer of a resource the server cannot roll back (a project):
 * the snapshots can be read, and the rollback button is not offered.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// A stable `t`, as react-i18next's: the drawer refetches when it changes.
const mockI18n = {
  t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key)
};
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const ChangeHistoryDrawer =
  require('../../../client/src/features/admin/components/ChangeHistoryDrawer').default;

const SNAPSHOT = {
  filename: '2026-10-22T10-00-00.json',
  ts: '2026-10-22T10:00:00.000Z',
  admin: 'ada'
};

beforeEach(() => {
  mockCall.mockReset();
  mockCall.mockImplementation(async url =>
    url.endsWith('.json')
      ? { data: { ...SNAPSHOT, before: { name: 'Old' }, after: { name: 'New' } } }
      : { data: [SNAPSHOT] }
  );
});

async function openSnapshot(props) {
  render(
    <ChangeHistoryDrawer isOpen onClose={() => {}} resource="project" resourceId="faq" {...props} />
  );
  fireEvent.click(await screen.findByText(/by ada/));
  // The snapshot view has opened once its way back is there.
  await screen.findByText('Back to list');
}

describe('ChangeHistoryDrawer', () => {
  test('offers the rollback of a snapshot by default', async () => {
    await openSnapshot({});
    expect(screen.getByText('Rollback to this version')).toBeInTheDocument();
  });

  test('is read-only without the rollback button, the history still readable', async () => {
    await openSnapshot({ readOnly: true });
    expect(screen.queryByText('Rollback to this version')).not.toBeInTheDocument();
    expect(screen.queryByText('Rollback')).not.toBeInTheDocument();
  });
});

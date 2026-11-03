// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AuthContext } from '../../../client/src/shared/contexts/authContextValue';
import useMyUsage, {
  refreshMyUsage,
  resetMyUsageStore
} from '../../../client/src/shared/hooks/useMyUsage';
import { fetchMyUsage } from '../../../client/src/api/endpoints/usage';

/**
 * The usage numbers belong to one viewer, and a refresh that overlaps a
 * request still out asks again so the numbers include the run that ended.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, f) => f || k, i18n: { language: 'en' } })
}));

jest.mock('../../../client/src/api/endpoints/usage', () => ({
  fetchMyUsage: jest.fn()
}));

function Probe() {
  const { data } = useMyUsage();
  return <div data-testid="who">{data ? data.who : 'none'}</div>;
}

function withUser(id) {
  return { isLoading: false, isAuthenticated: true, user: { id } };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

beforeEach(() => {
  resetMyUsageStore();
  fetchMyUsage.mockReset();
});

test('drops the previous viewer’s numbers and a late answer for them', async () => {
  let resolveAlice;
  fetchMyUsage
    .mockImplementationOnce(() => new Promise(r => (resolveAlice = r)))
    .mockImplementationOnce(() => Promise.resolve({ who: 'bob', buckets: [] }));

  const { rerender } = render(
    <AuthContext.Provider value={withUser('alice')}>
      <Probe />
    </AuthContext.Provider>
  );
  await flush();
  rerender(
    <AuthContext.Provider value={withUser('bob')}>
      <Probe />
    </AuthContext.Provider>
  );
  await flush();
  expect(screen.getByTestId('who')).toHaveTextContent('bob');

  // Alice's answer arrives after Bob signed in: it is not shown.
  resolveAlice({ who: 'alice', buckets: [] });
  await flush();
  expect(screen.getByTestId('who')).toHaveTextContent('bob');
});

test('a refresh while a request is out fetches again once it is back', async () => {
  let resolveFirst;
  fetchMyUsage
    .mockImplementationOnce(() => new Promise(r => (resolveFirst = r)))
    .mockImplementationOnce(() => Promise.resolve({ who: 'after-run', buckets: [] }));

  render(
    <AuthContext.Provider value={withUser('alice')}>
      <Probe />
    </AuthContext.Provider>
  );
  await flush();
  void refreshMyUsage();
  resolveFirst({ who: 'before-run', buckets: [] });
  await flush();
  expect(fetchMyUsage).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('who')).toHaveTextContent('after-run');
});

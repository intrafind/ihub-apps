// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import RequestLog from '../../../client/src/features/admin/components/usage/RequestLog';
import { fetchUsageCalls } from '../../../client/src/api/usageReportsAdminApi';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, f) => (typeof f === 'string' ? f : k), i18n: { language: 'en' } })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api/usageReportsAdminApi', () => ({ fetchUsageCalls: jest.fn() }));

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

const call = (id, over = {}) => ({
  id,
  v: 2,
  type: 'llm_call',
  ts: new Date().toISOString(),
  surf: 'chat',
  uid: 'alice',
  app: 'chat',
  model: 'gpt',
  st: 'ok',
  pt: 120,
  ct: 30,
  lat: 900,
  tc: 2,
  rid: `req-${id}`,
  ...over
});

const state = {
  rangeParams: { range: '7d' },
  filters: { user: '', app: '', model: '', surface: '', outcome: '' },
  update: jest.fn()
};

beforeEach(() => {
  fetchUsageCalls.mockReset();
  state.update.mockReset();
});

test('lists calls, pages with the cursor and opens a metadata drawer', async () => {
  fetchUsageCalls
    .mockResolvedValueOnce({
      items: [call('a'), call('b', { st: 'error', err: 'TIMEOUT' })],
      nextCursor: 'c1'
    })
    .mockResolvedValueOnce({ items: [call('c', { uid: 'bob' })], nextCursor: null });
  render(<RequestLog state={state} />);
  await flush();
  expect(fetchUsageCalls).toHaveBeenLastCalledWith({ range: '7d', ...state.filters, limit: 50 });
  expect(screen.getAllByRole('row')).toHaveLength(3);

  fireEvent.click(screen.getByText('Load more'));
  await flush();
  expect(fetchUsageCalls).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c1' }));
  expect(screen.getByText('bob')).toBeInTheDocument();
  expect(screen.queryByText('Load more')).not.toBeInTheDocument();

  fireEvent.click(screen.getAllByRole('row')[2]);
  const drawer = screen.getByTestId('usage-call-drawer');
  expect(within(drawer).getByText('TIMEOUT')).toBeInTheDocument();
  expect(within(drawer).getByText('req-b')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByTestId('usage-call-drawer')).not.toBeInTheDocument();
});

test('writes filters to the URL state', async () => {
  fetchUsageCalls.mockResolvedValue({ items: [], nextCursor: null });
  render(<RequestLog state={state} />);
  await flush();
  expect(screen.getByText('No calls match')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'quota' } });
  expect(state.update).toHaveBeenCalledWith({ f_outcome: 'quota' });
});

test('a text filter keeps its input (and focus) when the debounced value is applied', async () => {
  jest.useFakeTimers();
  try {
    fetchUsageCalls.mockResolvedValue({ items: [], nextCursor: null });
    const filters = { ...state.filters };
    const update = jest.fn(patch => {
      if ('f_user' in patch) filters.user = patch.f_user;
    });
    const { rerender } = render(<RequestLog state={{ ...state, filters, update }} />);
    const input = screen.getByLabelText('User');
    input.focus();
    fireEvent.change(input, { target: { value: 'ali' } });
    act(() => jest.advanceTimersByTime(450));
    expect(update).toHaveBeenCalledWith({ f_user: 'ali' });
    rerender(<RequestLog state={{ ...state, filters: { ...filters }, update }} />);
    expect(screen.getByLabelText('User')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveValue('ali');

    // An outside change (Clear filters) replaces the draft.
    rerender(<RequestLog state={{ ...state, filters: { ...filters, user: '' }, update }} />);
    expect(input).toHaveValue('');
  } finally {
    jest.useRealTimers();
  }
});

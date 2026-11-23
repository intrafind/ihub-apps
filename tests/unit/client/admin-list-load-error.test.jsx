// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI-B11 / AI-UX6: a failed load is never shown as an empty list. While a load
 * error is set, the admin lists show the error with Retry, no "Create your
 * first …" call to action and no count of 0; rows loaded before the failure
 * stay visible. The rule lives in `utils/listLoadState.js` and the shared
 * `DataTable` (props `error` / `onRetry`).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return Object.entries(options || {}).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
        text
      );
    }
  })
}));

import DataTable from '../../../client/src/features/admin/components/data-table/DataTable';
import { listCount, resolveListView } from '../../../client/src/features/admin/utils/listLoadState';

describe('resolveListView', () => {
  it('never reports an empty list while a load error is set', () => {
    expect(resolveListView({ error: 'HTTP 500', rowCount: 0 })).toBe('error');
    expect(resolveListView({ error: null, rowCount: 0 })).toBe('empty');
  });

  it('keeps stale rows after a failed load, also while the retry runs', () => {
    expect(resolveListView({ error: 'HTTP 500', rowCount: 3 })).toBe('rows');
    expect(resolveListView({ error: 'HTTP 500', rowCount: 3, loading: true })).toBe('rows');
  });

  it('shows the skeleton while a first load or a retry without rows runs', () => {
    expect(resolveListView({ loading: true, rowCount: 0 })).toBe('loading');
    expect(resolveListView({ loading: true, error: 'x', rowCount: 0 })).toBe('loading');
    expect(resolveListView({ loading: true, rowCount: 2 })).toBe('loading');
  });
});

describe('listCount', () => {
  it('is unknown while loading and after a failed load with nothing loaded', () => {
    expect(listCount(0, { loading: true })).toBeUndefined();
    expect(listCount(0, { error: 'HTTP 500' })).toBeUndefined();
  });

  it('counts what was loaded, stale or not', () => {
    expect(listCount(0, {})).toBe(0);
    expect(listCount(4, { error: 'HTTP 500' })).toBe(4);
  });
});

describe('DataTable with a load error', () => {
  const columns = [{ key: 'name', header: 'Name', render: row => row.name }];
  const empty = {
    title: 'No providers configured.',
    description: 'Create your first provider to get started.',
    action: <button type="button">Add provider</button>
  };

  it('shows the error with Retry instead of the empty state', async () => {
    const onRetry = jest.fn().mockResolvedValue(undefined);
    render(
      <DataTable
        columns={columns}
        data={[]}
        getRowId={row => row.id}
        empty={empty}
        error="Request failed with status 500"
        errorTitle="Error loading providers"
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Error loading providers')).toBeInTheDocument();
    expect(screen.getByText('Request failed with status 500')).toBeInTheDocument();
    expect(screen.queryByText('No providers configured.')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Create your first provider to get started.')
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add provider' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  it('keeps the rows loaded before the failure below the error', () => {
    render(
      <DataTable
        columns={columns}
        data={[{ id: 'a', name: 'Alpha' }]}
        getRowId={row => row.id}
        empty={empty}
        error="Request failed with status 500"
        onRetry={jest.fn()}
      />
    );
    expect(screen.getByText('Request failed with status 500')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('No providers configured.')).not.toBeInTheDocument();
  });

  it('still shows the empty state when the load succeeded with nothing', () => {
    render(<DataTable columns={columns} data={[]} getRowId={row => row.id} empty={empty} />);
    expect(screen.getByText('No providers configured.')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-load-error')).not.toBeInTheDocument();
  });
});

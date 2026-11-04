// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, useLocation } from 'react-router-dom';
import {
  changeOf,
  formatBucket,
  formatCompact,
  toCsv
} from '../../../client/src/features/admin/components/usage/usageFormat';
import useUsageReportState from '../../../client/src/features/admin/components/usage/useUsageReportState';
import KpiCards from '../../../client/src/features/admin/components/usage/KpiCards';
import BreakdownTable from '../../../client/src/features/admin/components/usage/BreakdownTable';
import {
  fetchUsageBreakdown,
  downloadUsageExport
} from '../../../client/src/api/usageReportsAdminApi';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, f, o) =>
      typeof f === 'string' ? f.replace(/\{\{(\w+)\}\}/g, (_, n) => (o && n in o ? o[n] : '')) : k,
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/api/usageReportsAdminApi', () => ({
  fetchUsageBreakdown: jest.fn(),
  downloadUsageExport: jest.fn()
}));

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

describe('usage format helpers', () => {
  test('change against the previous period', () => {
    expect(changeOf(150, 100)).toEqual({ ratio: 0.5, direction: 'up' });
    expect(changeOf(50, 100).direction).toBe('down');
    expect(changeOf(0, 0)).toEqual({ ratio: 0, direction: 'flat' });
    expect(changeOf(5, 0)).toBe(null);
    expect(changeOf(5, null)).toBe(null);
  });

  test('compact numbers and UTC day labels', () => {
    expect(formatCompact(1500, 'en')).toBe('1.5K');
    expect(formatCompact(2_300_000, 'en')).toBe('2.3M');
    expect(formatBucket('2026-11-04', 'day', 'en')).toMatch(/Nov/);
  });

  test('CSV quoting guards formulas and separators', () => {
    expect(toCsv(['a', 'b'], [['x,y', '=SUM(1)']])).toBe('a,b\n"x,y","=SUM(1)"');
  });
});

function StateProbe() {
  const state = useUsageReportState();
  const location = useLocation();
  return (
    <div>
      <span data-testid="range">{state.range}</span>
      <span data-testid="search">{location.search}</span>
      <button type="button" onClick={() => state.update({ range: '30d', dim: 'group' })}>
        go
      </button>
      <button type="button" onClick={() => state.update({ range: '7d' })}>
        reset
      </button>
    </div>
  );
}

describe('useUsageReportState', () => {
  test('keeps the view in the URL and drops defaults', () => {
    render(
      <MemoryRouter initialEntries={['/admin/usage?range=custom&from=2026-11-05&to=2026-11-01']}>
        <StateProbe />
      </MemoryRouter>
    );
    // An invalid custom span falls back to the default range.
    expect(screen.getByTestId('range')).toHaveTextContent('7d');
    fireEvent.click(screen.getByText('go'));
    expect(screen.getByTestId('search').textContent).toContain('range=30d');
    expect(screen.getByTestId('search').textContent).toContain('dim=group');
    fireEvent.click(screen.getByText('reset'));
    expect(screen.getByTestId('search').textContent).not.toContain('range=');
  });
});

describe('KpiCards', () => {
  test('shows values and the change against the previous period', () => {
    render(
      <KpiCards
        totals={{ requests: 200, errorRate: 0.1, errors: 20, activeUsers: 4, cacheHitRate: 0.5 }}
        previous={{ requests: 100, errorRate: 0.05, activeUsers: 4 }}
      />
    );
    const requests = screen.getByTestId('usage-kpi-requests');
    expect(requests).toHaveTextContent('200');
    expect(requests).toHaveTextContent('↑ 100% vs. previous period');
    expect(screen.getByText('No change vs. previous period')).toBeInTheDocument();
  });
});

describe('BreakdownTable', () => {
  const state = {
    rangeParams: { range: '7d' },
    range: '7d',
    dim: 'user',
    sort: 'totalTokens',
    order: 'desc',
    update: jest.fn()
  };

  beforeEach(() => {
    fetchUsageBreakdown.mockReset();
    state.update.mockReset();
  });

  test('renders rows, expands per-model sub-rows and sorts through the URL', async () => {
    fetchUsageBreakdown.mockResolvedValue({
      rows: [
        {
          key: 'alice',
          requests: 3,
          promptTokens: 100,
          cacheReadTokens: 50,
          completionTokens: 10,
          totalTokens: 110,
          errors: 0,
          errorRate: 0,
          latencyP95: 1200,
          lastTs: new Date().toISOString(),
          models: [
            {
              key: 'gpt',
              requests: 3,
              promptTokens: 100,
              cacheReadTokens: 50,
              completionTokens: 10,
              totalTokens: 110,
              errors: 0
            }
          ]
        }
      ]
    });
    render(<BreakdownTable state={state} />);
    await flush();
    expect(fetchUsageBreakdown).toHaveBeenCalledWith({
      range: '7d',
      dimension: 'user',
      sort: 'totalTokens',
      order: 'desc'
    });
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.queryByText('gpt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Per model' }));
    expect(screen.getByText('gpt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Requests/ }));
    expect(state.update).toHaveBeenCalledWith({ sort: 'requests', order: 'desc' });
  });

  test('shows a failed raw export instead of swallowing it', async () => {
    fetchUsageBreakdown.mockResolvedValue({ rows: [] });
    downloadUsageExport.mockRejectedValue(new Error('Export failed: range too large'));
    render(<BreakdownTable state={state} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Raw events CSV/ }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Export failed: range too large');
  });

  test('shows an empty state for a range without data', async () => {
    fetchUsageBreakdown.mockResolvedValue({ rows: [] });
    render(<BreakdownTable state={state} />);
    await flush();
    expect(screen.getByText('Nothing to break down in this range')).toBeInTheDocument();
  });
});

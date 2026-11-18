// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage Reports: once opened, the Limits & quotas tab stays mounted (hidden on
 * the other tabs), so unsaved edits of its settings survive a tab switch.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import AdminUsageReports from '../../../client/src/features/admin/pages/AdminUsageReports';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminUsageMeta: jest.fn().mockResolvedValue({ trackingMode: 'pseudonymous' }),
  updateAdminUsageTrackingMode: jest.fn()
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

jest.mock('../../../client/src/features/admin/components/usage/RangeControl', () => ({
  __esModule: true,
  default: () => <div data-testid="range-control" />
}));
jest.mock('../../../client/src/features/admin/components/usage/UsageOverview', () => ({
  __esModule: true,
  default: () => <div data-testid="usage-overview" />
}));
jest.mock('../../../client/src/features/admin/components/usage/BreakdownTable', () => ({
  __esModule: true,
  default: () => <div data-testid="breakdown" />
}));
jest.mock('../../../client/src/features/admin/components/usage/ReliabilityPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="reliability" />
}));
jest.mock('../../../client/src/features/admin/components/usage/RequestLog', () => ({
  __esModule: true,
  default: () => <div data-testid="requests" />
}));
// The panel stands in with local state, as its settings form has.
jest.mock('../../../client/src/features/admin/components/UsageQuotasPanel', () => ({
  __esModule: true,
  default: function UsageQuotasPanelStub() {
    const [value, setValue] = require('react').useState('100');
    return (
      <input aria-label="Daily budget" value={value} onChange={e => setValue(e.target.value)} />
    );
  }
}));

describe('AdminUsageReports Limits & quotas tab', () => {
  it('keeps unsaved edits when switching to another tab and back', () => {
    render(
      <MemoryRouter initialEntries={['/admin/usage?tab=limits']}>
        <AdminUsageReports />
      </MemoryRouter>
    );
    fireEvent.change(screen.getByLabelText('Daily budget'), { target: { value: '250' } });

    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));
    expect(screen.getByTestId('usage-overview')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Daily budget' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Limits & quotas/ }));
    expect(screen.getByRole('textbox', { name: 'Daily budget' })).toHaveValue('250');
  });
});

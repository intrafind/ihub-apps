// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import QuotaBar, { quotaLevel } from '../../../client/src/shared/components/QuotaBar';
import MyUsagePanel from '../../../client/src/shared/components/MyUsagePanel';
import useMyUsage from '../../../client/src/shared/hooks/useMyUsage';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, f, o) =>
      typeof f === 'string' ? f.replace(/\{\{(\w+)\}\}/g, (_, n) => (o && n in o ? o[n] : '')) : k,
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/hooks/useMyUsage', () => {
  const actual = jest.requireActual('../../../client/src/shared/hooks/useMyUsage');
  return { __esModule: true, ...actual, default: jest.fn() };
});

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe('quotaLevel', () => {
  test('green below 70 %, amber from 70 %, red from 90 % and at the limit', () => {
    expect(quotaLevel(69, 100)).toBe('ok');
    expect(quotaLevel(70, 100)).toBe('warn');
    expect(quotaLevel(89, 100)).toBe('warn');
    expect(quotaLevel(90, 100)).toBe('full');
    expect(quotaLevel(100, 100)).toBe('full');
    expect(quotaLevel(5, 0)).toBe('full');
    expect(quotaLevel(5, null)).toBe('ok');
  });

  test('the bar shows the level colour and a reset countdown', () => {
    const { container } = render(
      <QuotaBar label="Daily" used={75} limit={100} resetAt={inAnHour()} />
    );
    expect(container.querySelector('.bg-amber-500')).toBeInTheDocument();
    expect(screen.getByText(/Resets .* \(in /)).toBeInTheDocument();
  });
});

describe('MyUsagePanel', () => {
  test('shows tokens of the period and the most urgent budget', () => {
    useMyUsage.mockReturnValue({
      data: {
        totals: { day: 1200, week: 5000, month: 42000 },
        buckets: [
          {
            id: 'allModels:month',
            scope: 'allModels',
            window: 'month',
            used: 42000,
            limit: 100000,
            remaining: 58000,
            percent: 42,
            exceeded: false,
            resetAt: inAnHour()
          },
          {
            id: 'model:gpt:day',
            scope: 'model',
            modelId: 'gpt',
            modelName: 'GPT',
            window: 'day',
            used: 950,
            limit: 1000,
            remaining: 50,
            percent: 95,
            exceeded: false,
            resetAt: inAnHour()
          }
        ]
      },
      error: null
    });
    render(<MyUsagePanel />);
    const panel = screen.getByTestId('my-usage-panel');
    expect(panel).toHaveTextContent('My usage');
    expect(panel).toHaveTextContent('GPT · Daily');
    expect(panel).toHaveTextContent('50 tokens left');
  });

  test('says so when no limits apply, and hides on errors', () => {
    useMyUsage.mockReturnValue({
      data: { totals: { day: 0, month: 0 }, buckets: [] },
      error: null
    });
    const { rerender } = render(<MyUsagePanel />);
    expect(screen.getByText('No token limits apply to you.')).toBeInTheDocument();
    useMyUsage.mockReturnValue({ data: null, error: new Error('x') });
    rerender(<MyUsagePanel />);
    expect(screen.queryByTestId('my-usage-panel')).not.toBeInTheDocument();
  });
});

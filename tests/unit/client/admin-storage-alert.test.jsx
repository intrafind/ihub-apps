/**
 * Low-disk banner shown above every admin page: appears at the warning and
 * critical thresholds, links to System Resources when that page is enabled,
 * can be dismissed for the session (a dismissed warning returns when the disk
 * turns critical), and stays quiet for content admins, who may not call the
 * endpoint behind it.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));

import AdminStorageAlert from '../../../client/src/features/admin/components/AdminStorageAlert';

const GiB = 1024 ** 3;

function respond(storage) {
  mockMakeAdminApiCall.mockResolvedValue({ data: { storage } });
}

function renderAlert(props = {}) {
  return render(
    <MemoryRouter>
      <AdminStorageAlert {...props} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.useRealTimers();
  mockMakeAdminApiCall.mockReset();
  sessionStorage.clear();
});

test('warns when disk space is critically low and links to the details', async () => {
  respond({ status: 'critical', usedPercent: 95, available: 1 * GiB, total: 20 * GiB });
  renderAlert();

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Disk space is critically low: 1.0 GB free (95% used).'
  );
  expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/system/storage');
  expect(screen.getByRole('link', { name: /View system resources/ })).toHaveAttribute(
    'href',
    '/admin/system-resources'
  );
});

test('shows nothing while disk space is fine or unknown', async () => {
  respond({ status: 'ok', usedPercent: 20, available: 40 * GiB, total: 50 * GiB });
  const { unmount } = renderAlert();
  await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount();

  respond(null);
  renderAlert();
  await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a failed check shows nothing rather than an error', async () => {
  mockMakeAdminApiCall.mockRejectedValue(new Error('Access denied'));
  renderAlert();
  await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('does not link to the System Resources page when system pages are hidden', async () => {
  respond({ status: 'warning', usedPercent: 85, available: 3 * GiB, total: 20 * GiB });
  renderAlert({ linkVisible: false });

  expect(await screen.findByRole('alert')).toHaveTextContent('Disk space is running low');
  expect(screen.queryByRole('link', { name: /View system resources/ })).not.toBeInTheDocument();
});

test('content admins never call the endpoint', async () => {
  respond({ status: 'critical', usedPercent: 95, available: 1 * GiB, total: 20 * GiB });
  renderAlert({ enabled: false });
  await act(async () => {});
  expect(mockMakeAdminApiCall).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('hidden on the System Resources page, which has its own alert', async () => {
  respond({ status: 'critical', usedPercent: 95, available: 1 * GiB, total: 20 * GiB });
  renderAlert({ hidden: true });
  await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a dismissed warning stays hidden for the rest of the session', async () => {
  respond({ status: 'warning', usedPercent: 85, available: 3 * GiB, total: 20 * GiB });
  const { unmount } = renderAlert();
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount();

  // Same status on the next page: still dismissed.
  renderAlert();
  await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a dismissed warning returns once the disk turns critical', async () => {
  sessionStorage.setItem('ihub.admin.storageAlertDismissed', 'warning');
  respond({ status: 'critical', usedPercent: 95, available: 1 * GiB, total: 20 * GiB });
  renderAlert();
  expect(await screen.findByRole('alert')).toHaveTextContent('critically low');
});

test('re-checks every five minutes', async () => {
  jest.useFakeTimers();
  respond({ status: 'ok', usedPercent: 20, available: 40 * GiB, total: 50 * GiB });
  renderAlert();
  await act(async () => {});
  expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(1);

  respond({ status: 'warning', usedPercent: 85, available: 3 * GiB, total: 20 * GiB });
  await act(async () => {
    jest.advanceTimersByTime(5 * 60 * 1000);
  });
  expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('alert')).toHaveTextContent('running low');
});

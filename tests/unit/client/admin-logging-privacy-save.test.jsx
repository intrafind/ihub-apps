// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * OB-B10: "Save Privacy Settings" saves what its label says. It used to send
 * the whole logging block it held, so a pending, unsaved change of the log
 * level in the card above was written too. It now sends `anonymizeIp` alone;
 * the server merges it into the stored logging block.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockAdminCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...a) => mockAdminCall(...a)
}));
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const AdminLoggingPage =
  require('../../../client/src/features/admin/pages/AdminLoggingPage').default;

beforeEach(() => {
  mockAdminCall.mockReset();
  mockAdminCall.mockImplementation(async (url, options = {}) => {
    if (options.method && options.method !== 'GET') return { data: {} };
    if (url === '/admin/logging/config') {
      return { data: { level: 'info', format: 'json', anonymizeIp: 'off' } };
    }
    if (url === '/admin/audit-log/settings') return { data: { anonymizeIp: 'off' } };
    return { data: {} };
  });
});

test('the privacy card sends only anonymizeIp, not a pending log-level change', async () => {
  render(<AdminLoggingPage />);
  const privacySelect = await screen.findByLabelText('Anonymize IP in structured logs');

  // A pending, unsaved change in the logging card above.
  fireEvent.click(screen.getByRole('button', { name: /^debug/i }));
  fireEvent.change(privacySelect, { target: { value: 'mask' } });

  fireEvent.click(screen.getByRole('button', { name: 'Save Privacy Settings' }));

  await waitFor(() =>
    expect(mockAdminCall).toHaveBeenCalledWith(
      '/admin/logging/config',
      expect.objectContaining({ method: 'PUT' })
    )
  );
  const [, options] = mockAdminCall.mock.calls.find(
    ([url, o]) => url === '/admin/logging/config' && o?.method === 'PUT'
  );
  expect(options.body).toEqual({ anonymizeIp: 'mask' });
});

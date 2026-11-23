// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * OB-B10: the privacy block saves what it holds: only `anonymizeIp`. It used to send
 * the whole logging block it held, so a pending, unsaved change of the log
 * level in the card above was written too. It now sends `anonymizeIp` alone;
 * the server merges it into the stored logging block.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
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
  // The page captures its saved baseline a moment after the load; an edit before that would
  // count as loaded.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  // A pending, unsaved change in the logging card above.
  fireEvent.click(screen.getByRole('button', { name: /^debug/i }));
  fireEvent.change(privacySelect, { target: { value: 'mask' } });

  fireEvent.click(
    within(screen.getByRole('region', { name: /save changes/i })).getByRole('button', {
      name: 'Save Changes'
    })
  );

  const puts = () =>
    mockAdminCall.mock.calls.filter(
      ([url, o]) => url === '/admin/logging/config' && o?.method === 'PUT'
    );
  await waitFor(() => expect(puts()).toHaveLength(2));
  // One Save, two blocks, in page order: the logging block first (it carries the level), then
  // the privacy block, which sends `anonymizeIp` alone and is therefore the last word on it.
  const [[, logging], [, privacy]] = puts();
  expect(logging.body.level).toBe('debug');
  expect(privacy.body).toEqual({ anonymizeIp: 'mask' });
});

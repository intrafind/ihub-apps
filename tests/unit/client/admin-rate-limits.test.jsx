/**
 * Admin → Security → Rate limits. The section edits `rateLimit` in
 * platform.json through `/api/admin/rate-limits`: one row per limiter with
 * its limit, its window (shown in minutes, sent in milliseconds) and which
 * requests count. The limiters are built at startup, so the section says when
 * the saved limits are not the ones the server is running with.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
const mockT = (key, options = {}) =>
  Object.entries(options).reduce((out, [name, value]) => out.replace(`{{${name}}}`, value), key);
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  useTranslation: () => mockI18n
}));

const RateLimitConfigModule = require('../../../client/src/features/admin/components/RateLimitConfig');
const RateLimitConfig = RateLimitConfigModule.default;
const { toRequest } = RateLimitConfigModule;

const LIMITERS = {
  publicApi: { windowMs: 60000, limit: 500, counts: 'successful' },
  adminApi: { windowMs: 60000, limit: 100, counts: 'successful' },
  authApi: { windowMs: 900000, limit: 30, counts: 'all' },
  oauthApi: { windowMs: 60000, limit: 300, counts: 'all' },
  oauthTokenApi: { windowMs: 900000, limit: 30, counts: 'failed' },
  inferenceApi: { windowMs: 60000, limit: 500, counts: 'successful' }
};

function setup({ running = LIMITERS, restartRequired = false } = {}) {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async (url, { method, body } = {}) => {
    if (method === 'PUT') {
      return {
        data: { limiters: { ...LIMITERS, ...body.limiters }, running, restartRequired: true }
      };
    }
    return { data: { limiters: LIMITERS, running, restartRequired } };
  });
  render(<RateLimitConfig />);
  return screen.findByTestId('rate-limit-oauthTokenApi');
}

describe('RateLimitConfig', () => {
  test('shows every limiter with its window in minutes', async () => {
    await setup();
    expect(
      screen.getByLabelText('admin.security.rateLimits.limit', {
        selector: '#rate-limit-oauthApi-limit'
      })
    ).toHaveValue(300);
    expect(document.querySelector('#rate-limit-oauthApi-window')).toHaveValue(1);
    expect(document.querySelector('#rate-limit-oauthTokenApi-window')).toHaveValue(15);
    expect(document.querySelector('#rate-limit-oauthTokenApi-counts')).toHaveValue('failed');
    expect(screen.queryByTestId('rate-limits-restart')).not.toBeInTheDocument();
  });

  test('saves the limits in milliseconds and says a restart applies them', async () => {
    await setup();
    fireEvent.change(document.querySelector('#rate-limit-oauthApi-limit'), {
      target: { value: '1200' }
    });
    fireEvent.change(document.querySelector('#rate-limit-oauthApi-window'), {
      target: { value: '2' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'admin.security.rateLimits.save' }));

    await waitFor(() =>
      expect(mockMakeAdminApiCall).toHaveBeenCalledWith(
        '/admin/rate-limits',
        expect.objectContaining({ method: 'PUT' })
      )
    );
    const [, { body }] = mockMakeAdminApiCall.mock.calls.find(([, o]) => o?.method === 'PUT');
    expect(body.limiters.oauthApi).toEqual({ windowMs: 120000, limit: 1200, counts: 'all' });
    expect(body.limiters.oauthTokenApi).toEqual({ windowMs: 900000, limit: 30, counts: 'failed' });
    expect(await screen.findByTestId('rate-limits-restart')).toBeInTheDocument();
  });

  test('shows what the server is still running with', async () => {
    await setup({
      running: { ...LIMITERS, oauthApi: { windowMs: 900000, limit: 50, counts: 'all' } },
      restartRequired: true
    });
    expect(screen.getByTestId('rate-limits-restart')).toBeInTheDocument();
    expect(screen.getByTestId('rate-limit-oauthApi')).toHaveTextContent(
      'admin.security.rateLimits.runningNow'
    );
    // Limiters that are running as saved get no such line.
    expect(screen.getByTestId('rate-limit-oauthTokenApi')).not.toHaveTextContent(
      'admin.security.rateLimits.runningNow'
    );
  });

  test('does not send an invalid limit', async () => {
    await setup();
    fireEvent.change(document.querySelector('#rate-limit-authApi-limit'), {
      target: { value: '0' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'admin.security.rateLimits.save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('admin.security.rateLimits.invalid');
    expect(mockMakeAdminApiCall.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
  });
});

describe('toRequest', () => {
  test.each([
    ['a fractional limit', { limit: '2.5', minutes: '1', counts: 'all' }],
    ['a window under a second', { limit: '5', minutes: '0.001', counts: 'all' }],
    ['a window over a day', { limit: '5', minutes: '1441', counts: 'all' }],
    ['an empty window', { limit: '5', minutes: '', counts: 'all' }]
  ])('refuses %s', (_label, value) => {
    expect(toRequest({ oauthApi: value })).toEqual({ invalid: 'oauthApi' });
  });

  test('turns half a minute into 30 seconds', () => {
    expect(toRequest({ oauthApi: { limit: '10', minutes: '0.5', counts: 'failed' } })).toEqual({
      limiters: { oauthApi: { windowMs: 30000, limit: 10, counts: 'failed' } }
    });
  });
});

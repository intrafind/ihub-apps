// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rate limits, SSRF allowlist and tool approval sections of the Security page share one
 * save bar. With the real dirty tracking: no bar until a section changes (also for an edit
 * deep in a nested field), one Save saves the changed sections in order and stops at the
 * first failure, Discard puts every section back, and a section that did not load offers
 * nothing to save.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockApi(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

const RateLimitConfig =
  require('../../../client/src/features/admin/components/RateLimitConfig').default;
const SsrfConfig = require('../../../client/src/features/admin/components/SsrfConfig').default;
const ToolApprovalConfig =
  require('../../../client/src/features/admin/components/ToolApprovalConfig').default;
const {
  SaveSectionsProvider,
  SaveSectionsBar
} = require('../../../client/src/features/admin/components/SaveSections');

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

const LIMITERS = {
  publicApi: { windowMs: 60000, limit: 500, counts: 'successful' },
  adminApi: { windowMs: 60000, limit: 100, counts: 'successful' },
  authApi: { windowMs: 900000, limit: 30, counts: 'all' },
  oauthApi: { windowMs: 60000, limit: 300, counts: 'all' },
  oauthTokenApi: { windowMs: 900000, limit: 30, counts: 'failed' },
  inferenceApi: { windowMs: 60000, limit: 500, counts: 'successful' }
};

/** The calls that change something, in the order they were made: `PUT /x`, `PATCH /y`. */
const writes = () =>
  mockApi.mock.calls
    .filter(([, options]) => options?.method === 'PUT' || options?.method === 'PATCH')
    .map(([url, options]) => ({ url, method: options.method, body: options.body }));

/** The server: every card loads, every write succeeds unless `fail` names its URL. */
function serve({ fail = [], loadFails = [] } = {}) {
  mockApi.mockReset();
  mockApi.mockImplementation(async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET' && loadFails.includes(url)) throw new Error(`cannot load ${url}`);
    if (method !== 'GET' && fail.includes(url)) throw new Error(`cannot save ${url}`);
    if (url === '/admin/rate-limits') {
      return method === 'PUT'
        ? { data: { limiters: { ...LIMITERS, ...options.body.limiters }, running: LIMITERS } }
        : { data: { limiters: LIMITERS, running: LIMITERS, restartRequired: false } };
    }
    if (url === '/admin/ssrf/config') {
      return { data: { allowedHosts: ['api.internal'] } };
    }
    if (url === '/admin/ssl/config') return { data: { domainWhitelist: [] } };
    if (url === '/admin/configs/platform') {
      return { data: { toolApproval: { defaults: { external: 'writes' } } } };
    }
    return { data: {} };
  });
}

async function renderSections() {
  render(
    <SaveSectionsProvider>
      <RateLimitConfig />
      <SsrfConfig />
      <ToolApprovalConfig />
      <SaveSectionsBar />
    </SaveSectionsProvider>
  );
  await screen.findByTestId('rate-limit-oauthTokenApi');
  await screen.findByText('api.internal');
  await screen.findByLabelText('All tools');
  await act(async () => {});
}

const bar = () => screen.queryByRole('region');
const barButtons = () => within(bar()).getAllByRole('button');
const discard = () => barButtons()[0];
const save = () => barButtons().at(-1);
const limitInput = key => document.querySelector(`#rate-limit-${key}-limit`);
const hostInput = () => screen.getByPlaceholderText('*.intrafind.io, api.internal.company.com');

describe('Security sections with one save bar', () => {
  test('no bar until a section changes', async () => {
    serve();
    await renderSections();
    expect(bar()).not.toBeInTheDocument();
  });

  test('an edit of one limiter alone shows the bar, and Discard puts it back', async () => {
    serve();
    await renderSections();

    // Only the nested `limit` of one limiter changes.
    fireEvent.change(limitInput('oauthApi'), { target: { value: '999' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discard());
    expect(limitInput('oauthApi')).toHaveValue(300);
    expect(bar()).not.toBeInTheDocument();
  });

  test('adding a host shows the bar; a host typed but not added is not a change', async () => {
    serve();
    await renderSections();

    fireEvent.change(hostInput(), { target: { value: 'typed.internal' } });
    expect(bar()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    expect(bar()).toBeInTheDocument();
    expect(screen.getByText('typed.internal')).toBeInTheDocument();

    fireEvent.click(discard());
    expect(screen.queryByText('typed.internal')).not.toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
  });

  test('Discard also drops a host that was typed and not yet added', async () => {
    serve();
    await renderSections();
    fireEvent.change(hostInput(), { target: { value: 'half.typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    fireEvent.change(hostInput(), { target: { value: 'still.typing' } });

    fireEvent.click(discard());

    expect(hostInput()).toHaveValue('');
  });

  test('a changed approval default shows the bar and Discard restores it', async () => {
    serve();
    await renderSections();

    fireEvent.change(screen.getByLabelText('All tools'), { target: { value: 'always' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discard());
    expect(screen.getByLabelText('All tools')).toHaveValue('');
    expect(bar()).not.toBeInTheDocument();
  });

  test('one Save saves the changed sections in order, with the right bodies', async () => {
    serve();
    await renderSections();
    fireEvent.change(screen.getByLabelText('All tools'), { target: { value: 'always' } });
    fireEvent.change(hostInput(), { target: { value: 'new.internal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    fireEvent.change(limitInput('oauthApi'), { target: { value: '1200' } });
    fireEvent.change(document.querySelector('#rate-limit-oauthApi-window'), {
      target: { value: '2' }
    });

    await act(async () => {
      fireEvent.click(save());
    });

    const made = writes();
    expect(made.map(call => `${call.method} ${call.url}`)).toEqual([
      'PUT /admin/rate-limits',
      'PUT /admin/ssrf/config',
      'PATCH /admin/configs/platform'
    ]);
    expect(made[0].body.limiters.oauthApi).toEqual(
      expect.objectContaining({ limit: 1200, windowMs: 120000 })
    );
    expect(made[1].body).toEqual({ allowedHosts: ['api.internal', 'new.internal'] });
    expect(made[2].body).toEqual({
      toolApproval: { defaults: { default: 'always', internal: null, external: 'writes' } }
    });
    expect(bar()).not.toBeInTheDocument();
  });

  test('a section that did not change is not saved', async () => {
    serve();
    await renderSections();
    fireEvent.change(hostInput(), { target: { value: 'only.this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));

    await act(async () => {
      fireEvent.click(save());
    });

    expect(writes().map(call => call.url)).toEqual(['/admin/ssrf/config']);
  });

  test('a failed save stops the rest, keeps the bar and names the error in it', async () => {
    serve({ fail: ['/admin/rate-limits'] });
    await renderSections();
    fireEvent.change(limitInput('oauthApi'), { target: { value: '1200' } });
    fireEvent.change(hostInput(), { target: { value: 'new.internal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));

    await act(async () => {
      fireEvent.click(save());
    });

    // The first section failed: the SSRF allowlist was not saved after it.
    expect(writes().map(call => call.url)).toEqual(['/admin/rate-limits']);
    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText('cannot save /admin/rate-limits')).toBeInTheDocument();
  });

  test('a retry saves only what is left: the section that saved is not sent again', async () => {
    serve({ fail: ['/admin/ssrf/config'] });
    await renderSections();
    fireEvent.change(limitInput('oauthApi'), { target: { value: '1200' } });
    fireEvent.change(hostInput(), { target: { value: 'new.internal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));

    await act(async () => {
      fireEvent.click(save());
    });
    expect(writes().map(call => call.url)).toEqual(['/admin/rate-limits', '/admin/ssrf/config']);
    expect(within(bar()).getByText('cannot save /admin/ssrf/config')).toBeInTheDocument();

    serve();
    await act(async () => {
      fireEvent.click(save());
    });

    // Rate limits were saved the first time: only the allowlist is sent now.
    expect(writes().map(call => call.url)).toEqual(['/admin/ssrf/config']);
    expect(bar()).not.toBeInTheDocument();
  });

  test('an invalid limit is not sent and the bar names it', async () => {
    serve();
    await renderSections();
    fireEvent.change(limitInput('authApi'), { target: { value: '0' } });

    await act(async () => {
      fireEvent.click(save());
    });

    expect(writes()).toEqual([]);
    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText('admin.security.rateLimits.invalid')).toBeInTheDocument();
  });

  test('a section that did not load offers nothing to save', async () => {
    serve({ loadFails: ['/admin/ssrf/config'] });
    render(
      <SaveSectionsProvider>
        <SsrfConfig />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('*.intrafind.io, api.internal.company.com')).toBeNull();
    expect(bar()).not.toBeInTheDocument();
    expect(writes()).toEqual([]);
  });
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Integrations → Requests: internal websites for the Website Corpus.
 *
 *   - open requests show the host, who asked and why; Approve and Decline send
 *     the optional note, reload the list and say what happened;
 *   - approved and declined hosts are listed, an approval can be withdrawn, a
 *     decline reversed;
 *   - an admin can allow a host (or a wildcard) without a request;
 *   - a failed change shows the server's message, a failed load an error;
 *   - the panel tells the sidebar how many requests are open, and the sidebar
 *     badge adds them to the integration requests;
 *   - every text is in the English and German translations.
 */
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const mockApi = {
  fetchWebsiteCorpusDomains: jest.fn(),
  addWebsiteCorpusDomain: jest.fn(),
  approveWebsiteCorpusDomain: jest.fn(),
  declineWebsiteCorpusDomain: jest.fn(),
  removeWebsiteCorpusDomain: jest.fn(),
  fetchIntegrationRequests: jest.fn()
};
jest.mock('../../../client/src/api/websiteCorpusAdminApi', () => ({
  fetchWebsiteCorpusDomains: (...args) => mockApi.fetchWebsiteCorpusDomains(...args),
  addWebsiteCorpusDomain: (...args) => mockApi.addWebsiteCorpusDomain(...args),
  approveWebsiteCorpusDomain: (...args) => mockApi.approveWebsiteCorpusDomain(...args),
  declineWebsiteCorpusDomain: (...args) => mockApi.declineWebsiteCorpusDomain(...args),
  removeWebsiteCorpusDomain: (...args) => mockApi.removeWebsiteCorpusDomain(...args)
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchIntegrationRequests: (...args) => mockApi.fetchIntegrationRequests(...args)
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error',
  makeAdminApiCall: jest.fn()
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: endpoint => `/api/${String(endpoint).replace(/^\//, '')}`,
  buildAssetUrl: url => url
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const WebsiteCorpusDomainsPanel =
  require('../../../client/src/features/admin/components/integrations/WebsiteCorpusDomainsPanel').default;
const hookModule = require('../../../client/src/features/admin/hooks/useIntegrationRequestCount');
const useIntegrationRequestCount = hookModule.default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`
  });
});

const requested = (id, host, reasons = []) => ({
  id,
  host,
  status: 'requested',
  source: 'request',
  requesters: reasons.map(([userId, name, reason]) => ({
    userId,
    name,
    reason,
    at: '2026-11-02T10:00:00Z'
  })),
  createdAt: '2026-11-02T10:00:00Z',
  decidedBy: null,
  decidedAt: null,
  note: null
});
const decided = (id, host, status, note = null) => ({
  ...requested(id, host),
  status,
  decidedBy: { id: 'admin', name: 'Admin' },
  decidedAt: '2026-11-03T09:00:00Z',
  note
});

const queue = items => ({
  items,
  nextCursor: null,
  openCount: items.filter(item => item.status === 'requested').length
});

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchWebsiteCorpusDomains.mockResolvedValue(
    queue([
      requested('wd_1', 'wiki.corp', [
        ['alice', 'Alice', 'Size the wiki'],
        ['bob', 'Bob', null]
      ]),
      decided('wd_2', 'docs.corp', 'approved', 'fine'),
      decided('wd_3', 'old.corp', 'declined')
    ])
  );
  for (const key of ['add', 'approve', 'decline', 'remove']) {
    mockApi[`${key}WebsiteCorpusDomain`].mockResolvedValue({});
  }
});

const renderPanel = async () => {
  const view = render(<WebsiteCorpusDomainsPanel />);
  await screen.findByText('Open requests (1)');
  return view;
};

describe('WebsiteCorpusDomainsPanel', () => {
  test('lists open requests with who asked and why, and the decided hosts', async () => {
    const { container } = await renderPanel();
    const request = screen.getByTestId('domain-request');
    expect(within(request).getByText('wiki.corp')).toBeInTheDocument();
    expect(request).toHaveTextContent('Requested by Alice, Bob');
    expect(request).toHaveTextContent('Alice: Size the wiki');
    const rows = screen.getAllByTestId('domain-decided');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('docs.corp');
    expect(rows[0]).toHaveTextContent('Approved');
    expect(rows[0]).toHaveTextContent('fine');
    expect(rows[1]).toHaveTextContent('Declined');
    expect(container.textContent).not.toContain('MISSING:');
  });

  test('approves with the note, reloads and says so', async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Note for the requesters (optional)'), {
      target: { value: 'Go ahead' }
    });
    mockApi.fetchWebsiteCorpusDomains.mockResolvedValueOnce(
      queue([decided('wd_1', 'wiki.corp', 'approved', 'Go ahead')])
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve wiki.corp' }));
    await waitFor(() =>
      expect(mockApi.approveWebsiteCorpusDomain).toHaveBeenCalledWith('wd_1', { note: 'Go ahead' })
    );
    expect(await screen.findByText('wiki.corp is approved.')).toBeInTheDocument();
    expect(await screen.findByText('Open requests (0)')).toBeInTheDocument();
  });

  test('declines without a note when none was typed', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Decline wiki.corp' }));
    await waitFor(() =>
      expect(mockApi.declineWebsiteCorpusDomain).toHaveBeenCalledWith('wd_1', { note: undefined })
    );
    expect(await screen.findByText('wiki.corp is declined.')).toBeInTheDocument();
  });

  test('withdraws an approval and reverses a decline', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw docs.corp' }));
    await waitFor(() => expect(mockApi.removeWebsiteCorpusDomain).toHaveBeenCalledWith('wd_2'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve old.corp' }));
    await waitFor(() => expect(mockApi.approveWebsiteCorpusDomain).toHaveBeenCalledWith('wd_3'));
  });

  test('allows a host or a wildcard without a request, and clears the form', async () => {
    await renderPanel();
    const add = screen.getByRole('button', { name: 'Allow host' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: ' *.corp.example ' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'whole dept' } });
    fireEvent.click(add);
    await waitFor(() =>
      expect(mockApi.addWebsiteCorpusDomain).toHaveBeenCalledWith('*.corp.example', {
        note: 'whole dept'
      })
    );
    expect(await screen.findByText('*.corp.example is allowed now.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Host')).toHaveValue(''));
  });

  test('keeps the typed host in the form when the server refuses it', async () => {
    await renderPanel();
    mockApi.addWebsiteCorpusDomain.mockRejectedValueOnce({
      response: { data: { detail: 'A wildcard needs a domain below it' } }
    });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '*.corp' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'dept' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allow host' }));
    expect(await screen.findByText('A wildcard needs a domain below it')).toBeInTheDocument();
    expect(screen.getByLabelText('Host')).toHaveValue('*.corp');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('dept');
  });

  test("shows the server's message when a change fails, in the live region", async () => {
    await renderPanel();
    mockApi.approveWebsiteCorpusDomain.mockRejectedValueOnce({
      response: { data: { detail: 'No such request' } }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve wiki.corp' }));
    const status = await screen.findByText('No such request');
    expect(status.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
  });

  test('says so when the list cannot be loaded', async () => {
    mockApi.fetchWebsiteCorpusDomains.mockRejectedValue(new Error('down'));
    render(<WebsiteCorpusDomainsPanel />);
    expect(
      await screen.findByText('The internal websites could not be loaded.')
    ).toBeInTheDocument();
  });

  test('tells the sidebar how many requests are open', async () => {
    const seen = [];
    const listener = event => seen.push(event.detail.openCount);
    window.addEventListener(hookModule.WEBSITE_CORPUS_DOMAINS_EVENT, listener);
    await renderPanel();
    window.removeEventListener(hookModule.WEBSITE_CORPUS_DOMAINS_EVENT, listener);
    expect(seen).toEqual([1]);
  });

  test('has English and German texts for every key the panel uses', () => {
    const keys = [];
    const walk = (object, prefix) =>
      Object.entries(object).forEach(([key, value]) =>
        typeof value === 'object' ? walk(value, `${prefix}.${key}`) : keys.push(`${prefix}.${key}`)
      );
    walk(en.admin.websiteCorpusDomains, 'admin.websiteCorpusDomains');
    expect(keys.length).toBeGreaterThan(20);
    const untranslated = [];
    for (const key of keys) {
      const german = mockI18n.getFixedT('de')(key);
      // A missing key answers with the marker of parseMissingKeyHandler, not with the key itself.
      expect(german).not.toMatch(/^MISSING:/);
      expect(german).not.toBe(key);
      if (german === mockI18n.getFixedT('en')(key)) untranslated.push(german);
    }
    // The only word that is the same in both languages.
    expect(untranslated).toEqual(['Host']);
  });
});

describe('the sidebar count', () => {
  test('adds the open website requests to the integration requests, and follows both', async () => {
    mockApi.fetchIntegrationRequests.mockResolvedValue({ requests: [], openCount: 2 });
    mockApi.fetchWebsiteCorpusDomains.mockResolvedValue({ items: [], openCount: 3 });
    const { result } = renderHook(() => useIntegrationRequestCount(true));
    await waitFor(() => expect(result.current).toBe(5));
    act(() => hookModule.announceWebsiteCorpusDomainCount(1));
    expect(result.current).toBe(3);
    act(() => hookModule.announceIntegrationRequestCount(0));
    expect(result.current).toBe(1);
  });

  test('is zero for anyone who is not allowed to read the queues, and survives a failing queue', async () => {
    expect(renderHook(() => useIntegrationRequestCount(false)).result.current).toBe(0);
    mockApi.fetchIntegrationRequests.mockResolvedValue({ openCount: 2 });
    mockApi.fetchWebsiteCorpusDomains.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useIntegrationRequestCount(true));
    await waitFor(() => expect(result.current).toBe(2));
  });
});

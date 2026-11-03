// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Settings → Integrations, "Not available yet" (#2926): the catalog
 * integrations the user's groups cannot use yet, read-only, with Request.
 *
 *   - Request asks for an optional, bounded reason, sends it, and the row
 *     shows "Requested" without a Request button;
 *   - an approved request reads "Approved, being set up"; a declined one shows
 *     the administrator's note and offers "Request again";
 *   - a second request the server refuses (REQUEST_EXISTS) shows as requested;
 *   - nothing is rendered when there is nothing to request;
 *   - the texts exist in English and German.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const i18n = i18next.createInstance();
i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  initImmediate: false,
  resources: { en: { translation: en }, de: { translation: de } },
  interpolation: { escapeValue: false },
  parseMissingKeyHandler: key => `MISSING:${key}`
});
const mockI18n = { t: i18n.t.bind(i18n), i18n };
jest.mock('react-i18next', () => ({
  useTranslation: () => mockI18n
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: endpoint => `/api/${String(endpoint).replace(/^\//, '')}`,
  buildAssetUrl: url => url
}));
const mockFetch = jest.fn();
const mockRequest = jest.fn();
jest.mock('../../../client/src/api/userIntegrationsApi', () => ({
  fetchRequestableIntegrations: (...args) => mockFetch(...args),
  requestIntegration: (...args) => mockRequest(...args)
}));

const RequestableIntegrations =
  require('../../../client/src/features/settings/components/RequestableIntegrations').default;

const item = (definition, name, request = null) => ({
  definition,
  name,
  description: `About ${name}`,
  icon: null,
  publisher: 'Example',
  categories: ['knowledge'],
  capabilities: ['tools'],
  actionCount: 2,
  effects: ['read'],
  request
});

const ITEMS = [
  item('com.example/crm', 'CRM'),
  item('com.example/docs', 'Docs', { id: 'r1', status: 'open', createdAt: '2026-11-02' }),
  item('com.example/hr', 'HR', { id: 'r2', status: 'approved', createdAt: '2026-11-01' }),
  item('com.example/wiki', 'Wiki', {
    id: 'r3',
    status: 'declined',
    note: 'Not licensed',
    createdAt: '2026-10-01'
  })
];

const rowOf = definition =>
  screen
    .getAllByTestId('requestable-row')
    .find(row => row.getAttribute('data-definition') === definition);

beforeEach(() => {
  jest.clearAllMocks();
  i18n.changeLanguage('en');
  mockFetch.mockResolvedValue(ITEMS);
});

describe('Not available yet', () => {
  test('lists the catalog entries with the state of each request', async () => {
    const onMessage = jest.fn();
    render(<RequestableIntegrations onMessage={onMessage} />);
    expect(
      await screen.findByRole('heading', { name: 'Not available yet (4)' })
    ).toBeInTheDocument();

    expect(
      within(rowOf('com.example/crm')).getByRole('button', { name: 'Request CRM' })
    ).toBeEnabled();
    expect(within(rowOf('com.example/docs')).getByTestId('request-state')).toHaveTextContent(
      'Requested'
    );
    expect(within(rowOf('com.example/docs')).queryByRole('button')).toBeNull();
    expect(within(rowOf('com.example/hr')).getByTestId('request-state')).toHaveTextContent(
      'Approved, being set up'
    );
    const wiki = rowOf('com.example/wiki');
    expect(within(wiki).getByTestId('request-state')).toHaveTextContent('Declined');
    expect(within(wiki).getByText('Administrator: Not licensed')).toBeInTheDocument();
    expect(within(wiki).getByRole('button', { name: 'Request Wiki again' })).toBeEnabled();
    expect(screen.queryByText(/MISSING:/)).toBeNull();
  });

  test('Request asks for an optional reason and then shows Requested', async () => {
    const onMessage = jest.fn();
    mockRequest.mockResolvedValue({ id: 'r9', status: 'open', reason: 'Sales pipeline' });
    render(<RequestableIntegrations onMessage={onMessage} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request CRM' }));

    const reason = screen.getByLabelText('Why do you need it? (optional)');
    expect(reason).toHaveAttribute('maxLength', '500');
    fireEvent.change(reason, { target: { value: 'Sales pipeline' } });
    expect(screen.getByText('14 of 500 characters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() =>
      expect(within(rowOf('com.example/crm')).getByTestId('request-state')).toHaveTextContent(
        'Requested'
      )
    );
    expect(mockRequest).toHaveBeenCalledWith('com.example/crm', 'Sales pipeline');
    expect(within(rowOf('com.example/crm')).queryByRole('button')).toBeNull();
    expect(onMessage).toHaveBeenCalledWith({
      type: 'success',
      text: 'Request for CRM sent. An administrator decides.'
    });
  });

  test('Cancel closes the form without sending', async () => {
    render(<RequestableIntegrations onMessage={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request CRM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Why do you need it? (optional)')).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  test('a request the server already has shows as requested', async () => {
    const onMessage = jest.fn();
    mockRequest.mockRejectedValue({
      response: { status: 409, data: { code: 'REQUEST_EXISTS', error: 'exists' } }
    });
    render(<RequestableIntegrations onMessage={onMessage} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request CRM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() =>
      expect(within(rowOf('com.example/crm')).getByTestId('request-state')).toHaveTextContent(
        'Requested'
      )
    );
    expect(onMessage).toHaveBeenCalledWith({
      type: 'error',
      text: 'You have already requested CRM.'
    });
  });

  test('renders nothing when nothing can be requested or the list fails', async () => {
    mockFetch.mockResolvedValue([]);
    const { container, unmount } = render(<RequestableIntegrations onMessage={jest.fn()} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();

    mockFetch.mockRejectedValue(new Error('down'));
    const failed = render(<RequestableIntegrations onMessage={jest.fn()} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(failed.container).toBeEmptyDOMElement();
  });

  test('offers a search from six entries on', async () => {
    mockFetch.mockResolvedValue([
      ...ITEMS,
      item('com.example/a', 'Alpha'),
      item('com.example/b', 'Beta')
    ]);
    render(<RequestableIntegrations onMessage={jest.fn()} />);
    const search = await screen.findByRole('searchbox');
    fireEvent.change(search, { target: { value: 'alp' } });
    expect(screen.getAllByTestId('requestable-row')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing in the catalog matches.')).toBeInTheDocument();
  });

  test('a long list is a short grid until Show all', async () => {
    mockFetch.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => item(`com.example/n${index}`, `Name ${index}`))
    );
    render(<RequestableIntegrations onMessage={jest.fn()} />);
    expect(await screen.findAllByTestId('requestable-row')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10' }));
    expect(screen.getAllByTestId('requestable-row')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByTestId('requestable-row')).toHaveLength(6);

    // A search looks through every entry, not only the visible ones.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'name 9' } });
    expect(screen.getAllByTestId('requestable-row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
  });

  test('speaks German', async () => {
    await i18n.changeLanguage('de');
    render(<RequestableIntegrations onMessage={jest.fn()} />);
    expect(
      await screen.findByRole('heading', { name: 'Noch nicht verfügbar (4)' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CRM anfragen' })).toBeInTheDocument();
    expect(within(rowOf('com.example/docs')).getByTestId('request-state')).toHaveTextContent(
      'Angefragt'
    );
  });

  test('every key exists in English and German', () => {
    const walk = (node, prefix = '') =>
      Object.entries(node).flatMap(([key, value]) =>
        typeof value === 'object' ? walk(value, `${prefix}${key}.`) : [`${prefix}${key}`]
      );
    const lookup = (messages, key) => key.split('.').reduce((n, part) => n?.[part], messages);
    for (const root of ['integrations.requests', 'admin.integrations.requests']) {
      const enKeys = walk(lookup(en, root));
      const deKeys = walk(lookup(de, root));
      expect(deKeys.sort()).toEqual(enKeys.sort());
    }
  });
});

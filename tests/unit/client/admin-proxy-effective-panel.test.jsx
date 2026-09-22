/**
 * Admin → System → Outbound Proxy: the "In effect right now" panel.
 *
 * The panel reports the server's state, and an admin reads it right after
 * typing into the editor above it. Two things made it look broken:
 *
 * - a bypass host added to the list showed as "not set" here, with "Not
 *   configured" under the list, because the edit had not been saved yet and
 *   nothing said so;
 * - `urlPatterns` had no row at all, so a saved pattern list was never
 *   reflected.
 *
 * Both are pinned here. Only the admin API and the translation hook are stubbed.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

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

import ProxyConfig from '../../../client/src/features/admin/components/ProxyConfig';

/** The response shape of GET/PUT /api/admin/proxy/config. */
const response = ({ config = {}, effective = {}, provenance = {} } = {}) => ({
  data: {
    config: { enabled: true, http: '', https: '', noProxy: [], urlPatterns: [], ...config },
    effective: { enabled: true, http: '', https: '', noProxy: [], urlPatterns: [], ...effective },
    provenance: {
      enabled: 'default',
      http: 'default',
      https: 'default',
      noProxy: 'default',
      urlPatterns: 'default',
      ...provenance
    },
    unresolvedPlaceholders: {}
  }
});

/** Type a host into the bypass list and press its own Add button. */
const addBypassHost = host => {
  const field = screen.getByPlaceholderText('localhost, .internal.company');
  fireEvent.change(field, { target: { value: host } });
  fireEvent.click(within(field.parentElement).getByRole('button', { name: 'Add' }));
};

/** The panel's value cell for one label, e.g. "No proxy". */
const effectiveRow = label =>
  screen.getByText(label, { selector: 'dt' }).parentElement.querySelector('dd');

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
});

describe('proxy "In effect right now" panel', () => {
  test('shows the saved bypass hosts and URL patterns the server reports', async () => {
    mockMakeAdminApiCall.mockResolvedValue(
      response({
        config: { noProxy: ['localhost'], urlPatterns: ['api\\.openai\\.com'] },
        effective: {
          https: 'http://proxy.example.com:8080',
          noProxy: ['localhost'],
          urlPatterns: ['api\\.openai\\.com']
        },
        provenance: { https: 'platform', noProxy: 'platform', urlPatterns: 'platform' }
      })
    );

    render(<ProxyConfig />);

    await screen.findByText('In effect right now');
    expect(effectiveRow('No proxy')).toHaveTextContent('localhost');
    expect(effectiveRow('URL patterns')).toHaveTextContent('api\\.openai\\.com');
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  test('marks an added bypass host as pending until it is saved', async () => {
    mockMakeAdminApiCall.mockResolvedValue(
      response({
        effective: { http: 'http://proxy.example.com:8080' },
        provenance: { http: 'environment' }
      })
    );

    render(<ProxyConfig />);
    await screen.findByText('In effect right now');
    expect(effectiveRow('No proxy')).toHaveTextContent('not set');

    addBypassHost('localhost');

    // The runtime value is unchanged — what saving would make of it is stated
    // instead of leaving "not set" next to the entry the admin just added.
    expect(effectiveRow('No proxy')).toHaveTextContent('not set');
    expect(effectiveRow('No proxy')).toHaveTextContent('after saving: localhost');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    // The provenance note under the list says so too, so "Not configured"
    // stops reading as a contradiction next to the entry just added.
    expect(screen.getByText(/· unsaved change/)).toBeInTheDocument();
  });

  test('drops the pending note once the save comes back', async () => {
    mockMakeAdminApiCall.mockResolvedValueOnce(response());
    render(<ProxyConfig />);
    await screen.findByText('In effect right now');

    addBypassHost('localhost');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    mockMakeAdminApiCall.mockResolvedValueOnce(
      response({
        config: { noProxy: ['localhost'] },
        effective: { noProxy: ['localhost'] },
        provenance: { noProxy: 'platform' }
      })
    );
    fireEvent.click(screen.getByRole('button', { name: /Save proxy settings/ }));

    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    expect(effectiveRow('No proxy')).toHaveTextContent('localhost');
    expect(effectiveRow('No proxy')).not.toHaveTextContent('after saving');
    const [, saveCall] = mockMakeAdminApiCall.mock.calls;
    expect(saveCall[1].body.noProxy).toEqual(['localhost']);
  });
});

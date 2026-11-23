// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Security: the SSL domain whitelist is also SSRF trust (PL-B12,
 * decision 14a: show the coupling, change no behaviour).
 *
 * - The SSL card shows the whitelist even while "Ignore Invalid SSL
 *   Certificates" is off, with a notice that the SSRF guard trusts these hosts.
 * - The SSRF card lists the same hosts read-only, and reloads them after the
 *   SSL card saved (both cards stay mounted on the Security page); unsaved SSL
 *   edits never show there.
 * - The texts name only the callers that honour the whitelist as SSRF trust.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
const mockT = (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

const SSLConfig = require('../../../client/src/features/admin/components/SSLConfig').default;
const SsrfConfig = require('../../../client/src/features/admin/components/SsrfConfig').default;
const {
  SaveSectionsBar,
  SaveSectionsProvider
} = require('../../../client/src/features/admin/components/SaveSections');

const SAVE_BAR_NAME = /saveBar|Save changes/i;
/** The page's one save bar: sections register with it, so tests render them under it. */
const withSaveBar = ui => (
  <SaveSectionsProvider>
    {ui}
    <SaveSectionsBar />
  </SaveSectionsProvider>
);
const clickBarSave = () =>
  fireEvent.click(
    within(screen.getByRole('region', { name: SAVE_BAR_NAME }))
      .getAllByRole('button')
      .at(-1)
  );

function answer(routes) {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async (url, options = {}) => {
    if (options.method === 'PUT') return { data: {} };
    if (url in routes) {
      const value = routes[url];
      if (value instanceof Error) throw value;
      return { data: value };
    }
    return { data: {} };
  });
}

describe('SSL card', () => {
  test('shows the whitelist and the SSRF notice while invalid certificates are not ignored', async () => {
    answer({
      '/admin/ssl/config': { ignoreInvalidCertificates: false, domainWhitelist: ['llm.internal'] }
    });
    render(<SSLConfig />);

    expect(await screen.findByText('llm.internal')).toBeInTheDocument();
    expect(screen.getByText('admin.system.ssl.domainWhitelist')).toBeInTheDocument();
    const notice = screen.getByTestId('ssl-ssrf-trust-notice');
    expect(notice).toHaveTextContent(/also trusted by the SSRF guard/);
    // Only the callers that use isSsrfTrustedHost are named as trusting it.
    expect(notice).toHaveTextContent(/web sources, website crawls, the page reader/);
    expect(notice).toHaveTextContent(/Tools and MCP servers do not use this list/);
  });
});

describe('SSRF card', () => {
  test('lists the SSL whitelist hosts read-only, next to its own list', async () => {
    answer({
      '/admin/ssrf/config': { allowedHosts: ['tools.internal'] },
      '/admin/ssl/config': {
        ignoreInvalidCertificates: false,
        domainWhitelist: ['llm.internal', '*.corp.example']
      }
    });
    render(<SsrfConfig />);

    const section = await screen.findByTestId('ssrf-tls-trusted-hosts');
    expect(within(section).getByText('llm.internal')).toBeInTheDocument();
    expect(within(section).getByText('*.corp.example')).toBeInTheDocument();
    // Read-only: no remove buttons for these hosts.
    expect(within(section).queryByRole('button')).toBeNull();
    // The card's own, editable list is unchanged.
    expect(screen.getByText('tools.internal')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
  });

  test('keeps working when the SSL whitelist cannot be read', async () => {
    answer({
      '/admin/ssrf/config': { allowedHosts: ['tools.internal'] },
      '/admin/ssl/config': new Error('forbidden')
    });
    render(<SsrfConfig />);

    expect(await screen.findByText('tools.internal')).toBeInTheDocument();
    expect(screen.queryByTestId('ssrf-tls-trusted-hosts')).toBeNull();
  });

  test('says no hosts were added, not that none are trusted, when its own list is empty', async () => {
    answer({
      '/admin/ssrf/config': { allowedHosts: [] },
      '/admin/ssl/config': { domainWhitelist: ['llm.internal'] }
    });
    render(<SsrfConfig />);

    expect(
      await screen.findByText('No hosts explicitly added to the SSRF allowlist.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/No hosts allowed/)).toBeNull();
  });

  test('reloads the SSL whitelist after the SSL card saved, never showing unsaved edits', async () => {
    let saved = ['llm.internal'];
    mockMakeAdminApiCall.mockReset();
    mockMakeAdminApiCall.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/ssl/config' && options.method === 'PUT') {
        saved = options.body.domainWhitelist;
        return { data: {} };
      }
      if (url === '/admin/ssl/config') {
        return { data: { ignoreInvalidCertificates: false, domainWhitelist: saved } };
      }
      if (url === '/admin/ssrf/config') return { data: { allowedHosts: [] } };
      return { data: {} };
    });
    render(
      withSaveBar(
        <>
          <SSLConfig />
          <SsrfConfig />
        </>
      )
    );

    const section = await screen.findByTestId('ssrf-tls-trusted-hosts');
    expect(await within(section).findByText('llm.internal')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('admin.system.ssl.domainWhitelistPlaceholder'), {
      target: { value: 'new.internal' }
    });
    fireEvent.click(screen.getByText('admin.system.ssl.addDomain'));
    // Added on the SSL card, not saved yet: the SSRF card does not show it.
    expect(within(section).queryByText('new.internal')).toBeNull();

    clickBarSave();
    await waitFor(() => expect(within(section).getByText('new.internal')).toBeInTheDocument());
  });
});

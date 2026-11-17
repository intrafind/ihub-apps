// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Security: the SSL domain whitelist is also SSRF trust (PL-B12,
 * decision 14a: show the coupling, change no behaviour).
 *
 * - The SSL card shows the whitelist even while "Ignore Invalid SSL
 *   Certificates" is off, with a notice that the SSRF guard trusts these hosts.
 * - The SSRF card lists the same hosts read-only.
 */
import { render, screen, within } from '@testing-library/react';
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

function answer(routes) {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async url => {
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
    expect(screen.getByTestId('ssl-ssrf-trust-notice')).toHaveTextContent(
      /also trusted by the SSRF guard/
    );
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
});

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ShortLinkHostsConfig, {
  hostEntryFromInput
} from '../../../client/src/features/admin/components/ShortLinkHostsConfig';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';

/**
 * Admin → Short Links → Allowed external hosts: an administrator can allow the
 * host a short link leads to (`platform.shortLinks.allowedHosts`), sees the hosts
 * that stored links lead to but the list refuses, and allows one with a click.
 */

// A stable `t`, as react-i18next gives: the component loads its settings once per `t`.
jest.mock('react-i18next', () => {
  const t = (key, fallback, values) => {
    if (typeof fallback !== 'string') return key;
    return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

jest.mock('../../../client/src/api/adminApi', () => ({ makeAdminApiCall: jest.fn() }));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderConfig(config) {
  makeAdminApiCall.mockResolvedValueOnce({ data: config });
  render(<ShortLinkHostsConfig />);
  await flush();
}

beforeEach(() => {
  makeAdminApiCall.mockReset();
});

describe('hostEntryFromInput', () => {
  it.each([
    ['https://www.qwant.com/', 'www.qwant.com'],
    ['  http://Docs.Example.com:8080/x?y=1 ', 'docs.example.com'],
    ['www.qwant.com', 'www.qwant.com'],
    ['*.example.com', '*.example.com'],
    ['/(a|b)\\.example\\.org/', '/(a|b)\\.example\\.org/']
  ])('reads %j as %j', (input, entry) => {
    expect(hostEntryFromInput(input)).toBe(entry);
  });
});

describe('ShortLinkHostsConfig', () => {
  it('lists the allowed hosts and the hosts of links that do not work', async () => {
    await renderConfig({
      allowedHosts: ['docs.example.com'],
      blockedHosts: [{ host: 'www.qwant.com', links: 3 }]
    });
    expect(makeAdminApiCall).toHaveBeenCalledWith('/admin/shortlinks/config');
    expect(screen.getByText('docs.example.com')).toBeInTheDocument();
    expect(screen.getByText('Links that do not work')).toBeInTheDocument();
    expect(screen.getByText('www.qwant.com')).toBeInTheDocument();
    expect(screen.getByText(/3 links/)).toBeInTheDocument();
  });

  it('allows a blocked host and saves the list', async () => {
    await renderConfig({
      allowedHosts: [],
      blockedHosts: [{ host: 'www.qwant.com', links: 1 }]
    });
    fireEvent.click(screen.getByRole('button', { name: 'Allow www.qwant.com' }));
    // Allowed, though not saved yet: no longer listed as a link that does not work.
    expect(screen.queryByText('Links that do not work')).not.toBeInTheDocument();

    makeAdminApiCall.mockResolvedValueOnce({
      data: { allowedHosts: ['www.qwant.com'], blockedHosts: [] }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowed hosts' }));
    await flush();

    expect(makeAdminApiCall).toHaveBeenLastCalledWith('/admin/shortlinks/config', {
      method: 'PUT',
      body: { allowedHosts: ['www.qwant.com'] }
    });
    expect(screen.getByRole('status')).toHaveTextContent('Allowed hosts saved.');
  });

  it('adds the host of a pasted URL and removes a host', async () => {
    await renderConfig({ allowedHosts: ['old.example'], blockedHosts: [] });
    fireEvent.change(screen.getByRole('textbox', { name: 'Host to allow' }), {
      target: { value: 'https://www.qwant.com/' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove old.example' }));

    makeAdminApiCall.mockResolvedValueOnce({
      data: { allowedHosts: ['www.qwant.com'], blockedHosts: [] }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowed hosts' }));
    await flush();
    expect(makeAdminApiCall).toHaveBeenLastCalledWith('/admin/shortlinks/config', {
      method: 'PUT',
      body: { allowedHosts: ['www.qwant.com'] }
    });
  });

  it('shows why the server refused the list', async () => {
    await renderConfig({ allowedHosts: [], blockedHosts: [] });
    makeAdminApiCall.mockRejectedValueOnce({
      message: 'Request failed with status code 400',
      response: {
        data: {
          code: 'VALIDATION_FAILED',
          detail: 'Invalid allowed hosts: "bad host!" must be a host name'
        }
      }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowed hosts' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('"bad host!" must be a host name');
  });
});

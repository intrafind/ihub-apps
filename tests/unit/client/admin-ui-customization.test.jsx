// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import AdminUICustomization, {
  normalizeUIConfig
} from '../../../client/src/features/admin/pages/AdminUICustomization';
import { followsProductName } from '../../../client/src/features/admin/components/LocalizedWithDefaultField';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';

/**
 * UI Customization saves the whole configuration. An edit of one field (the site
 * title was the one that broke) must leave every other section in what is sent,
 * and the site title follows the product name unless the admin writes their own.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => {
      if (key === 'product.name') return 'Acme AI';
      return typeof fallback === 'string' ? fallback : key;
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  translateText: jest.fn(),
  fetchAdminApps: jest.fn().mockResolvedValue([])
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: path => path,
  buildAssetUrl: path => path,
  buildUploadUrl: path => path,
  buildApiUrl: path => path
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

const mockRefreshUIConfig = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: null, refreshUIConfig: mockRefreshUIConfig })
}));

const STORED = {
  title: { en: '$t(product.name)', de: '$t(product.name)' },
  header: { defaultColor: 'rgb(0, 53, 87)', links: [], tagline: { en: '$t(product.tagline)' } },
  footer: { text: { en: 'footer' }, links: [] },
  pwa: { enabled: false, name: '$t(product.name)', shortName: 'iHub' },
  appsList: { title: { en: 'Apps' } },
  disclaimer: { enabled: true, text: { en: 'Hello' } }
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage() {
  makeAdminApiCall.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/ui/config' && !options.method) {
      return { data: JSON.parse(JSON.stringify(STORED)) };
    }
    return { data: {} };
  });
  render(
    <MemoryRouter initialEntries={['/admin/ui']}>
      <AdminUICustomization />
    </MemoryRouter>
  );
  await flush();
}

describe('AdminUICustomization', () => {
  beforeEach(() => {
    makeAdminApiCall.mockReset();
    mockRefreshUIConfig.mockClear();
  });

  it('has six tabs and no disclaimer', async () => {
    await renderPage();
    const tabs = screen.getAllByRole('tab').map(tab => tab.textContent.trim());
    expect(tabs).toEqual([
      'Branding',
      'Navigation',
      'Start & apps page',
      'Theme & styles',
      'Error Pages',
      'Assets'
    ]);
    expect(screen.queryByText(/Disclaimer/i)).toBeNull();
  });

  it('shows what the default site title resolves to', async () => {
    await renderPage();
    // Site title and PWA name both follow the product name.
    const resolved = screen.getAllByTestId('resolved-product-name');
    expect(resolved).toHaveLength(2);
    resolved.forEach(node => expect(node).toHaveTextContent('Acme AI'));
    expect(screen.queryByRole('region', { name: 'Save changes' })).toBeNull();
  });

  it('saves a custom site title together with every other section', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Custom text per language'));
    fireEvent.change(screen.getByDisplayValue('Acme AI'), { target: { value: 'My Hub' } });
    expect(screen.getByRole('region', { name: 'Save changes' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    await flush();

    const save = makeAdminApiCall.mock.calls.find(([url, options]) => options?.method === 'POST');
    expect(save[0]).toBe('/admin/ui/config');
    const sent = save[1].body.config;
    expect(sent.title).toEqual({ en: 'My Hub' });
    expect(sent.header).toEqual(STORED.header);
    expect(sent.footer).toEqual(STORED.footer);
    expect(sent.pwa).toEqual(STORED.pwa);
    expect(sent.disclaimer).toEqual(STORED.disclaimer);
    expect(mockRefreshUIConfig).toHaveBeenCalled();
    // Saved: nothing left to save.
    expect(screen.queryByRole('region', { name: 'Save changes' })).toBeNull();
  });

  it('reads the page list back after a save, so pages created meanwhile are offered (R10)', async () => {
    await renderPage();
    makeAdminApiCall.mockImplementation(async url => {
      if (url === '/admin/pages') {
        return {
          data: { items: [{ id: 'news', title: { en: 'News' }, contentType: 'markdown' }] }
        };
      }
      return { data: {} };
    });

    fireEvent.click(screen.getByLabelText('Custom text per language'));
    fireEvent.change(screen.getByDisplayValue('Acme AI'), { target: { value: 'My Hub' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    await flush();
    fireEvent.change(screen.getByDisplayValue('My Hub'), { target: { value: 'Our Hub' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    await flush();

    const saves = makeAdminApiCall.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(saves).toHaveLength(2);
    expect(saves[1][1].body.config.pages).toEqual({
      news: { title: { en: 'News' }, contentType: 'markdown' }
    });
  });

  it('marks the tab that holds unsaved changes', async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText('Custom text per language'));
    expect(screen.getByRole('tab', { name: /Branding/ })).toHaveTextContent('unsaved changes');
    expect(screen.getByRole('tab', { name: /Navigation/ })).not.toHaveTextContent('unsaved');
  });

  it('goes back to the product name without losing the custom text until saved', async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText('Custom text per language'));
    fireEvent.change(screen.getByDisplayValue('Acme AI'), { target: { value: 'My Hub' } });
    fireEvent.click(screen.getAllByLabelText('Use the product name (default)')[0]);
    expect(screen.getAllByTestId('resolved-product-name')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Custom text per language'));
    expect(screen.getByDisplayValue('My Hub')).toBeInTheDocument();
  });
});

describe('normalizeUIConfig', () => {
  it('saves an empty site title and PWA name as the product name', () => {
    const config = normalizeUIConfig({ ...STORED, title: { en: '  ' }, pwa: { name: '' } });
    expect(config.title).toEqual({ en: '$t(product.name)' });
    expect(config.pwa.name).toBe('$t(product.name)');
  });

  it('keeps written names and adds no PWA section', () => {
    const config = normalizeUIConfig({ title: { en: 'Mine' }, header: {}, footer: {} });
    expect(config.title).toEqual({ en: 'Mine' });
    expect(config.pwa).toBeUndefined();
  });
});

describe('followsProductName', () => {
  it.each([
    [undefined, true],
    [{}, true],
    [{ en: '$t(product.name)', de: '$t(product.name)' }, true],
    ['$t(product.name)', true],
    [{ en: '$t(product.name)', de: 'Mein Hub' }, false],
    [{ en: 'iHub Apps' }, false],
    ['$t(product.tagline)', false]
  ])('%j → %s', (value, expected) => {
    expect(followsProductName(value)).toBe(expected);
  });
});

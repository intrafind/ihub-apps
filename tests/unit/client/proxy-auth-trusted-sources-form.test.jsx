/**
 * The proxy auth settings show where the identity headers may come from:
 * trusted proxy addresses (loopback unless set otherwise, as on the server), a
 * shared secret and its header. While neither a trusted proxy nor a shared
 * secret is set, they warn that the headers are ignored.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: () => 'error',
  listCredentials: jest.fn(async () => [
    { id: 'cred_proxy', name: 'Proxy secret', type: 'secret' },
    { id: 'cred_oauth', name: 'OAuth client', type: 'oauth2' }
  ]),
  parseOpenApiSpec: jest.fn()
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path
}));

const PlatformFormEditor =
  require('../../../client/src/features/admin/components/PlatformFormEditor').default;

async function renderEditor(proxyAuth) {
  const onChange = jest.fn();
  render(
    <MemoryRouter>
      <PlatformFormEditor
        value={{ auth: { mode: 'proxy' }, proxyAuth: { enabled: true, ...proxyAuth } }}
        onChange={onChange}
      />
    </MemoryRouter>
  );
  // Let the shared secret picker finish loading the credential list.
  await screen.findByRole('option', { name: /cred_proxy/ });
  return onChange;
}

const IGNORED_WARNING = /headers are ignored until you list trusted proxies/;

test('shows loopback as the trusted proxy when none is set, without a warning', async () => {
  await renderEditor({});
  expect(screen.getByLabelText('Trusted Proxies')).toHaveValue('loopback');
  expect(screen.queryByText(IGNORED_WARNING)).not.toBeInTheDocument();
});

test('warns while neither a trusted proxy nor a shared secret is set', async () => {
  await renderEditor({ trustedProxies: [] });
  expect(screen.getByText(IGNORED_WARNING)).toBeInTheDocument();
});

test('does not warn with a shared secret and no trusted proxy', async () => {
  await renderEditor({ trustedProxies: [], sharedSecretRef: 'cred_proxy' });
  expect(screen.queryByText(IGNORED_WARNING)).not.toBeInTheDocument();
});

test('stores the trusted proxies as a list', async () => {
  const onChange = await renderEditor({ trustedProxies: [] });
  fireEvent.change(screen.getByLabelText('Trusted Proxies'), {
    target: { value: 'loopback, 10.0.0.0/8,' }
  });
  expect(onChange.mock.calls.at(-1)[0].proxyAuth.trustedProxies).toEqual([
    'loopback',
    '10.0.0.0/8'
  ]);
  expect(screen.getByLabelText('Trusted Proxies')).toHaveValue('loopback, 10.0.0.0/8,');
});

test('stores the shared secret header name', async () => {
  const onChange = await renderEditor({ trustedProxies: ['loopback'] });
  fireEvent.change(screen.getByLabelText('Shared Secret Header'), {
    target: { value: 'X-Gate' }
  });
  expect(onChange.mock.calls.at(-1)[0].proxyAuth.sharedSecretHeader).toBe('X-Gate');
});

test('offers secret credentials only, and stores the chosen one', async () => {
  const onChange = await renderEditor({});
  expect(screen.queryByRole('option', { name: /cred_oauth/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('option', { name: /cred_proxy/ }).closest('select'), {
    target: { value: 'cred_proxy' }
  });
  expect(onChange.mock.calls.at(-1)[0].proxyAuth.sharedSecretRef).toBe('cred_proxy');
});

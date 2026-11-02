// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which storage providers the chat's cloud file picker offers: those the app
 * binds (`app.integrations`: an installation id, a provider's definition id or
 * `type:storage`) among those the user's groups grant (the server lists only
 * granted ones in `/api/auth/status` → `cloudStorage.providers`). The binding
 * replaced the app switch `upload.cloudStorageUpload`.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  STORAGE_TYPE_BINDING,
  appBindsStorage,
  appBindsStorageProvider,
  storageProvidersBoundBy
} from '../../../shared/storageBindings.js';
import { storageBindingRows } from '../../../client/src/features/admin/components/app-form/storageBindingRows';

/** What `/api/auth/status` lists for this user: the granted installations. */
const GRANTED = [
  {
    id: 'o365-corp',
    type: 'office365',
    definition: 'com.intrafind/office365',
    displayName: 'Company SharePoint',
    enabled: true
  },
  {
    id: 'nextcloud',
    type: 'nextcloud',
    definition: 'com.intrafind/nextcloud',
    displayName: 'Head office',
    enabled: true
  },
  {
    id: 'nextcloud-branch',
    type: 'nextcloud',
    definition: 'com.intrafind/nextcloud',
    displayName: 'Branch office',
    enabled: true
  },
  {
    id: 'googledrive',
    type: 'googledrive',
    definition: 'com.intrafind/google-drive',
    displayName: 'Google Drive',
    enabled: false
  }
];

let mockPlatformConfig = { cloudStorage: { enabled: true, providers: GRANTED } };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key)
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// The provider browsers fetch; here they only say which provider they show.
jest.mock('../../../client/src/features/upload/components/NextcloudFileBrowser', () => ({
  __esModule: true,
  default: ({ provider }) => <div data-testid="browser">{`nextcloud:${provider.id}`}</div>
}));
jest.mock('../../../client/src/features/upload/components/Office365FileBrowser', () => ({
  __esModule: true,
  default: ({ provider }) => <div data-testid="browser">{`office365:${provider.id}`}</div>
}));
jest.mock('../../../client/src/features/upload/components/GoogleDriveFileBrowser', () => ({
  __esModule: true,
  default: ({ provider }) => <div data-testid="browser">{`googledrive:${provider.id}`}</div>
}));

const { useFileUploadHandler } = require('../../../client/src/shared/hooks/useFileUploadHandler');
const CloudStoragePicker =
  require('../../../client/src/features/upload/components/CloudStoragePicker').default;

const ids = providers => providers.map(p => p.id);

beforeEach(() => {
  mockPlatformConfig = { cloudStorage: { enabled: true, providers: GRANTED } };
});

describe('shared/storageBindings', () => {
  it('binds a provider by its installation id, its definition or type:storage', () => {
    const nextcloud = GRANTED[1];
    expect(appBindsStorageProvider({ integrations: { nextcloud: {} } }, nextcloud)).toBe(true);
    expect(
      appBindsStorageProvider({ integrations: { 'com.intrafind/nextcloud': {} } }, nextcloud)
    ).toBe(true);
    expect(
      appBindsStorageProvider({ integrations: { [STORAGE_TYPE_BINDING]: {} } }, nextcloud)
    ).toBe(true);
    expect(appBindsStorageProvider({ integrations: { 'o365-corp': {} } }, nextcloud)).toBe(false);
    expect(appBindsStorageProvider({}, nextcloud)).toBe(false);
    expect(appBindsStorageProvider({ integrations: { nextcloud: {} } }, null)).toBe(false);
  });

  it('narrows the granted providers to the bound, enabled ones in their order', () => {
    expect(
      ids(storageProvidersBoundBy({ integrations: { 'com.intrafind/nextcloud': {} } }, GRANTED))
    ).toEqual(['nextcloud', 'nextcloud-branch']);
    expect(ids(storageProvidersBoundBy({ integrations: { 'type:storage': {} } }, GRANTED))).toEqual(
      ['o365-corp', 'nextcloud', 'nextcloud-branch']
    );
    expect(
      ids(
        storageProvidersBoundBy({ integrations: { 'type:storage': {} } }, GRANTED, {
          includeDisabled: true
        })
      )
    ).toContain('googledrive');
    expect(storageProvidersBoundBy({ integrations: { 'type:storage': {} } }, undefined)).toEqual(
      []
    );
  });

  it('tells whether an app binds storage at all', () => {
    expect(appBindsStorage({ integrations: { 'type:storage': {} } })).toBe(true);
    expect(
      appBindsStorage(
        { integrations: { 'com.intrafind/nextcloud': {} } },
        { definitionIds: ['com.intrafind/nextcloud'] }
      )
    ).toBe(true);
    expect(appBindsStorage({ integrations: { x: {} } }, { installationIds: ['x'] })).toBe(true);
    expect(appBindsStorage({ integrations: { ifinder: {} } })).toBe(false);
  });
});

describe('the chat offers the providers the app binds and the user may use', () => {
  const create = app => {
    const { result } = renderHook(() => useFileUploadHandler());
    return result.current.createUploadConfig(app, null);
  };

  it('offers nothing without a binding, even with providers granted', () => {
    const config = create({ upload: { enabled: true } });
    expect(config.enabled).toBe(false);
  });

  it('offers the bound installations only', () => {
    const config = create({ integrations: { 'nextcloud-branch': { required: false } } });
    expect(config.enabled).toBe(true);
    expect(config.localUploadEnabled).toBe(false);
    expect(ids(config.cloudStorage.providers)).toEqual(['nextcloud-branch']);
  });

  it('offers no provider the groups do not grant, whatever the app binds', () => {
    mockPlatformConfig = { cloudStorage: { enabled: true, providers: [GRANTED[0]] } };
    const config = create({
      upload: { fileUpload: { enabled: true } },
      integrations: { 'com.intrafind/nextcloud': {}, 'o365-corp': {} }
    });
    expect(ids(config.cloudStorage.providers)).toEqual(['o365-corp']);
    mockPlatformConfig = { cloudStorage: { enabled: false, providers: [] } };
    expect(create({ integrations: { 'type:storage': {} } }).enabled).toBe(false);
  });

  it('offers nothing while the app switches uploads off', () => {
    const config = create({ upload: { enabled: false }, integrations: { 'type:storage': {} } });
    expect(config.enabled).toBe(false);
  });

  it('lists two Nextcloud servers side by side in the picker, each with its own browser', () => {
    const providers = create({ integrations: { 'com.intrafind/nextcloud': {} } }).cloudStorage
      .providers;
    render(
      <CloudStoragePicker providers={providers} onFileSelect={jest.fn()} onClose={jest.fn()} />
    );
    expect(screen.getByText('Head office')).toBeInTheDocument();
    expect(screen.getByText('Branch office')).toBeInTheDocument();
    expect(screen.queryByText('Company SharePoint')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Branch office'));
    expect(screen.getByTestId('browser')).toHaveTextContent('nextcloud:nextcloud-branch');
  });

  it('says so when the app offers no provider', () => {
    render(<CloudStoragePicker providers={[]} onFileSelect={jest.fn()} onClose={jest.fn()} />);
    expect(screen.getByText('No cloud storage providers are configured')).toBeInTheDocument();
  });
});

describe('storageBindingRows', () => {
  const nc = (id, extra = {}) => ({
    id,
    definition: 'com.intrafind/nextcloud',
    definitionName: 'Nextcloud',
    type: 'storage',
    ...extra
  });

  it('has no rows while nothing is installed or bound', () => {
    expect(storageBindingRows([{ id: 'x', type: 'web-search' }], {})).toEqual([]);
  });

  it('lists all, all of a provider with several installations, then each', () => {
    const rows = storageBindingRows([nc('a'), nc('b', { enabled: false })], {});
    expect(rows.map(row => [row.id, row.kind])).toEqual([
      ['type:storage', 'type'],
      ['com.intrafind/nextcloud', 'definition'],
      ['a', 'instance'],
      ['b', 'instance']
    ]);
    expect(rows[0]).toMatchObject({ count: 2, enabled: true });
    expect(rows[1]).toMatchObject({ name: 'Nextcloud', count: 2 });
  });

  it('keeps a bound shipped definition with no installation, and type:storage alone', () => {
    expect(
      storageBindingRows([], { 'com.intrafind/office365': {} }).map(row => [row.id, row.count])
    ).toEqual([
      ['type:storage', 0],
      ['com.intrafind/office365', 0]
    ]);
    expect(storageBindingRows([], { 'type:storage': {} }).map(row => row.id)).toEqual([
      'type:storage'
    ]);
  });
});

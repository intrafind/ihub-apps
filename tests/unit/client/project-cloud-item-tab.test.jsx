// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cloud tab of the project "Add item" dialog (#1036) hands the shared
 * cloud file browser an `uploadConfig` built from the project limits. The
 * browser reads `uploadConfig.maxFileSizeMB` for every file row, so opening a
 * folder with a file in it used to throw when none was passed.
 *
 * The real `CloudFileBrowserShell` renders here; only its provider hook (the
 * network) and the file-type table (which pulls in the PDF extractors) are
 * stubbed.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/upload/utils/cloudFileProcessing', () => ({
  __esModule: true,
  isCloudFileSupported: () => true,
  formatFileSize: bytes => `${bytes} B`
}));

const mockNoop = () => {};
const mockBrowserState = {
  authStatus: 'connected',
  sources: [{ id: 'onedrive', name: 'OneDrive' }],
  currentSource: 'onedrive',
  drives: [{ id: 'drv_1', name: 'My files' }],
  currentDrive: { id: 'drv_1', name: 'My files' },
  breadcrumbs: [],
  items: [
    { id: 'f_small', name: 'Lease.pdf', mimeType: 'application/pdf', size: 1024 },
    { id: 'f_big', name: 'Scan.pdf', mimeType: 'application/pdf', size: 30 * 1024 * 1024 }
  ],
  selectedFiles: new Map(),
  loading: false,
  downloading: false,
  error: null,
  searchQuery: '',
  sortBy: 'name',
  sortDirection: 'asc',
  autoSkippedDrives: true,
  checkAuthStatus: () => Promise.resolve(false),
  loadSources: mockNoop,
  selectSource: mockNoop,
  goBackToSources: mockNoop,
  selectDrive: mockNoop,
  navigateToFolder: mockNoop,
  navigateToBreadcrumb: mockNoop,
  toggleFileSelection: mockNoop,
  deselectAllFiles: mockNoop,
  downloadAndProcessFiles: mockNoop,
  searchItems: mockNoop,
  setSortBy: mockNoop,
  setSortDirection: mockNoop
};
jest.mock('../../../client/src/features/upload/hooks/useOffice365Browser', () => ({
  __esModule: true,
  useOffice365Browser: () => mockBrowserState
}));
jest.mock('../../../client/src/features/upload/hooks/useGoogleDriveBrowser', () => ({
  __esModule: true,
  useGoogleDriveBrowser: () => mockBrowserState
}));
jest.mock('../../../client/src/features/upload/hooks/useNextcloudBrowser', () => ({
  __esModule: true,
  useNextcloudBrowser: () => mockBrowserState
}));

const CloudItemTab =
  require('../../../client/src/features/projects/components/item-dialog/CloudItemTab').default;
const {
  cloudBrowserUploadConfig
} = require('../../../client/src/features/projects/utils/projectItems');

const api = {
  fetchCloudProviders: jest.fn(),
  addItem: jest.fn(),
  errorMessage: err => err.message
};

beforeEach(() => {
  api.fetchCloudProviders.mockReset();
  api.fetchCloudProviders.mockResolvedValue([
    { id: 'o365', type: 'office365', displayName: 'Microsoft 365' }
  ]);
});

function renderTab(config) {
  return render(
    <CloudItemTab
      kind="office365"
      kindEntry={{ id: 'office365' }}
      projectId="prj_a"
      api={api}
      config={config}
      onAdded={jest.fn()}
      onClose={jest.fn()}
    />
  );
}

describe('cloudBrowserUploadConfig', () => {
  test('turns the per-file limit into the browser’s megabytes', () => {
    expect(cloudBrowserUploadConfig({ limits: { maxFileBytes: 20971520 } })).toEqual({
      maxFileSizeMB: 20
    });
  });

  test('leaves the browser default in place when no limit is set', () => {
    expect(cloudBrowserUploadConfig(null)).toEqual({});
    expect(cloudBrowserUploadConfig({ limits: {} })).toEqual({});
    expect(cloudBrowserUploadConfig({ limits: { maxFileBytes: 0 } })).toEqual({});
  });
});

describe('CloudItemTab', () => {
  test('lists the files of a folder and greys out the ones above the project limit', async () => {
    renderTab({ limits: { maxFileBytes: 20971520 } });

    expect(await screen.findByText('Lease.pdf')).toBeInTheDocument();
    // The last two checkboxes are the file rows (the others: "Pinned" and
    // the browser's "show unsupported files").
    const [small, big] = screen.getAllByRole('checkbox').slice(-2);
    expect(small).toBeEnabled();
    expect(big).toBeDisabled();
    expect(screen.getByTitle('File exceeds size limit (20MB)')).toBeInTheDocument();
  });

  test('still renders the files when the dialog has no project config', async () => {
    renderTab(undefined);

    expect(await screen.findByText('Scan.pdf')).toBeInTheDocument();
    expect(screen.getByTitle('File exceeds size limit (10MB)')).toBeInTheDocument();
  });
});

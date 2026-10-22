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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    { id: 'f_big', name: 'Scan.pdf', mimeType: 'application/pdf', size: 30 * 1024 * 1024 },
    { id: 'f_memo', name: 'Memo.pdf', mimeType: 'application/pdf', size: 2048 }
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
// The selection is real state, so the tab's partial-failure handling can be
// seen in what stays selected.
function mockUseBrowser() {
  const React = require('react');
  const [selectedFiles, setSelectedFiles] = React.useState(() => new Map());
  const toggleFileSelection = React.useCallback(item => {
    setSelectedFiles(prev => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }, []);
  const deselectFiles = React.useCallback(ids => {
    setSelectedFiles(prev => new Map([...prev].filter(([id]) => !ids.includes(id))));
  }, []);
  return { ...mockBrowserState, selectedFiles, toggleFileSelection, deselectFiles };
}
jest.mock('../../../client/src/features/upload/hooks/useOffice365Browser', () => ({
  __esModule: true,
  useOffice365Browser: () => mockUseBrowser()
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
  api.addItem.mockReset();
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
    // The last three checkboxes are the file rows, sorted by name (the
    // others: "Pinned" and the browser's "show unsupported files").
    const [small, , big] = screen.getAllByRole('checkbox').slice(-3);
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

describe('CloudItemTab – adding the picked files', () => {
  const checkboxOf = name =>
    screen
      .getByText(name)
      .closest('.flex.items-center.p-2')
      .querySelector('input[type="checkbox"]');
  const addButton = () => screen.getByRole('button', { name: 'Add to project' });

  test('after a partial failure only the failed file stays selected for the retry', async () => {
    renderTab(undefined);
    await screen.findByText('Lease.pdf');
    fireEvent.click(checkboxOf('Lease.pdf'));
    fireEvent.click(checkboxOf('Memo.pdf'));
    expect(screen.getByText(/2 file\(s\) selected/)).toBeInTheDocument();

    api.addItem
      .mockResolvedValueOnce({ id: 'itm_1' })
      .mockRejectedValueOnce(new Error('quota exceeded'));
    await act(async () => {
      fireEvent.click(addButton());
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Memo.pdf: quota exceeded');
    expect(screen.getByText(/1 file\(s\) selected/)).toBeInTheDocument();
    expect(checkboxOf('Lease.pdf')).not.toBeChecked();
    expect(checkboxOf('Memo.pdf')).toBeChecked();

    // The retry submits the failed file alone — no duplicate of the other.
    api.addItem.mockResolvedValueOnce({ id: 'itm_2' });
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(api.addItem).toHaveBeenCalledTimes(3);
    expect(api.addItem.mock.calls[2][1].ref.fileId).toBe('f_memo');
  });

  test('disables the confirm button and the inputs while the batch runs', async () => {
    renderTab(undefined);
    await screen.findByText('Lease.pdf');
    fireEvent.click(checkboxOf('Lease.pdf'));

    let settle;
    api.addItem.mockReturnValueOnce(
      new Promise(resolve => {
        settle = resolve;
      })
    );
    // Keyboard activation is a click on the focused button.
    act(() => {
      addButton().focus();
      fireEvent.click(addButton());
    });

    expect(addButton()).toBeDisabled();
    expect(checkboxOf('Lease.pdf')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Pinned (always in the prompt)' })).toBeDisabled();
    fireEvent.click(addButton());
    expect(api.addItem).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle({ id: 'itm_1' });
    });
    await waitFor(() => expect(api.addItem).toHaveBeenCalledTimes(1));
  });
});

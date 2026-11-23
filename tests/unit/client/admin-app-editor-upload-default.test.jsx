// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin app editor: the document upload limit it opens an app with.
 *
 * A loaded app without an upload block gets a document limit of 20 MB (the
 * schema default; it was 5 MB). A limit the app has set is never replaced, the
 * old default of 5 MB included. The padding is `padLoadedApp`
 * (`shared/appDefaults.js`); the page keeps no default object of its own, and
 * a save takes the switched-off block out again.
 *
 * The page, the admin API module and the shared defaults are the real ones.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key);
  const i18n = { language: 'en' };
  return { useTranslation: () => ({ t: translate, i18n }) };
});

const mockRequest = jest.fn();
jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: (...args) => mockRequest(...args)
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => p,
  buildApiUrl: p => `/api${p}`
}));
jest.mock('../../../client/src/api/endpoints/projects.js', () => ({
  CRAWL_REQUEST_TIMEOUT_MS: 1000
}));
jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn(() => Promise.resolve([])),
  fetchUIConfig: jest.fn(() => Promise.resolve({})),
  fetchAppDetails: jest.fn(() => Promise.resolve({}))
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(() => Promise.resolve(null))
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/pages/AppChat', () => () => null);
jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => () => null);
// The real editor is a large form; what the page hands it is what is under test.
jest.mock(
  '../../../client/src/shared/components/DualModeEditor',
  () => require('./helpers/appEditorHarness').MockDualModeEditor
);
// The form's two group components belong to the form; the page only places them.
jest.mock(
  '../../../client/src/features/admin/components/app-form/EditorGroup',
  () => require('./helpers/appEditorHarness').MockEditorGroup,
  { virtual: true }
);
jest.mock(
  '../../../client/src/features/admin/components/app-form/EditorGroupNav',
  () => require('./helpers/appEditorHarness').MockEditorGroupNav,
  { virtual: true }
);

const { createAppServer } = require('./helpers/appEditorHarness');
const AdminAppEditPage =
  require('../../../client/src/features/admin/pages/AdminAppEditPage').default;

const BASE_APP = {
  id: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  enabled: true
};

let server;

/** Opens the editor for a stored app and returns the app as the form gets it. */
async function openEditor(app) {
  server = createAppServer({ app });
  mockRequest.mockImplementation(server.request);
  render(
    <MemoryRouter initialEntries={['/admin/apps/chat']}>
      <Routes>
        <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
      </Routes>
    </MemoryRouter>
  );
  return JSON.parse((await screen.findByTestId('form-value')).textContent);
}

beforeEach(() => {
  mockRequest.mockReset();
});

describe('AdminAppEditPage document upload limit', () => {
  test('an app without an upload block is opened with 20 MB, switched off', async () => {
    const { upload } = await openEditor(BASE_APP);

    expect(upload.enabled).toBe(false);
    expect(upload.fileUpload.maxFileSizeMB).toBe(20);
    expect(upload.fileUpload.enabled).toBe(false);
    // The other types keep theirs
    expect(upload.imageUpload.maxFileSizeMB).toBe(10);
  });

  test.each([5, 50])('a limit the app set stays: %i MB', async limit => {
    const { upload } = await openEditor({
      ...BASE_APP,
      upload: { enabled: true, fileUpload: { enabled: true, maxFileSizeMB: limit } }
    });

    expect(upload.fileUpload.maxFileSizeMB).toBe(limit);
  });

  test('opening an app is not an edit, and a save does not store the padding', async () => {
    await openEditor(BASE_APP);
    expect(screen.queryByRole('region', { name: 'Save changes' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    const [put] = server.writes();
    expect(put.method).toBe('PUT');
    expect(put.data).not.toHaveProperty('upload');
    expect(put.data).toMatchObject({ id: 'chat', name: { en: 'Chat 2' } });
  });

  test('a limit the app set is stored again as it was', async () => {
    await openEditor({
      ...BASE_APP,
      upload: { enabled: true, fileUpload: { enabled: true, maxFileSizeMB: 5 } }
    });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0].data.upload.fileUpload.maxFileSizeMB).toBe(5);
  });
});

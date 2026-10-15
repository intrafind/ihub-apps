import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Admin app editor — the document upload limit it starts an app with.
 *
 * A new app and a loaded app without an upload block get a document limit of
 * 20 MB (the schema default; it was 5 MB). A limit the app has set is never
 * replaced, the old default of 5 MB included.
 */

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key);
  const i18n = { language: 'en' };
  return { useTranslation: () => ({ t: translate, i18n }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.message || 'failed'
}));

jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn(() => Promise.resolve([])),
  fetchUIConfig: jest.fn(() => Promise.resolve({})),
  fetchAppDetails: jest.fn(() => Promise.resolve({}))
}));

jest.mock('../../../client/src/features/apps/pages/AppChat', () => () => null);

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => p
}));

jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(() => Promise.resolve(null))
}));

// The real editor is a large form; what the page hands it is what is under test.
jest.mock('../../../client/src/shared/components/DualModeEditor', () => {
  return function DualModeEditor({ value }) {
    return <output data-testid="upload">{JSON.stringify(value?.upload ?? null)}</output>;
  };
});

jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => () => null);

import AdminAppEditPage from '../../../client/src/features/admin/pages/AdminAppEditPage';

const BASE_APP = {
  id: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  enabled: true
};

async function renderEditor(path, app) {
  mockMakeAdminApiCall.mockImplementation(() => Promise.resolve({ data: app }));
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
      </Routes>
    </MemoryRouter>
  );
  return JSON.parse((await screen.findByTestId('upload')).textContent);
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
});

describe('AdminAppEditPage document upload limit', () => {
  test('a new app starts with 20 MB', async () => {
    const upload = await renderEditor('/admin/apps/new', BASE_APP);

    expect(upload.fileUpload.maxFileSizeMB).toBe(20);
    expect(upload.fileUpload.enabled).toBe(false);
    // The other types keep theirs
    expect(upload.imageUpload.maxFileSizeMB).toBe(10);
  });

  test('an app without an upload block is opened with 20 MB', async () => {
    const upload = await renderEditor('/admin/apps/chat', BASE_APP);

    expect(upload.fileUpload.maxFileSizeMB).toBe(20);
    expect(upload.imageUpload.maxFileSizeMB).toBe(10);
  });

  test.each([5, 50])('a limit the app set stays: %i MB', async limit => {
    const upload = await renderEditor('/admin/apps/chat', {
      ...BASE_APP,
      upload: { enabled: true, fileUpload: { enabled: true, maxFileSizeMB: limit } }
    });

    expect(upload.fileUpload.maxFileSizeMB).toBe(limit);
  });
});

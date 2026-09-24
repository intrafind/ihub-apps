import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Admin app editor — issue #2510.
 *
 * - Save persists and stays in the editor; Save & Exit goes back to the list.
 * - Saving a new app with Save moves the editor to /admin/apps/:id.
 * - Ctrl/Cmd+S saves.
 * - Open app links to the chat page in a new tab (not for disabled apps).
 * - The test panel runs the saved app in an iframe and reloads after a save.
 */

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) {
        str = str.replace(new RegExp(`{{${k}}}`, 'g'), v);
      }
    }
    return str;
  };
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
  fetchUIConfig: jest.fn(() => Promise.resolve({}))
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
// Stand in for a subpath deployment, so the links must carry the base path.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => `/ihub${p}`
}));

jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(() => Promise.resolve(null))
}));

// The real editor is a large form; a single name field is enough to make
// the page dirty and to drive a save.
jest.mock('../../../client/src/shared/components/DualModeEditor', () => {
  return function DualModeEditor({ value, onChange }) {
    return (
      <div>
        <input
          aria-label="App ID"
          value={value?.id ?? ''}
          onChange={e => onChange({ ...value, id: e.target.value })}
        />
        <input
          aria-label="Name"
          value={value?.name?.en ?? ''}
          onChange={e => onChange({ ...value, name: { ...value.name, en: e.target.value } })}
        />
      </div>
    );
  };
});

jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => () => null);

import AdminAppEditPage from '../../../client/src/features/admin/pages/AdminAppEditPage';

const SAVED_APP = {
  id: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  enabled: true
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderEditor(path = '/admin/apps/chat') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
        <Route path="/admin/apps" element={<div>Apps list</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

function mockApi(app = SAVED_APP) {
  mockMakeAdminApiCall.mockImplementation((url, options = {}) => {
    if (!options.method) return Promise.resolve({ data: app });
    return Promise.resolve({ data: { message: 'ok' } });
  });
}

const writes = () => mockMakeAdminApiCall.mock.calls.filter(([, options]) => options?.method);

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
});

describe('AdminAppEditPage save actions', () => {
  test('Save persists, stays in the editor and clears the dirty state', async () => {
    mockApi();
    renderEditor();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Chat 2' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText('App saved')).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    const [url, options] = writes()[0];
    expect(url).toBe('/admin/apps/chat');
    expect(options.method).toBe('PUT');
    expect(options.body.name.en).toBe('Chat 2');
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/apps/chat');

    // Leaving right after the save is not blocked by the unsaved-changes guard.
    fireEvent.click(screen.getByRole('button', { name: 'Back to Apps' }));
    expect(await screen.findByText('Apps list')).toBeInTheDocument();
    expect(screen.queryByText('You have unsaved changes. Leave anyway?')).not.toBeInTheDocument();
  });

  test('Save & Exit persists and returns to the apps list', async () => {
    mockApi();
    renderEditor();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Chat 2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save & Exit' }));

    expect(await screen.findByText('Apps list')).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1].method).toBe('PUT');
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/apps$/);
  });

  test('saving a new app with Save moves the editor to /admin/apps/:id', async () => {
    mockApi({ ...SAVED_APP, id: 'my-app', name: { en: 'Mine' } });
    renderEditor('/admin/apps/new');
    fireEvent.change(await screen.findByLabelText('App ID'), { target: { value: 'my-app' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    expect(screen.queryByRole('button', { name: /Test/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/admin/apps/my-app')
    );
    expect(writes()[0]).toEqual([
      '/admin/apps',
      expect.objectContaining({ method: 'POST', body: expect.objectContaining({ id: 'my-app' }) })
    ]);
    // Now an existing app: it is loaded from the server and can be tested.
    expect(await screen.findByRole('button', { name: /Test/ })).toBeInTheDocument();
    expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/apps/my-app');
  });

  test('Ctrl+S and Cmd+S save without leaving the editor', async () => {
    mockApi();
    renderEditor();
    await screen.findByLabelText('Name');

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(await screen.findByText('App saved')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/apps/chat');
  });
});

describe('AdminAppEditPage open and test', () => {
  test('Open app links to the chat page, under the base path, in a new tab', async () => {
    mockApi();
    renderEditor();

    const link = await screen.findByRole('link', { name: /Open app/ });
    expect(link).toHaveAttribute('href', '/ihub/apps/chat');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('a disabled app cannot be opened or tested', async () => {
    mockApi({ ...SAVED_APP, enabled: false });
    renderEditor();

    const open = await screen.findByRole('button', { name: /Open app/ });
    expect(open).toBeDisabled();
    expect(open).toHaveAttribute('title', 'Enable the app and save to open it');

    fireEvent.click(screen.getByRole('button', { name: /Test/ }));
    expect(screen.getByText(/This app is disabled/)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  test('the test panel runs the saved app and reloads after a save', async () => {
    mockApi();
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: /Test/ }));
    const frame = document.querySelector('iframe');
    expect(frame).toHaveAttribute('src', '/ihub/apps/chat?ihubPreview=1');

    // Unsaved edits are not in the preview yet, and the panel says so.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 2' } });
    expect(screen.getByText(/You have unsaved changes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await screen.findByText('App saved');

    // A fresh iframe element means a fresh load of the saved app.
    const reloaded = document.querySelector('iframe');
    expect(reloaded).not.toBe(frame);
    expect(screen.queryByText(/You have unsaved changes/)).not.toBeInTheDocument();

    // Opening and closing the panel never trips the unsaved-changes guard.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close test panel' }));
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.queryByText('You have unsaved changes. Leave anyway?')).not.toBeInTheDocument();

    // Leaving the page still does.
    fireEvent.click(screen.getByRole('button', { name: 'Back to Apps' }));
    expect(await screen.findByText('You have unsaved changes. Leave anyway?')).toBeInTheDocument();
  });
});

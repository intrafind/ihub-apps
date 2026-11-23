// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Model lifecycle in Admin → Models (review recommendation 9):
 *
 * - the delete dialog lists what names the model and where the copy is kept (AI-B12);
 * - a default model the server picked on its own is announced (AI-B13);
 * - the list has an enable switch per row and a "Make default" action.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  makeAdminApiCall: jest.fn(),
  toggleModels: jest.fn(),
  makeDefaultModel: jest.fn(),
  fetchModelDependants: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args),
  toggleModels: (...args) => mockApi.toggleModels(...args),
  makeDefaultModel: (...args) => mockApi.makeDefaultModel(...args),
  fetchModelDependants: (...args) => mockApi.fetchModelDependants(...args),
  assignedDefaultModelId: response => response?.headers?.['default-model-assigned'] ?? null,
  getAdminApiErrorMessage: err => err?.message ?? 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/ModelDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ModelImportDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useApiKeyStatus', () => ({
  __esModule: true,
  default: () => ({ statuses: {}, reload: () => {} })
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: (_name, fallback) => fallback })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { admin: { pages: {} } } })
}));

/** `t` as the product uses it: a fallback text or `{ defaultValue }`, with `{{name}}` filled in. */
const mockT = (key, fallbackOrOptions, maybeOptions) => {
  const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions || {};
  const text = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : options.defaultValue;
  if (typeof text !== 'string') return key;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const AdminModelsPage = require('../../../client/src/features/admin/pages/AdminModelsPage').default;

const model = (id, extra = {}) => ({
  id,
  name: { en: id.toUpperCase() },
  description: { en: '' },
  provider: 'openai',
  enabled: true,
  ...extra
});

function renderPage(models, { state } = {}) {
  mockApi.makeAdminApiCall.mockImplementation(async (path, options = {}) => {
    if (path === '/admin/models') return { data: { items: models } };
    if (path === '/admin/providers') return { data: { items: [] } };
    if (options.method === 'DELETE') return { data: undefined, headers: {} };
    return { data: {} };
  });
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/admin/models', state }]}>
      <Routes>
        <Route path="/admin/models" element={<AdminModelsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const rowOf = async name => (await screen.findByText(name)).closest('tr');

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
});

describe('the delete dialog says what names the model', () => {
  test('lists apps, workflows, groups, the next default and the history copy', async () => {
    mockApi.fetchModelDependants.mockResolvedValue({
      apps: [{ id: 'chat', name: { en: 'Chat' }, references: ['preferredModel'] }],
      workflows: [{ id: 'flow', name: { en: 'Flow' }, references: ['node'] }],
      groups: [{ id: 'pilot', name: 'Pilot' }],
      isDefault: true,
      nextDefaultModelId: 'large'
    });
    renderPage([model('small', { default: true }), model('large')]);

    const row = await rowOf('SMALL');
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(mockApi.fetchModelDependants).toHaveBeenCalledWith('small');
    expect(dialog).toHaveTextContent('Delete model "SMALL"?');
    expect(dialog).toHaveTextContent('open /admin/models/small again to restore it');
    expect(dialog).toHaveTextContent('Apps that name it (they answer with another model): Chat');
    expect(dialog).toHaveTextContent('Workflows that name it: Flow');
    expect(dialog).toHaveTextContent('Groups that grant it by name: Pilot');
    expect(dialog).toHaveTextContent('It is the default model. "LARGE" becomes the default.');
  });

  test('still opens when the check fails, and says it could not check', async () => {
    mockApi.fetchModelDependants.mockRejectedValue(new Error('offline'));
    renderPage([model('small')]);

    fireEvent.click(within(await rowOf('SMALL')).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Could not check what uses it'
    );
  });

  test('announces the default the server assigned after the delete', async () => {
    mockApi.fetchModelDependants.mockResolvedValue({
      apps: [],
      workflows: [],
      groups: [],
      isDefault: true,
      nextDefaultModelId: 'large'
    });
    renderPage([model('small', { default: true }), model('large')]);
    mockApi.makeAdminApiCall.mockImplementation(async (path, options = {}) =>
      options.method === 'DELETE'
        ? { data: undefined, headers: { 'default-model-assigned': 'large' } }
        : { data: { items: [] } }
    );

    fireEvent.click(within(await rowOf('SMALL')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });

    expect(await screen.findByTestId('editor-toast')).toHaveTextContent(
      '"LARGE" is now the default model.'
    );
  });
});

describe('enable switch and Make default', () => {
  test('the switch toggles the model and announces a default the server assigned', async () => {
    mockApi.toggleModels.mockResolvedValue({
      enabled: false,
      ids: ['small'],
      assignedDefaultModelId: 'large'
    });
    renderPage([model('small', { default: true }), model('large')]);

    const toggle = await screen.findByRole('switch', { name: 'Enabled: SMALL' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(mockApi.toggleModels).toHaveBeenCalledWith('small', false);
    expect(screen.getByRole('switch', { name: 'Enabled: SMALL' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByTestId('editor-toast')).toHaveTextContent(
      '"LARGE" is now the default model.'
    );
    // The badge moved with the default.
    expect(within(await rowOf('LARGE')).getByText('Default')).toBeInTheDocument();
  });

  test('a toggle that leaves the default where it was announces nothing', async () => {
    mockApi.toggleModels.mockResolvedValue({ enabled: false, ids: ['large'] });
    renderPage([model('small', { default: true }), model('large')]);

    const toggle = await screen.findByRole('switch', { name: 'Enabled: LARGE' });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(screen.getByTestId('editor-toast')).toBeEmptyDOMElement();
  });

  test('Make default moves the default to the row', async () => {
    mockApi.makeDefaultModel.mockResolvedValue({ id: 'large', default: true });
    renderPage([model('small', { default: true }), model('large')]);

    const row = await rowOf('LARGE');
    // The default model's own row offers no "Make default".
    expect(
      within(await rowOf('SMALL')).queryByRole('button', { name: 'Make default' })
    ).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Make default' }));
    });

    expect(mockApi.makeDefaultModel).toHaveBeenCalledWith('large');
    await waitFor(() => expect(within(row).getByText('Default')).toBeInTheDocument());
    expect(within(await rowOf('SMALL')).queryByText('Default')).not.toBeInTheDocument();
  });

  test('Make default is unavailable on a disabled model and absent on a TTS model', async () => {
    renderPage([
      model('small', { default: true }),
      model('off', { enabled: false }),
      model('voice', { modelType: 'tts' })
    ]);

    expect(within(await rowOf('OFF')).getByRole('button', { name: 'Make default' })).toBeDisabled();
    expect(
      within(await rowOf('VOICE')).queryByRole('button', { name: 'Make default' })
    ).not.toBeInTheDocument();
  });

  test('a default the editor handed over is announced once the list is loaded', async () => {
    renderPage([model('small', { default: true })], { state: { defaultAssigned: 'small' } });

    await waitFor(() =>
      expect(screen.getByTestId('editor-toast')).toHaveTextContent(
        '"SMALL" is now the default model.'
      )
    );
  });
});

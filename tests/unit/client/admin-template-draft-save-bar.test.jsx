// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A new model or prompt made from a template or a clone is complete as it opens, so the save
 * bar offers Create at once. Discard puts the template back and takes the bar away; the next
 * edit brings it back. Uses the real dirty tracking (the form-error tests mock it).
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  makeAdminApiCall: jest.fn(),
  fetchMarketplaceInstallations: jest.fn(),
  fetchAdminPrompts: jest.fn(),
  createPrompt: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || 'error',
  fetchMarketplaceInstallations: (...args) => mockApi.fetchMarketplaceInstallations(...args),
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args),
  fetchAdminPrompts: (...args) => mockApi.fetchAdminPrompts(...args),
  fetchAdminApps: async () => [],
  createPrompt: (...args) => mockApi.createPrompt(...args),
  updatePrompt: async () => ({}),
  translateText: async () => ({ translation: '' })
}));

// The UI language of a test: 'en' or 'de'.
let mockLanguage = 'en';
jest.mock('react-i18next', () => {
  const { enT, deT } = require('./helpers/i18nMock');
  const translations = {
    en: { t: enT, i18n: { language: 'en' } },
    de: { t: deT, i18n: { language: 'de' } }
  };
  return { useTranslation: () => translations[mockLanguage] };
});

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/shared/components/MonacoJsonEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api', () => ({
  clearApiCache: () => {},
  fetchUIConfig: async () => ({})
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));

const mockSchemas = {};
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(async type => mockSchemas[type])
}));

const AdminModelEditPage =
  require('../../../client/src/features/admin/pages/AdminModelEditPage').default;
const AdminPromptEditPage =
  require('../../../client/src/features/admin/pages/AdminPromptEditPage').default;
const en = require('../../../shared/i18n/en.json');

const {
  getModelJsonSchema,
  getPromptJsonSchema
} = require('../../../server/utils/schemaExport.js');
mockSchemas.model = getModelJsonSchema();
mockSchemas.prompt = getPromptJsonSchema();

const renderAt = location =>
  render(
    <MemoryRouter initialEntries={[location]}>
      <Routes>
        <Route path="/admin/models/:modelId" element={<AdminModelEditPage />} />
        <Route path="/admin/prompts/:promptId" element={<AdminPromptEditPage />} />
      </Routes>
    </MemoryRouter>
  );

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const barButtons = () => within(bar()).getAllByRole('button');

const TEMPLATE_MODEL = {
  id: 'gpt-4',
  modelId: 'gpt-4',
  name: { en: 'GPT-4' },
  description: { en: 'A model' },
  provider: 'openai',
  url: 'https://api.openai.com/v1/chat/completions',
  enabled: true
};
const TEMPLATE_PROMPT = {
  id: 'summarize',
  name: { en: 'Summarize' },
  description: { en: 'Short' },
  prompt: { en: 'Summarize this' }
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.makeAdminApiCall.mockResolvedValue({ data: {} });
  mockApi.fetchMarketplaceInstallations.mockResolvedValue({ items: [] });
  mockApi.fetchAdminPrompts.mockResolvedValue([]);
  mockApi.createPrompt.mockResolvedValue({});
});

describe('a new model or prompt made from a template or clone', () => {
  test('a model: the bar offers Create as the page opens; Discard takes the bar away', async () => {
    renderAt({
      pathname: '/admin/models/new',
      state: { templateModel: TEMPLATE_MODEL, cloneId: 'gpt-4-copy' }
    });
    await screen.findByLabelText(/^Model ID/);
    await settle();
    expect(bar()).toBeInTheDocument();
    expect(barButtons().at(-1)).toHaveTextContent(en.admin.ui.saveBar.create);

    fireEvent.click(barButtons()[0]);

    expect(bar()).not.toBeInTheDocument();
    // An edit after that brings the bar back, with the proposed ID kept.
    fireEvent.change(screen.getByLabelText(/^Model ID/), { target: { value: 'gpt-4-copy-x' } });
    expect(bar()).toBeInTheDocument();
  });

  test('a prompt: the bar offers Create as the page opens; Discard takes the bar away', async () => {
    renderAt({
      pathname: '/admin/prompts/new',
      state: { templatePrompt: TEMPLATE_PROMPT, cloneId: 'summarize-copy' }
    });
    await screen.findByLabelText(/^ID/);
    await settle();
    expect(bar()).toBeInTheDocument();
    expect(barButtons().at(-1)).toHaveTextContent(en.admin.ui.saveBar.create);

    fireEvent.click(barButtons()[0]);

    expect(bar()).not.toBeInTheDocument();
  });

  test('a new, empty model has no bar until something is typed', async () => {
    renderAt('/admin/models/new');
    await screen.findByLabelText(/^Model ID/);
    await settle();
    expect(bar()).not.toBeInTheDocument();
  });
});

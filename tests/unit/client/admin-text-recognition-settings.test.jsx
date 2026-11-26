// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin settings of text recognition at upload (#3986):
 *
 * - Admin → Chat history → Uploaded files → Text recognition: the model (the enabled models that
 *   read images, or Off), the most pages per document, and the chat opt-in, which waits for a
 *   model. They are saved with the page's other settings (`ocr`, `uploads.recognizeText`).
 * - The app editor's "Text recognition in chats": installation default (no key), on or off
 *   (`uploads.recognizeText`).
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockApi(...args)
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UnsavedChangesDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/MimeTypeSelector', () => () => null);

const en = require('../../../shared/i18n/en.json');
const { enT } = require('./helpers/i18nMock');
const AdminChatHistoryPage =
  require('../../../client/src/features/admin/pages/AdminChatHistoryPage').default;
const UploadConfigSection =
  require('../../../client/src/features/admin/components/app-form/UploadConfigSection').default;
const {
  recognizeTextChoiceOf,
  withRecognizeTextChoice
} = require('../../../client/src/features/admin/components/app-form/UploadConfigSection');

const SETTINGS = {
  chats: {
    enabled: true,
    maxChatsPerUser: 50,
    maxMessagesPerChat: 200,
    retentionDays: 90,
    temporaryRetentionHours: 24
  },
  titles: { enabled: false, modelId: '' },
  compaction: { modelId: '' },
  evidence: { enabled: true },
  runLog: {
    enabled: true,
    cleanupEnabled: true,
    flushIntervalMs: 1000,
    identityMode: 'default',
    retentionDays: 30,
    spillThresholdBytes: 1024
  },
  sharing: { enabled: true, embedAllowedOrigins: [] },
  uploads: {
    enabled: true,
    evictOldestOriginalsOnQuota: false,
    originalRetentionDays: 30,
    storageMode: 'original_and_text',
    recognizeText: false,
    quotas: {
      maxApiBytes: 1000,
      maxApiFiles: 10,
      maxChatBytes: 2000,
      maxChatFiles: 20,
      maxFileBytes: 3000,
      maxServerBytes: 4000,
      maxUserBytes: 5000
    }
  },
  ocr: { modelId: null, maxPages: 50, pages: 'smart', minFigurePercent: 20 }
};
const OCR_MODELS = [
  { id: 'vision-1', name: { en: 'Vision One', de: 'Vision Eins' } },
  { id: 'vision-2', name: 'Vision Two' }
];

const uploadsText = en.admin.chatHistory.uploads.ocr;
const OCR_ENGINES = [
  {
    id: 'ifinder-ocr',
    name: 'iFinder OCR service',
    definition: 'com.intrafind/ifinder-ocr',
    enabled: true
  },
  { id: 'old-ocr', name: 'Old OCR', definition: 'acme/ocr', enabled: false }
];
const engineSelect = () => screen.getByLabelText(uploadsText.engine);
const modelSelect = () => screen.getByLabelText(uploadsText.modelId);
const maxPages = () => screen.getByLabelText(uploadsText.maxPages);
const chatToggle = () => screen.getByLabelText(uploadsText.recognizeText);
const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
const puts = () =>
  mockApi.mock.calls.filter(
    ([url, options]) => url === '/admin/chat-history/settings' && options?.method === 'PUT'
  );

const renderPage = async overview => {
  mockApi.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/chat-history' && !options.method) return { data: overview };
    if (url === '/admin/chat-history/settings' && options.method === 'PUT') return { data: {} };
    return { data: { items: [] } };
  });
  render(
    <MemoryRouter>
      <AdminChatHistoryPage />
    </MemoryRouter>
  );
  await screen.findByLabelText(uploadsText.engine);
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  jest.clearAllMocks();
});

describe('Admin → Chat history → Text recognition', () => {
  test('offers Off and the models that read images; the chat opt-in waits for a model', async () => {
    await renderPage({ status: {}, stats: {}, settings: SETTINGS, ocrModels: OCR_MODELS });
    const options = within(modelSelect())
      .getAllByRole('option')
      .map(option => option.textContent);
    expect(options).toEqual([uploadsText.off, 'Vision One', 'Vision Two']);
    expect(modelSelect()).toHaveValue('');
    expect(chatToggle()).toBeDisabled();
    expect(screen.getByText(uploadsText.recognizeTextNoModel)).toBeInTheDocument();

    fireEvent.change(modelSelect(), { target: { value: 'vision-2' } });
    expect(chatToggle()).toBeEnabled();
  });

  test('saves the model, the page limit and the chat opt-in with the other settings', async () => {
    await renderPage({ status: {}, stats: {}, settings: SETTINGS, ocrModels: OCR_MODELS });
    fireEvent.change(modelSelect(), { target: { value: 'vision-1' } });
    fireEvent.change(maxPages(), { target: { value: '20' } });
    fireEvent.click(chatToggle());

    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() => expect(puts()).toHaveLength(1));
    const { body } = puts()[0][1];
    expect(body.ocr).toMatchObject({ modelId: 'vision-1', maxPages: 20 });
    expect(body.uploads.recognizeText).toBe(true);
  });

  test('Off saves no model', async () => {
    await renderPage({
      status: {},
      stats: {},
      settings: { ...SETTINGS, ocr: { modelId: 'vision-1', maxPages: 50 } },
      ocrModels: OCR_MODELS
    });
    fireEvent.change(modelSelect(), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1].body.ocr.modelId).toBeNull();
  });

  test('keeps showing a model that is no longer offered', async () => {
    await renderPage({
      status: {},
      stats: {},
      settings: { ...SETTINGS, ocr: { modelId: 'gone-model', maxPages: 50 } },
      ocrModels: OCR_MODELS
    });
    expect(modelSelect()).toHaveValue('gone-model');
    expect(screen.getByRole('option', { name: 'gone-model (not available)' })).toBeInTheDocument();
  });

  test('offers the installed OCR integrations as engines; one replaces the model', async () => {
    await renderPage({
      status: {},
      stats: {},
      settings: SETTINGS,
      ocrModels: OCR_MODELS,
      ocrEngines: OCR_ENGINES
    });
    const options = within(engineSelect())
      .getAllByRole('option')
      .map(option => option.textContent);
    expect(options).toEqual([
      uploadsText.engineModel,
      'iFinder OCR service',
      'Old OCR (switched off)'
    ]);
    expect(engineSelect()).toHaveValue('model');

    fireEvent.change(engineSelect(), { target: { value: 'ifinder-ocr' } });
    expect(screen.queryByLabelText(uploadsText.modelId)).not.toBeInTheDocument();
    expect(chatToggle()).toBeEnabled();

    fireEvent.change(engineSelect(), { target: { value: 'old-ocr' } });
    expect(chatToggle()).toBeDisabled();
    expect(screen.getByText(uploadsText.engineNotReady)).toBeInTheDocument();

    fireEvent.change(engineSelect(), { target: { value: 'ifinder-ocr' } });
    fireEvent.click(chatToggle());
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(puts()).toHaveLength(1));
    const { body } = puts()[0][1];
    expect(body.ocr.engine).toBe('ifinder-ocr');
    expect(body.uploads.recognizeText).toBe(true);
  });

  test('offers which pages of PDFs with text are read; the figure share only for smart', async () => {
    await renderPage({ status: {}, stats: {}, settings: SETTINGS, ocrModels: OCR_MODELS });
    const pages = screen.getByLabelText(uploadsText.pages);
    expect(pages).toHaveValue('smart');
    expect(screen.getByLabelText(uploadsText.minFigurePercent)).toHaveValue(20);

    fireEvent.change(screen.getByLabelText(uploadsText.minFigurePercent), {
      target: { value: '35' }
    });
    fireEvent.change(pages, { target: { value: 'all' } });
    expect(screen.queryByLabelText(uploadsText.minFigurePercent)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1].body.ocr).toMatchObject({ pages: 'all', minFigurePercent: 35 });
  });

  test('without an OCR integration, says how to get one', async () => {
    await renderPage({ status: {}, stats: {}, settings: SETTINGS, ocrModels: OCR_MODELS });
    expect(screen.getByText(uploadsText.engineNone, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: uploadsText.integrationsLink })).toHaveAttribute(
      'href',
      '/admin/integrations'
    );
  });

  test('keeps showing an engine that is no longer installed', async () => {
    await renderPage({
      status: {},
      stats: {},
      settings: { ...SETTINGS, ocr: { engine: 'gone-ocr', modelId: null, maxPages: 50 } },
      ocrModels: OCR_MODELS,
      ocrEngines: OCR_ENGINES
    });
    expect(engineSelect()).toHaveValue('gone-ocr');
    expect(screen.getByRole('option', { name: 'gone-ocr (not available)' })).toBeInTheDocument();
    expect(chatToggle()).toBeDisabled();
  });

  test('a server without text recognition shows no block and sends no `ocr`', async () => {
    const { ocr: _ocr, ...withoutOcr } = SETTINGS;
    mockApi.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/chat-history' && !options.method) {
        return { data: { status: {}, stats: {}, settings: withoutOcr } };
      }
      return { data: { items: [] } };
    });
    render(
      <MemoryRouter>
        <AdminChatHistoryPage />
      </MemoryRouter>
    );
    await screen.findByLabelText('Chats per user');
    expect(screen.queryByLabelText(uploadsText.modelId)).not.toBeInTheDocument();
  });
});

describe('App editor → Text recognition in chats', () => {
  const appWithUploads = uploads => ({
    id: 'app',
    upload: { enabled: true, fileUpload: { enabled: true } },
    ...(uploads ? { uploads } : {})
  });

  test('maps the override to a choice and back, dropping the key for the default', () => {
    expect(recognizeTextChoiceOf(appWithUploads())).toBe('default');
    expect(recognizeTextChoiceOf(appWithUploads({ recognizeText: true }))).toBe('on');
    expect(recognizeTextChoiceOf(appWithUploads({ recognizeText: false }))).toBe('off');

    expect(withRecognizeTextChoice(undefined, 'on')).toEqual({ recognizeText: true });
    expect(withRecognizeTextChoice({ storageMode: 'server_text_only' }, 'off')).toEqual({
      storageMode: 'server_text_only',
      recognizeText: false
    });
    expect(
      withRecognizeTextChoice({ storageMode: 'server_text_only', recognizeText: true }, 'default')
    ).toEqual({ storageMode: 'server_text_only' });
    expect(withRecognizeTextChoice({ recognizeText: true }, 'default')).toBeUndefined();
  });

  test('the select writes `uploads` through the form handler', () => {
    const onChange = jest.fn();
    render(
      <UploadConfigSection
        app={appWithUploads({ recognizeText: true })}
        onChange={onChange}
        t={enT}
        parseNumberOrUndefined={value => Number(value) || undefined}
      />
    );
    const select = screen.getByLabelText(en.admin.apps.edit.recognizeText);
    expect(select).toHaveValue('on');
    fireEvent.change(select, { target: { value: 'default' } });
    expect(onChange).toHaveBeenLastCalledWith('uploads', undefined);
    fireEvent.change(select, { target: { value: 'off' } });
    expect(onChange).toHaveBeenLastCalledWith('uploads', { recognizeText: false });
  });
});

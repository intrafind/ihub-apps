import { renderHook, render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

jest.mock('../../../client/src/api/endpoints/integrationFiles', () => ({
  fetchIntegrationFilesProbe: jest.fn(),
  fetchIntegrationFileMetadata: jest.fn(),
  fetchIntegrationFileContent: jest.fn()
}));
jest.mock('../../../client/src/api', () => ({
  uploadChatFile: jest.fn(),
  deleteChatFile: jest.fn()
}));
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: jest.fn()
}));
jest.mock('../../../client/src/shared/hooks/useFavorites', () => ({
  __esModule: true,
  default: () => ({ favorites: [], isFavorite: () => false, toggleFavorite: jest.fn() })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ resetHeaderColor: jest.fn(), uiConfig: {} })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock(
  '../../../client/src/features/nextcloud-embed/components/NextcloudSelectionBanner',
  () => ({
    __esModule: true,
    default: () => null
  })
);
jest.mock('../../../client/src/features/upload/utils/cloudFileProcessing', () => ({
  processCloudFile: jest.fn()
}));
jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  canonicalMimeType: type => type
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const options = typeof opts === 'string' ? {} : opts || {};
      const fallback = typeof opts === 'string' ? opts : options.defaultValue;
      return (fallback || key).replace('{{name}}', options.name ?? '');
    },
    i18n: { language: 'en' }
  })
}));

import {
  fetchIntegrationFileContent,
  fetchIntegrationFileMetadata,
  fetchIntegrationFilesProbe
} from '../../../client/src/api/endpoints/integrationFiles';
import { processCloudFile } from '../../../client/src/features/upload/utils/cloudFileProcessing';
import { deleteChatFile, uploadChatFile } from '../../../client/src/api';
import useApps from '../../../client/src/shared/hooks/useApps';
import AppsList from '../../../client/src/features/apps/pages/AppsList';
import usePendingDocumentCheck from '../../../client/src/features/apps/hooks/usePendingDocumentCheck';
import useIntegrationDocumentAttachment from '../../../client/src/features/apps/hooks/useIntegrationDocumentAttachment';
import {
  appBindsIntegration,
  boundToolRefsFor,
  appCanTakeDocument,
  isChatReadyForDocument,
  documentFailureKind,
  documentKindOf,
  pendingDocumentQuery,
  readPendingDocument,
  withoutPendingDocument
} from '../../../client/src/features/apps/utils/pendingDocument';

/**
 * "Open in iHub": `/apps?documentId=…&integration=ifinder` keeps the document while the user
 * picks an app, offers the apps that bind that integration and can take the document, hands the
 * document to the chosen app, and says so when the integration or the document is not available.
 */

const params = query => new URLSearchParams(query);
const INFO = {
  id: 'ifinder',
  definition: 'com.intrafind/ifinder',
  type: null,
  name: { en: 'iFinder' }
};
const notFound = (status, error, code) => ({ response: { status, data: { detail: error, code } } });

describe('pendingDocument helpers', () => {
  test('reads a valid link and defaults the optional parts', () => {
    expect(readPendingDocument(params('documentId=d1&integration=ifinder'))).toEqual({
      documentId: 'd1',
      integration: 'ifinder',
      searchProfile: '',
      prefill: ''
    });
    expect(
      readPendingDocument(
        params('documentId=d1&integration=ifinder&searchProfile=sp&prefill=Hello')
      )
    ).toMatchObject({ searchProfile: 'sp', prefill: 'Hello' });
  });

  test.each([
    ['no id', 'integration=ifinder'],
    ['no integration', 'documentId=d1'],
    ['the retired source parameter', 'documentId=d1&source=ifinder'],
    ['an integration that is not an installation id', 'documentId=d1&integration=../etc'],
    ['an id past the server limit', `documentId=${'x'.repeat(1025)}&integration=ifinder`]
  ])('treats %s as no pending document', (_name, query) => {
    expect(readPendingDocument(params(query))).toBeNull();
  });

  test('hands on only the document parameters, never send, model or var_*', () => {
    const doc = readPendingDocument(
      params(
        'documentId=d1&integration=ifinder&searchProfile=sp&prefill=Hi&send=true&model=m&var_x=1&source=x'
      )
    );
    const forwarded = params(pendingDocumentQuery(doc));
    expect([...forwarded.keys()].sort()).toEqual([
      'documentId',
      'integration',
      'prefill',
      'searchProfile'
    ]);
  });

  test('withoutPendingDocument keeps unrelated parameters', () => {
    const rest = withoutPendingDocument(
      params('documentId=d1&integration=ifinder&lang=de&prefill=x')
    );
    expect(rest.toString()).toBe('lang=de');
  });

  test('appBindsIntegration: by installation id, definition id or type — and only those', () => {
    const info = { id: 'ifinder', definition: 'com.intrafind/ifinder', type: 'search' };
    expect(appBindsIntegration({ integrations: { ifinder: {} } }, info)).toBe(true);
    expect(appBindsIntegration({ integrations: { 'com.intrafind/ifinder': {} } }, info)).toBe(true);
    expect(appBindsIntegration({ integrations: { 'type:search': {} } }, info)).toBe(true);
    expect(appBindsIntegration({ integrations: { jira: {} } }, info)).toBe(false);
    expect(appBindsIntegration({ tools: ['iFinder_search'] }, info)).toBe(false);
    expect(appBindsIntegration({ integrations: { ifinder: {} } }, null)).toBe(false);
  });

  test('boundToolRefsFor: the binding keys of the integration that give the chat tools', () => {
    const info = { id: 'ifinder', definition: 'com.intrafind/ifinder', type: 'search' };
    expect(boundToolRefsFor({ integrations: { ifinder: {} } }, info)).toEqual(['ifinder']);
    expect(
      boundToolRefsFor({ integrations: { 'com.intrafind/ifinder': {}, jira: {} } }, info)
    ).toEqual(['com.intrafind/ifinder']);
    expect(boundToolRefsFor({ integrations: { 'type:search': {} } }, info)).toEqual([
      'type:search'
    ]);
    // A binding for scopes only gives no tools to switch on
    expect(boundToolRefsFor({ integrations: { ifinder: { actions: [] } } }, info)).toEqual([]);
    expect(boundToolRefsFor({ integrations: { jira: {} } }, info)).toEqual([]);
    expect(boundToolRefsFor({}, info)).toEqual([]);
  });

  test('documentKindOf: image, audio or document, from the file name, then the types', () => {
    expect(documentKindOf({ filename: 'scan.PNG' })).toBe('image');
    expect(documentKindOf({ mediaType: 'image/jpeg' })).toBe('image');
    expect(documentKindOf({ contentType: 'audio/mpeg' })).toBe('audio');
    expect(documentKindOf({ filename: 'report.pdf', mediaType: 'application/pdf' })).toBe(
      'document'
    );
    expect(documentKindOf({ filename: 'scan.tiff' })).toBe('document');
    expect(documentKindOf({})).toBe('document');
  });

  test('appCanTakeDocument: a chat app that binds the integration, whatever its upload settings', () => {
    const app = { integrations: { ifinder: {} } };
    expect(appCanTakeDocument(app, INFO)).toBe(true);
    expect(appCanTakeDocument({ ...app, upload: { enabled: false } }, INFO)).toBe(true);
    expect(appCanTakeDocument({ ...app, integrations: {} }, INFO)).toBe(false);
    expect(appCanTakeDocument({ upload: { fileUpload: { enabled: true } } }, INFO)).toBe(false);
    expect(appCanTakeDocument({ ...app, type: 'redirect' }, INFO)).toBe(false);
  });

  test("isChatReadyForDocument: the route's own app, initialized settings, models and a model", () => {
    const state = {
      app: { id: 'summarizer' },
      appId: 'summarizer',
      modelsLoading: false,
      settingsInitializedFor: 'summarizer',
      model: { id: 'm' }
    };
    expect(isChatReadyForDocument(state)).toBe(true);
    // The route resolves ids case-insensitively: the app loads under its own id
    expect(isChatReadyForDocument({ ...state, appId: 'Summarizer' })).toBe(true);
    expect(isChatReadyForDocument({ ...state, app: { id: 'other' } })).toBe(false);
    expect(isChatReadyForDocument({ ...state, app: null })).toBe(false);
    expect(isChatReadyForDocument({ ...state, modelsLoading: true })).toBe(false);
    // Settings still hold the previous app
    expect(isChatReadyForDocument({ ...state, settingsInitializedFor: 'other' })).toBe(false);
    expect(isChatReadyForDocument({ ...state, model: null })).toBe(false);
  });

  test('documentFailureKind maps statuses', () => {
    expect(documentFailureKind(401)).toBe('noAccess');
    expect(documentFailureKind(403)).toBe('noAccess');
    expect(documentFailureKind(404)).toBe('notFound');
    expect(documentFailureKind(500)).toBe('failed');
    expect(documentFailureKind(undefined)).toBe('failed');
  });
});

describe('usePendingDocumentCheck', () => {
  const doc = { documentId: 'd1', integration: 'ifinder', searchProfile: 'sp' };
  beforeEach(() => {
    fetchIntegrationFilesProbe.mockReset().mockResolvedValue(INFO);
    fetchIntegrationFileMetadata.mockReset();
  });

  test('no document, no request', () => {
    const { result } = renderHook(() => usePendingDocumentCheck(null));
    expect(result.current.status).toBe('none');
    expect(fetchIntegrationFilesProbe).not.toHaveBeenCalled();
  });

  test('ready with the title and the integration, asking with the profile as scope', async () => {
    fetchIntegrationFileMetadata.mockResolvedValue({ title: 'Site photo' });
    const { result } = renderHook(() => usePendingDocumentCheck(doc));
    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({ title: 'Site photo', info: INFO });
    expect(fetchIntegrationFileMetadata.mock.calls[0][0]).toMatchObject({
      integration: 'ifinder',
      ref: { id: 'd1', scope: 'sp' }
    });
  });

  test('the integration is known while the document details are still loading', async () => {
    let finish;
    fetchIntegrationFileMetadata.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const { result } = renderHook(() => usePendingDocumentCheck(doc));
    await waitFor(() => expect(result.current.info).toEqual(INFO));
    expect(result.current.status).toBe('checking');
    await act(async () => finish({ title: 'Site photo' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  test.each([
    [404, 'unavailable'],
    [403, 'unavailable'],
    [500, 'unverified']
  ])('probe status %s is %s and the document is not asked for', async (status, expected) => {
    fetchIntegrationFilesProbe.mockRejectedValue(notFound(status, 'x'));
    const { result } = renderHook(() => usePendingDocumentCheck(doc));
    await waitFor(() => expect(result.current.status).toBe(expected));
    expect(fetchIntegrationFileMetadata).not.toHaveBeenCalled();
  });

  test.each([
    [403, undefined, undefined, 'noAccess'],
    [401, undefined, undefined, 'noAccess'],
    [404, 'Document not found', undefined, 'notFound'],
    [404, 'This integration has no details', 'DOCUMENT_DETAILS_UNAVAILABLE', 'unverified'],
    [500, 'boom', undefined, 'unverified']
  ])(
    'metadata status %s (%s) is %s, keeping the integration',
    async (status, error, code, expected) => {
      fetchIntegrationFileMetadata.mockRejectedValue(notFound(status, error, code));
      const { result } = renderHook(() => usePendingDocumentCheck(doc));
      await waitFor(() => expect(result.current.status).toBe(expected));
      expect(result.current.info).toEqual(INFO);
    }
  );

  test('a network failure does not rule the document out', async () => {
    fetchIntegrationFilesProbe.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => usePendingDocumentCheck(doc));
    await waitFor(() => expect(result.current.status).toBe('unverified'));
  });
});

describe('AppsList with a pending document', () => {
  const upload = { enabled: true, fileUpload: { enabled: true } };
  const bound = {
    id: 'summarizer',
    name: { en: 'Summarizer' },
    description: { en: '' },
    upload,
    integrations: { ifinder: {} }
  };
  const boundNoUpload = {
    id: 'reader',
    name: { en: 'Reader' },
    description: { en: '' },
    integrations: { ifinder: {} }
  };
  const unbound = { id: 'poet', name: { en: 'Poet' }, description: { en: '' }, upload };
  const noImages = {
    id: 'text-only',
    name: { en: 'Text only' },
    description: { en: '' },
    integrations: { ifinder: {} },
    upload: { ...upload, imageUpload: { enabled: false } }
  };

  let location;
  function Probe() {
    location = useLocation();
    return null;
  }
  const renderAt = url =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Probe />
        <Routes>
          <Route path="/apps" element={<AppsList />} />
          <Route path="/apps/:appId" element={<div>app page</div>} />
        </Routes>
      </MemoryRouter>
    );

  beforeEach(() => {
    fetchIntegrationFilesProbe.mockReset().mockResolvedValue(INFO);
    fetchIntegrationFileMetadata
      .mockReset()
      .mockResolvedValue({ title: 'Annual report', filename: 'report.pdf' });
    useApps.mockReturnValue({
      apps: [bound, boundNoUpload, unbound, noImages],
      loading: false,
      error: null
    });
  });

  test('offers the apps that bind the integration, and hands the document on', async () => {
    renderAt('/apps?documentId=d1&integration=ifinder&searchProfile=sp&send=true');

    expect(await screen.findByText('Choose an app to open “Annual report” in')).toBeTruthy();
    expect(screen.getByLabelText('Summarizer')).toBeTruthy();
    // The binding is what lets an app receive the document, whatever its upload settings say
    expect(screen.getByLabelText('Reader')).toBeTruthy();
    expect(screen.getByLabelText('Text only')).toBeTruthy();
    expect(screen.queryByLabelText('Poet')).toBeNull(); // never opted into iFinder

    fireEvent.click(screen.getByLabelText('Summarizer'));
    expect(location.pathname).toBe('/apps/summarizer');
    const forwarded = new URLSearchParams(location.search);
    expect(forwarded.get('documentId')).toBe('d1');
    expect(forwarded.get('integration')).toBe('ifinder');
    expect(forwarded.get('searchProfile')).toBe('sp');
    expect(forwarded.has('send')).toBe(false);
    expect(forwarded.has('source')).toBe(false);
  });

  test('the checkbox shows every app again', async () => {
    renderAt('/apps?documentId=d1&integration=ifinder');
    await screen.findByText(/Annual report/);
    fireEvent.click(screen.getByLabelText('Only show apps that can use this document'));
    expect(screen.getByLabelText('Poet')).toBeTruthy();
  });

  test('says so when no app binds the integration, and hands nothing on', async () => {
    useApps.mockReturnValue({ apps: [unbound], loading: false, error: null });
    renderAt('/apps?documentId=d1&integration=ifinder&searchProfile=sp');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No app can use documents from this system'
    );
    expect(screen.queryByText(/Choose an app to open/)).toBeNull();
    expect(screen.getByLabelText('Poet')).toBeTruthy(); // apps still open, without the document
    expect(screen.queryByLabelText('Only show apps that can use this document')).toBeNull();

    fireEvent.click(screen.getByLabelText('Poet'));
    expect(location.pathname).toBe('/apps/poet');
    expect(location.search).toBe('');
  });

  test('a provider that is not an installation (project) goes to every app', async () => {
    fetchIntegrationFilesProbe.mockResolvedValue({
      id: 'project',
      definition: null,
      type: null,
      name: 'project'
    });
    useApps.mockReturnValue({ apps: [unbound], loading: false, error: null });
    renderAt('/apps?documentId=d1&integration=project');
    expect(await screen.findByText(/Choose an app to open/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByLabelText('Poet'));
    expect(new URLSearchParams(location.search).get('integration')).toBe('project');
  });

  test('an integration that is not available says so and apps open without the document', async () => {
    fetchIntegrationFilesProbe.mockRejectedValue(notFound(403, 'no', 'INTEGRATION_NOT_GRANTED'));
    renderAt('/apps?documentId=d1&integration=ifinder');

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The system this document comes from is not available to you.'
    );
    fireEvent.click(screen.getByLabelText('Poet'));
    expect(location.pathname).toBe('/apps/poet');
    expect(location.search).toBe('');
  });

  test('an unreadable document is reported and the app opens without it', async () => {
    fetchIntegrationFileMetadata.mockRejectedValue(notFound(403, 'Access denied'));
    renderAt('/apps?documentId=d1&integration=ifinder');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You do not have access to this document.'
    );
    fireEvent.click(screen.getByLabelText('Poet'));
    expect(location.search).toBe('');
  });

  test('a missing document is reported', async () => {
    fetchIntegrationFileMetadata.mockRejectedValue(notFound(404, 'not found'));
    renderAt('/apps?documentId=d1&integration=ifinder');
    expect((await screen.findByRole('alert')).textContent).toContain('could not be found');
  });

  test('dismiss clears the document from the address and keeps other parameters', async () => {
    renderAt('/apps?documentId=d1&integration=ifinder&foo=bar');
    await screen.findByText(/Annual report/);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(location.search).toBe('?foo=bar');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.getByLabelText('Poet')).toBeTruthy();
  });

  test('a plain /apps visit has no banner and no check', () => {
    renderAt('/apps');
    expect(screen.queryByRole('status')).toBeNull();
    expect(fetchIntegrationFilesProbe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Poet'));
    expect(location.pathname + location.search).toBe('/apps/poet');
  });
});

describe('useIntegrationDocumentAttachment', () => {
  const pending = {
    documentId: 'd1',
    integration: 'ifinder',
    searchProfile: 'sp',
    prefill: 'Photo'
  };
  const cfg = (overrides = {}) => ({
    enabled: true,
    imageUpload: { enabled: true },
    audioUpload: { enabled: false },
    fileUpload: { enabled: true, supportedFormats: ['application/pdf'] },
    ...overrides
  });
  let uploader;
  let addSystemMessage;
  let onConsumed;

  const blobResponse = (type, name) => ({
    data: new Blob(['bytes'], { type }),
    headers: { 'content-type': type, 'content-disposition': `attachment; filename="${name}"` }
  });

  const mount = (options = {}) =>
    renderHook(
      props =>
        useIntegrationDocumentAttachment({
          pending,
          ready: true,
          appId: 'app1',
          chatId: 'chat-1',
          app: { id: 'app1', integrations: { ifinder: {} } },
          currentModel: { id: 'm', supportsVision: true },
          fileUploadHandler: uploader,
          addSystemMessage,
          onConsumed,
          ...options,
          ...props
        }),
      { initialProps: {} }
    );

  beforeEach(() => {
    // Keeps what the composer shows, as the real handler does: `selectedFile` is read live
    uploader = {
      selectedFile: null,
      createUploadConfig: jest.fn(() => cfg()),
      setSelectedFile: jest.fn(file => {
        uploader.selectedFile = file;
      }),
      clearSelectedFile: jest.fn(() => {
        uploader.selectedFile = null;
      })
    };
    addSystemMessage = jest.fn();
    onConsumed = jest.fn();
    fetchIntegrationFilesProbe.mockReset().mockResolvedValue(INFO);
    fetchIntegrationFileContent.mockReset();
    processCloudFile.mockReset();
  });

  test('attaches the original image as an image, after a placeholder, and consumes the link once', async () => {
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('image/png', 'site.png'));
    processCloudFile.mockResolvedValue({
      type: 'image',
      base64: 'data:image/png;base64,AA',
      fileName: 'site.png'
    });

    const { rerender } = mount();
    await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));

    expect(fetchIntegrationFileContent).toHaveBeenCalledTimes(1);
    expect(fetchIntegrationFileContent.mock.calls[0][0]).toMatchObject({
      integration: 'ifinder',
      ref: { id: 'd1', scope: 'sp' },
      format: 'original'
    });
    expect(processCloudFile.mock.calls[0][0].name).toBe('site.png');
    expect(uploader.setSelectedFile.mock.calls[0][0]).toMatchObject({
      loading: true,
      fileName: 'Photo'
    });
    expect(uploader.setSelectedFile.mock.calls.at(-1)[0]).toMatchObject({
      type: 'image',
      source: 'ifinder',
      integration: 'ifinder'
    });
    expect(addSystemMessage).not.toHaveBeenCalled();

    rerender({});
    await act(async () => {});
    expect(fetchIntegrationFileContent).toHaveBeenCalledTimes(1); // a re-render attaches nothing twice
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  test('switches on the tools of the binding for the integration the link comes from', async () => {
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
    processCloudFile.mockResolvedValue({ type: 'document', content: 'text', fileName: 'r.pdf' });
    const onIntegrationBound = jest.fn();
    mount({ onIntegrationBound });
    await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
    expect(onIntegrationBound).toHaveBeenCalledWith(['ifinder']);
  });

  test('switches nothing on for an app that does not bind the integration', async () => {
    const onIntegrationBound = jest.fn();
    mount({ onIntegrationBound, app: { id: 'app1', integrations: { jira: {} } } });
    await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
    expect(onIntegrationBound).not.toHaveBeenCalled();
  });

  test('the composer holds Send while the document loads, also when the run goes stale', async () => {
    uploader.setAttachmentProcessing = jest.fn();
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
    processCloudFile.mockResolvedValue({
      type: 'document',
      content: 'text',
      fileName: 'report.pdf'
    });
    mount();
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    const calls = uploader.setAttachmentProcessing.mock.calls;
    expect(calls[0]).toEqual(['integration-document', true]);
    expect(calls.at(-1)).toEqual(['integration-document', false]);
    // Busy before the placeholder is shown, idle only after the attachment is in the composer
    const busy = uploader.setAttachmentProcessing.mock.invocationCallOrder[0];
    expect(busy).toBeLessThan(uploader.setSelectedFile.mock.invocationCallOrder[0]);
    expect(uploader.setAttachmentProcessing.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      uploader.setSelectedFile.mock.invocationCallOrder.at(-1)
    );
  });

  test.each([
    ['an image served as a generic type', 'application/octet-stream', 'site.png', 'image/png'],
    ['a type with parameters', 'Image/JPEG; charset=binary', 'photo.jpg', 'image/jpeg'],
    ['no type at all', undefined, 'site.png', 'image/png']
  ])('the file gets a normalized type: %s', async (_, sent, name, expected) => {
    fetchIntegrationFileContent.mockResolvedValue({
      data: new Blob(['bytes']),
      headers: {
        ...(sent ? { 'content-type': sent } : {}),
        'content-disposition': `attachment; filename="${name}"`
      }
    });
    processCloudFile.mockResolvedValue({ type: 'image', fileName: name });
    mount({ currentModel: { id: 'm', supportsVision: true } });
    await waitFor(() => expect(processCloudFile).toHaveBeenCalledTimes(1));
    expect(processCloudFile.mock.calls[0][0].type).toBe(expected);
  });

  test('a document keeps its type and is labelled with the integration', async () => {
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
    processCloudFile.mockResolvedValue({
      type: 'document',
      content: 'text',
      fileName: 'report.pdf'
    });
    mount();
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    expect(uploader.setSelectedFile.mock.calls.at(-1)[0]).toMatchObject({
      type: 'document',
      displayType: 'iFinder document'
    });
  });

  test('a model that cannot see does not get an image, and says so', async () => {
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('image/png', 'site.png'));
    mount({ currentModel: { id: 'm', supportsVision: false } });
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    expect(processCloudFile).not.toHaveBeenCalled();
    expect(uploader.clearSelectedFile).toHaveBeenCalled();
    expect(addSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('selected model cannot take this kind of file'),
      true
    );
  });

  test('without a model only a document goes in, never an image or audio', async () => {
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('image/png', 'site.png'));
    mount({ currentModel: null });
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    expect(processCloudFile).not.toHaveBeenCalled();
    expect(addSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('selected model cannot take this kind of file'),
      true
    );

    jest.clearAllMocks();
    fetchIntegrationFilesProbe.mockResolvedValue(INFO);
    uploader.createUploadConfig.mockReturnValue(cfg());
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
    processCloudFile.mockResolvedValue({
      type: 'document',
      content: 'text',
      fileName: 'report.pdf'
    });
    mount({ currentModel: null, pending: { ...pending, documentId: 'd2' } });
    await waitFor(() => expect(processCloudFile).toHaveBeenCalledTimes(1));
  });

  describe('by reference, on the server', () => {
    const stored = {
      id: 'f1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      bytes: 1500,
      originalBytes: 1200,
      textBytes: 300,
      hasOriginal: true
    };
    const serverFiles = { enabled: true, ephemeral: false };
    beforeEach(() => {
      uploadChatFile.mockReset().mockResolvedValue({ file: stored });
      deleteChatFile.mockReset().mockResolvedValue({});
    });

    test('the server fetches the document: nothing is downloaded into the browser', async () => {
      mount({ serverFiles });
      await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));

      expect(uploadChatFile).toHaveBeenCalledTimes(1);
      expect(uploadChatFile.mock.calls[0][0]).toBe('chat-1');
      expect(uploadChatFile.mock.calls[0][1]).toEqual({
        source: { kind: 'ifinder-document', ref: { documentId: 'd1', searchProfile: 'sp' } }
      });
      expect(uploadChatFile.mock.calls[0][2].fields).toEqual({ appId: 'app1' });
      // No bytes through the browser, no text extraction here
      expect(fetchIntegrationFileContent).not.toHaveBeenCalled();
      expect(processCloudFile).not.toHaveBeenCalled();
      // The composer holds a stub: the stored file's id, what the server read, no content
      const entry = uploader.setSelectedFile.mock.calls.at(-1)[0];
      expect(entry).toMatchObject({
        type: 'document',
        source: 'ifinder',
        integration: 'ifinder',
        chatId: 'chat-1',
        fileId: 'f1',
        serverStored: true,
        hasOriginal: true,
        textBytes: 300,
        fileName: 'report.pdf',
        fileSize: 1200,
        displayType: 'iFinder document'
      });
      expect(entry.content).toBeUndefined();
      expect(addSystemMessage).not.toHaveBeenCalled();
    });

    test('a temporary chat is created as one', async () => {
      mount({ serverFiles: { enabled: true, ephemeral: true } });
      await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
      expect(uploadChatFile.mock.calls[0][2].fields).toEqual({ appId: 'app1', ephemeral: true });
    });

    test.each([
      ['a quota', 413, 'QUOTA_USER_BYTES'],
      ['a chat that is full', 413, 'QUOTA_CHAT_FILES'],
      ['a file with no text', 400, 'NO_TEXT'],
      ['a file store that is down', 503, undefined]
    ])(
      "%s is the server's limit on storing: the browser attaches the document",
      async (_, status, code) => {
        uploadChatFile.mockRejectedValue({
          response: { status, data: code ? { details: { code } } : {} }
        });
        fetchIntegrationFileContent.mockResolvedValue(
          blobResponse('application/pdf', 'report.pdf')
        );
        processCloudFile.mockResolvedValue({
          type: 'document',
          content: 'text',
          fileName: 'r.pdf'
        });
        mount({ serverFiles });
        await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
        expect(fetchIntegrationFileContent).toHaveBeenCalledTimes(1);
        expect(uploader.setSelectedFile.mock.calls.at(-1)[0]).toMatchObject({ type: 'document' });
        expect(addSystemMessage).not.toHaveBeenCalled();
      }
    );

    test('a security scan that rejects the file is final: said in the chat, the browser is not asked', async () => {
      uploadChatFile.mockRejectedValue({
        response: { status: 400, data: { code: 'SCAN_REJECTED' } }
      });
      mount({ serverFiles });
      await waitFor(() => expect(addSystemMessage).toHaveBeenCalledTimes(1));
      expect(fetchIntegrationFileContent).not.toHaveBeenCalled();
    });

    test('a transcription model takes no document: the browser path decides what the file is', async () => {
      fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
      mount({ serverFiles, currentModel: { id: 'm', modelType: 'transcription' } });
      await waitFor(() => expect(addSystemMessage).toHaveBeenCalledTimes(1));
      expect(uploadChatFile).not.toHaveBeenCalled();
      expect(addSystemMessage.mock.calls[0][0]).toMatch(/model cannot take this kind of file/);
    });

    test('a file the server cannot take as a document goes the browser way (an image)', async () => {
      uploadChatFile.mockRejectedValue({
        response: { status: 400, data: { code: 'UNSUPPORTED_TYPE' } }
      });
      fetchIntegrationFileContent.mockResolvedValue(blobResponse('image/png', 'site.png'));
      processCloudFile.mockResolvedValue({ type: 'image', fileName: 'site.png' });
      mount({ serverFiles, currentModel: { id: 'm', supportsVision: true } });
      await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
      expect(fetchIntegrationFileContent).toHaveBeenCalledTimes(1);
      expect(uploader.setSelectedFile.mock.calls.at(-1)[0]).toMatchObject({ type: 'image' });
      expect(addSystemMessage).not.toHaveBeenCalled();
    });

    test.each([
      [403, 'SOURCE_FORBIDDEN', /do not have access/],
      [404, 'SOURCE_GONE', /was not found/],
      [400, 'SOURCE_UNAVAILABLE', /not available to you/],
      [502, 'SOURCE_FAILED', /Please try again/]
    ])(
      'a refusal of %s (%s) is said in the chat, and the browser is not asked',
      async (status, code, text) => {
        uploadChatFile.mockRejectedValue({
          originalError: { response: { status, data: { code } } }
        });
        mount({ serverFiles });
        await waitFor(() => expect(addSystemMessage).toHaveBeenCalledTimes(1));
        expect(addSystemMessage.mock.calls[0][0]).toMatch(text);
        expect(fetchIntegrationFileContent).not.toHaveBeenCalled();
        expect(uploader.clearSelectedFile).toHaveBeenCalled();
        expect(onConsumed).toHaveBeenCalledTimes(1);
      }
    );

    test('a chat that keeps no files on the server fetches in the browser as before', async () => {
      fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
      processCloudFile.mockResolvedValue({ type: 'document', content: 'text', fileName: 'r.pdf' });
      mount({ serverFiles: { enabled: false } });
      await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
      expect(uploadChatFile).not.toHaveBeenCalled();
      expect(fetchIntegrationFileContent).toHaveBeenCalledTimes(1);
    });

    test('an integration the server cannot fetch from fetches in the browser', async () => {
      fetchIntegrationFilesProbe.mockResolvedValue({
        id: 'wiki',
        definition: 'com.example/wiki',
        type: null,
        name: 'Wiki'
      });
      fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
      processCloudFile.mockResolvedValue({ type: 'document', content: 'text', fileName: 'r.pdf' });
      mount({
        serverFiles,
        pending: { ...pending, integration: 'wiki' },
        app: { id: 'app1', integrations: { wiki: {} } }
      });
      await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
      expect(uploadChatFile).not.toHaveBeenCalled();
      expect(fetchIntegrationFileContent).toHaveBeenCalledTimes(1);
    });

    test('an app that does not bind the integration gets nothing, not even a server fetch', async () => {
      mount({ serverFiles, app: { id: 'app1', integrations: { jira: {} } } });
      await waitFor(() => expect(addSystemMessage).toHaveBeenCalledTimes(1));
      expect(uploadChatFile).not.toHaveBeenCalled();
    });

    test('a chat that moved on while the server fetched does not keep the stored file', async () => {
      let finish;
      uploadChatFile.mockReturnValue(new Promise(resolve => (finish = resolve)));
      const { rerender } = mount({ serverFiles });
      await waitFor(() => expect(uploadChatFile).toHaveBeenCalled());
      rerender({ chatId: 'chat-2' });
      await act(async () => finish({ file: stored }));
      await waitFor(() => expect(deleteChatFile).toHaveBeenCalledWith('chat-1', 'f1'));
      expect(uploader.setSelectedFile.mock.calls.at(-1)[0]).not.toMatchObject({ fileId: 'f1' });
    });
  });

  describe("the model rules are the uploader's", () => {
    test('a transcription model takes audio, not an image and not a document', async () => {
      const model = { id: 'whisper', modelType: 'transcription' };
      fetchIntegrationFileContent.mockResolvedValue(blobResponse('image/png', 'site.png'));
      mount({ currentModel: model });
      await waitFor(() => expect(onConsumed).toHaveBeenCalled());
      expect(processCloudFile).not.toHaveBeenCalled();
      expect(addSystemMessage).toHaveBeenCalledWith(
        expect.stringContaining('selected model cannot take this kind of file'),
        true
      );

      jest.clearAllMocks();
      fetchIntegrationFilesProbe.mockResolvedValue(INFO);
      fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'r.pdf'));
      mount({ currentModel: model, pending: { ...pending, documentId: 'd2', prefill: 'r' } });
      await waitFor(() => expect(addSystemMessage).toHaveBeenCalled());
      expect(processCloudFile).not.toHaveBeenCalled();

      jest.clearAllMocks();
      fetchIntegrationFilesProbe.mockResolvedValue(INFO);
      fetchIntegrationFileContent.mockResolvedValue(blobResponse('audio/mpeg', 'talk.mp3'));
      processCloudFile.mockResolvedValue({ type: 'audio', fileName: 'talk.mp3' });
      mount({ currentModel: model, pending: { ...pending, documentId: 'd3', prefill: 'talk' } });
      await waitFor(() => expect(processCloudFile).toHaveBeenCalledTimes(1));
    });

    test('a model without vision metadata is judged by its id, as the uploader does', async () => {
      fetchIntegrationFileContent.mockResolvedValue(blobResponse('image/png', 'site.png'));
      processCloudFile.mockResolvedValue({ type: 'image', fileName: 'site.png' });
      mount({ currentModel: { id: 'gpt-4o-mini' } });
      await waitFor(() => expect(processCloudFile).toHaveBeenCalledTimes(1));
    });
  });

  test('the binding decides: an app without local upload still gets the document', async () => {
    uploader.createUploadConfig.mockReturnValue({ enabled: false, localUploadEnabled: false });
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
    processCloudFile.mockResolvedValue({
      type: 'document',
      content: 'text',
      fileName: 'report.pdf'
    });
    mount();
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    expect(processCloudFile).toHaveBeenCalledTimes(1);
    expect(addSystemMessage).not.toHaveBeenCalled();
  });

  test('an app that does not bind the integration does not get its document', async () => {
    mount({ app: { id: 'app1', integrations: { jira: {} } } });
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    expect(fetchIntegrationFileContent).not.toHaveBeenCalled();
    expect(uploader.clearSelectedFile).toHaveBeenCalled();
    expect(addSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('does not use the system it comes from'),
      true
    );
  });

  test('a provider that is not an installation (project documents) needs no binding', async () => {
    fetchIntegrationFilesProbe.mockResolvedValue({
      id: 'project',
      definition: null,
      type: null,
      name: 'project'
    });
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('text/plain', 'item.txt'));
    processCloudFile.mockResolvedValue({ type: 'document', content: 'item', fileName: 'item.txt' });
    mount({
      pending: { documentId: 'i1', integration: 'project', searchProfile: 'p1', prefill: 'Item' },
      app: { id: 'app1' }
    });
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    expect(processCloudFile).toHaveBeenCalledTimes(1);
    expect(addSystemMessage).not.toHaveBeenCalled();
  });

  test.each([
    [{ status: 403, data: { code: 'INTEGRATION_NOT_GRANTED' } }, 'not available to you'],
    [{ status: 404, data: { code: 'INTEGRATION_NOT_CONFIGURED' } }, 'not available to you'],
    [{ status: 403, data: {} }, 'you do not have access'],
    [{ status: 404, data: {} }, 'was not found'],
    [{ status: 500, data: {} }, 'Please try again']
  ])('says why a document could not be attached (%j)', async (response, text) => {
    fetchIntegrationFilesProbe.mockRejectedValue({ response });
    mount();
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    expect(uploader.clearSelectedFile).toHaveBeenCalled();
    expect(addSystemMessage).toHaveBeenCalledWith(expect.stringContaining(text), true);
  });

  test('a failed download of the original falls back to the text, never for a permission failure', async () => {
    fetchIntegrationFileContent
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce({ data: 'plain text', headers: { 'content-type': 'text/plain' } });
    processCloudFile.mockResolvedValue({
      type: 'document',
      content: 'plain text',
      fileName: 'Photo.txt'
    });
    mount();
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
    expect(fetchIntegrationFileContent.mock.calls[1][0].format).toBe('text');
    expect(processCloudFile.mock.calls[0][0].name).toBe('Photo.txt');
  });

  test.each([401, 403, 404])(
    'a %s on the original is shown, not turned into a text request',
    async status => {
      fetchIntegrationFileContent.mockRejectedValue({ response: { status, data: {} } });
      mount();
      await waitFor(() => expect(onConsumed).toHaveBeenCalled());
      expect(fetchIntegrationFileContent).toHaveBeenCalledTimes(1);
      expect(processCloudFile).not.toHaveBeenCalled();
      expect(addSystemMessage).toHaveBeenCalledTimes(1);
    }
  );

  describe('when the chat moves on while the document loads', () => {
    let release;
    beforeEach(() => {
      fetchIntegrationFileContent.mockImplementation(
        () =>
          new Promise(resolve => {
            release = () => resolve(blobResponse('application/pdf', 'report.pdf'));
          })
      );
      processCloudFile.mockResolvedValue({
        type: 'document',
        content: 'text',
        fileName: 'report.pdf'
      });
    });
    const finish = async () => {
      await act(async () => {
        release();
      });
      await act(async () => {});
    };

    test('the latest callback consumes the link, not the one the run started with', async () => {
      const first = jest.fn();
      const latest = jest.fn();
      const { rerender } = mount({ onConsumed: first });
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      rerender({ onConsumed: latest });
      await finish();
      expect(latest).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
    });

    test('a user who left (no document pending any more) gets nothing attached and nothing consumed', async () => {
      const { rerender } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      uploader.setSelectedFile.mockClear();
      rerender({ pending: null });
      await finish();
      expect(processCloudFile).not.toHaveBeenCalled();
      expect(uploader.setSelectedFile).not.toHaveBeenCalled();
      expect(onConsumed).not.toHaveBeenCalled();
      expect(addSystemMessage).not.toHaveBeenCalled();
    });

    test('another app opened meanwhile gets nothing either', async () => {
      const { rerender } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      uploader.setSelectedFile.mockClear();
      rerender({ app: { id: 'app2', integrations: { ifinder: {} } } });
      await finish();
      expect(uploader.setSelectedFile).not.toHaveBeenCalled();
      expect(onConsumed).not.toHaveBeenCalled();
    });

    test('a failure after the user left is not reported in the new chat', async () => {
      const { rerender } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      rerender({ pending: null });
      processCloudFile.mockRejectedValue(new Error('boom'));
      await finish();
      expect(addSystemMessage).not.toHaveBeenCalled();
      expect(uploader.selectedFile).toBeNull();
    });

    test('a stale run takes its own loading placeholder away, so it is no endless spinner', async () => {
      const { rerender } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      expect(uploader.selectedFile).toMatchObject({ loading: true });
      rerender({ pending: null });
      await finish();
      expect(uploader.selectedFile).toBeNull();
    });

    test("a new chat (incognito, history) on the same app and link clears the old run's placeholder", async () => {
      const { rerender } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      expect(uploader.selectedFile).toMatchObject({ loading: true });
      rerender({ chatId: 'chat-2' });
      await finish();
      expect(uploader.selectedFile).toBeNull();
      expect(onConsumed).not.toHaveBeenCalled();
    });

    test('a file selected meanwhile is not removed by the stale run', async () => {
      const { rerender } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      const mine = { type: 'document', fileName: 'mine.txt', content: 'x' };
      uploader.selectedFile = mine;
      rerender({ pending: null });
      await finish();
      expect(uploader.selectedFile).toBe(mine);
      expect(uploader.clearSelectedFile).not.toHaveBeenCalled();
    });

    test('a new chat on the same app and the same link gets nothing from the old run', async () => {
      const { rerender } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      uploader.setSelectedFile.mockClear();
      rerender({ chatId: 'chat-2' });
      await finish();
      expect(uploader.setSelectedFile).not.toHaveBeenCalled();
      expect(onConsumed).not.toHaveBeenCalled();
    });

    test('the route moving to another app ends the run even before the new app has loaded', async () => {
      const { rerender } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      uploader.setSelectedFile.mockClear();
      // The route changed, the loaded app is still the old one, the link is the same
      rerender({ appId: 'app2' });
      await finish();
      expect(uploader.setSelectedFile).not.toHaveBeenCalled();
      expect(onConsumed).not.toHaveBeenCalled();
    });

    test('an unmounted chat consumes nothing', async () => {
      const { unmount } = mount();
      await waitFor(() => expect(fetchIntegrationFileContent).toHaveBeenCalled());
      unmount();
      await finish();
      expect(onConsumed).not.toHaveBeenCalled();
    });
  });

  test('waits until the app and models are ready', async () => {
    fetchIntegrationFileContent.mockResolvedValue(blobResponse('application/pdf', 'report.pdf'));
    processCloudFile.mockResolvedValue({ type: 'document', fileName: 'report.pdf' });
    const { rerender } = mount({ ready: false });
    await act(async () => {});
    expect(fetchIntegrationFilesProbe).not.toHaveBeenCalled();
    rerender({ ready: true });
    await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
  });

  test('nothing to attach, nothing happens', async () => {
    mount({ pending: null });
    await act(async () => {});
    expect(onConsumed).not.toHaveBeenCalled();
    expect(fetchIntegrationFilesProbe).not.toHaveBeenCalled();
  });
});

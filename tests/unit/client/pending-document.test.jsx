import { renderHook, render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

jest.mock('../../../client/src/api/endpoints/integrationFiles', () => ({
  fetchIntegrationFilesProbe: jest.fn(),
  fetchIntegrationFileMetadata: jest.fn(),
  fetchIntegrationFileContent: jest.fn()
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
import useApps from '../../../client/src/shared/hooks/useApps';
import AppsList from '../../../client/src/features/apps/pages/AppsList';
import usePendingDocumentCheck from '../../../client/src/features/apps/hooks/usePendingDocumentCheck';
import useIntegrationDocumentAttachment from '../../../client/src/features/apps/hooks/useIntegrationDocumentAttachment';
import {
  appBindsIntegration,
  appCanTakeDocument,
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
const notFound = (status, error, code) => ({ response: { status, data: { error, code } } });

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
    [403, undefined, 'noAccess'],
    [401, undefined, 'noAccess'],
    [404, 'Document not found', 'notFound'],
    [404, 'This integration has no details', 'unverified'],
    [500, 'boom', 'unverified']
  ])('metadata status %s (%s) is %s, keeping the integration', async (status, error, expected) => {
    fetchIntegrationFileMetadata.mockRejectedValue(notFound(status, error));
    const { result } = renderHook(() => usePendingDocumentCheck(doc));
    await waitFor(() => expect(result.current.status).toBe(expected));
    expect(result.current.info).toEqual(INFO);
  });

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

  test('does not narrow the list when no app qualifies', async () => {
    useApps.mockReturnValue({ apps: [unbound], loading: false, error: null });
    renderAt('/apps?documentId=d1&integration=ifinder');
    await screen.findByText(/Annual report/);
    expect(screen.getByLabelText('Poet')).toBeTruthy();
    expect(screen.queryByLabelText('Only show apps that can use this document')).toBeNull();
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
          app: { id: 'app1', integrations: { ifinder: {} } },
          currentModel: { id: 'm' },
          fileUploadHandler: uploader,
          addSystemMessage,
          onConsumed,
          ...options,
          ...props
        }),
      { initialProps: {} }
    );

  beforeEach(() => {
    uploader = {
      createUploadConfig: jest.fn(() => cfg()),
      setSelectedFile: jest.fn(),
      clearSelectedFile: jest.fn()
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
      expect(uploader.clearSelectedFile).not.toHaveBeenCalled();
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

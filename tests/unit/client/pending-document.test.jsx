import { renderHook, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

jest.mock('../../../client/src/api/endpoints/sources', () => ({
  fetchSourceMetadata: jest.fn()
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

import { fetchSourceMetadata } from '../../../client/src/api/endpoints/sources';
import useApps from '../../../client/src/shared/hooks/useApps';
import AppsList from '../../../client/src/features/apps/pages/AppsList';
import usePendingDocumentCheck from '../../../client/src/features/apps/hooks/usePendingDocumentCheck';
import {
  appAcceptsDocuments,
  documentFailureKind,
  pendingDocumentQuery,
  readPendingDocument,
  withoutPendingDocument
} from '../../../client/src/features/apps/utils/pendingDocument';

/**
 * "Open in iHub": `/apps?documentId=…&source=ifinder` keeps the document while the user picks an
 * app, hands it on to that app, and says so when the document cannot be read.
 */

const params = query => new URLSearchParams(query);

describe('pendingDocument helpers', () => {
  test('reads a valid link and defaults the optional parts', () => {
    expect(readPendingDocument(params('documentId=d1&source=ifinder'))).toEqual({
      documentId: 'd1',
      source: 'ifinder',
      searchProfile: '',
      prefill: ''
    });
    expect(
      readPendingDocument(params('documentId=d1&source=ifinder&searchProfile=sp&prefill=Hello'))
    ).toMatchObject({ searchProfile: 'sp', prefill: 'Hello' });
  });

  test.each([
    ['no id', 'source=ifinder'],
    ['no source', 'documentId=d1'],
    ['a source that is not a provider id', 'documentId=d1&source=../etc'],
    ['an id past the server limit', `documentId=${'x'.repeat(1025)}&source=ifinder`]
  ])('treats %s as no pending document', (_name, query) => {
    expect(readPendingDocument(params(query))).toBeNull();
  });

  test('hands on only the document parameters, never send, model or var_*', () => {
    const doc = readPendingDocument(
      params('documentId=d1&source=ifinder&searchProfile=sp&prefill=Hi&send=true&model=m&var_x=1')
    );
    const forwarded = params(pendingDocumentQuery(doc));
    expect([...forwarded.keys()].sort()).toEqual([
      'documentId',
      'prefill',
      'searchProfile',
      'source'
    ]);
    expect(forwarded.get('prefill')).toBe('Hi');
  });

  test('withoutPendingDocument keeps unrelated parameters', () => {
    const rest = withoutPendingDocument(params('documentId=d1&source=ifinder&lang=de&prefill=x'));
    expect(rest.toString()).toBe('lang=de');
  });

  test('appAcceptsDocuments needs a chat app with file upload on', () => {
    expect(appAcceptsDocuments({ upload: { enabled: true, fileUpload: { enabled: true } } })).toBe(
      true
    );
    expect(appAcceptsDocuments({ upload: { fileUpload: { enabled: true } } })).toBe(true);
    expect(appAcceptsDocuments({ upload: { enabled: false, fileUpload: { enabled: true } } })).toBe(
      false
    );
    expect(appAcceptsDocuments({ upload: { imageUpload: { enabled: true } } })).toBe(false);
    expect(
      appAcceptsDocuments({ type: 'redirect', upload: { fileUpload: { enabled: true } } })
    ).toBe(false);
    expect(appAcceptsDocuments(null)).toBe(false);
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
  const doc = { documentId: 'd1', source: 'ifinder', searchProfile: 'sp' };
  beforeEach(() => fetchSourceMetadata.mockReset());

  test('no document, no request', () => {
    const { result } = renderHook(() => usePendingDocumentCheck(null));
    expect(result.current.status).toBe('none');
    expect(fetchSourceMetadata).not.toHaveBeenCalled();
  });

  test('ready with the title, asking with the search profile as scope', async () => {
    fetchSourceMetadata.mockResolvedValue({ title: 'Annual report' });
    const { result } = renderHook(() => usePendingDocumentCheck(doc));
    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.title).toBe('Annual report');
    expect(fetchSourceMetadata.mock.calls[0][0].source).toEqual({
      provider: 'ifinder',
      ref: { id: 'd1', scope: 'sp' }
    });
  });

  test.each([
    [403, undefined, 'noAccess'],
    [401, undefined, 'noAccess'],
    [404, 'Document not found', 'notFound'],
    [404, 'This source provider has no details', 'unverified'],
    [500, 'boom', 'unverified']
  ])('status %s (%s) is %s', async (status, error, expected) => {
    fetchSourceMetadata.mockRejectedValue({ response: { status, data: { error } } });
    const { result } = renderHook(() => usePendingDocumentCheck(doc));
    await waitFor(() => expect(result.current.status).toBe(expected));
  });

  test('a network failure does not rule the document out', async () => {
    fetchSourceMetadata.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => usePendingDocumentCheck(doc));
    await waitFor(() => expect(result.current.status).toBe('unverified'));
  });
});

describe('AppsList with a pending document', () => {
  const docApp = {
    id: 'summarizer',
    name: { en: 'Summarizer' },
    description: { en: '' },
    upload: { enabled: true, fileUpload: { enabled: true } }
  };
  const plainApp = { id: 'poet', name: { en: 'Poet' }, description: { en: '' } };

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
    fetchSourceMetadata.mockReset();
    useApps.mockReturnValue({ apps: [docApp, plainApp], loading: false, error: null });
  });

  test('shows the document, narrows to document apps and hands the document to the chosen app', async () => {
    fetchSourceMetadata.mockResolvedValue({ title: 'Annual report' });
    renderAt('/apps?documentId=d1&source=ifinder&searchProfile=sp&send=true');

    expect(await screen.findByText('Choose an app to open “Annual report” in')).toBeTruthy();
    expect(screen.queryByLabelText('Poet')).toBeNull();

    fireEvent.click(screen.getByLabelText('Summarizer'));
    expect(location.pathname).toBe('/apps/summarizer');
    const forwarded = new URLSearchParams(location.search);
    expect(forwarded.get('documentId')).toBe('d1');
    expect(forwarded.get('source')).toBe('ifinder');
    expect(forwarded.get('searchProfile')).toBe('sp');
    expect(forwarded.has('send')).toBe(false);
  });

  test('the checkbox shows every app again', async () => {
    fetchSourceMetadata.mockResolvedValue({ title: 'Annual report' });
    renderAt('/apps?documentId=d1&source=ifinder');
    await screen.findByText(/Annual report/);
    fireEvent.click(screen.getByLabelText('Only show apps that accept documents'));
    expect(screen.getByLabelText('Poet')).toBeTruthy();
  });

  test('does not narrow the list when no app takes documents', async () => {
    useApps.mockReturnValue({ apps: [plainApp], loading: false, error: null });
    fetchSourceMetadata.mockResolvedValue({ title: 'Annual report' });
    renderAt('/apps?documentId=d1&source=ifinder');
    await screen.findByText(/Annual report/);
    expect(screen.getByLabelText('Poet')).toBeTruthy();
    expect(screen.queryByLabelText('Only show apps that accept documents')).toBeNull();
  });

  test('an unreadable document is reported and the app opens without it', async () => {
    fetchSourceMetadata.mockRejectedValue({
      response: { status: 403, data: { error: 'Access denied' } }
    });
    renderAt('/apps?documentId=d1&source=ifinder');

    expect((await screen.findByRole('alert')).textContent).toContain(
      'You do not have access to this document.'
    );
    fireEvent.click(screen.getByLabelText('Poet'));
    expect(location.pathname).toBe('/apps/poet');
    expect(location.search).toBe('');
  });

  test('a missing document is reported', async () => {
    fetchSourceMetadata.mockRejectedValue({
      response: { status: 404, data: { error: 'not found' } }
    });
    renderAt('/apps?documentId=d1&source=ifinder');
    expect((await screen.findByRole('alert')).textContent).toContain('could not be found');
  });

  test('dismiss clears the document from the address and keeps other parameters', async () => {
    fetchSourceMetadata.mockResolvedValue({ title: 'Annual report' });
    renderAt('/apps?documentId=d1&source=ifinder&foo=bar');
    await screen.findByText(/Annual report/);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(location.search).toBe('?foo=bar');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.getByLabelText('Poet')).toBeTruthy();
  });

  test('a plain /apps visit has no banner and no check', () => {
    renderAt('/apps');
    expect(screen.queryByRole('status')).toBeNull();
    expect(fetchSourceMetadata).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Poet'));
    expect(location.pathname + location.search).toBe('/apps/poet');
  });
});

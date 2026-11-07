jest.mock('../../../client/src/api/client', () => ({ apiClient: { get: jest.fn() } }));

import { apiClient } from '../../../client/src/api/client';
import {
  fetchIntegrationFileContent,
  fetchIntegrationFileMetadata,
  fetchIntegrationFilesProbe
} from '../../../client/src/api/endpoints/integrationFiles';

/**
 * A document is a resource of its integration: the id is a URL-encoded path segment
 * (`/integrations/:integration/files/:id`), what is not part of the path — the scope and the
 * format — is the query, and an optional file name hangs off the content.
 */

beforeEach(() => {
  apiClient.get.mockReset().mockResolvedValue({ data: {} });
});

const urlOfCall = () => apiClient.get.mock.calls[0][0];

test('the probe asks the integration', async () => {
  await fetchIntegrationFilesProbe({ integration: 'ifinder' });
  expect(urlOfCall()).toBe('/integrations/ifinder/files');
});

test('the details are the document itself, with the scope as the only query', async () => {
  await fetchIntegrationFileMetadata({ integration: 'ifinder', ref: { id: 'd1', scope: 'sales' } });
  expect(urlOfCall()).toBe('/integrations/ifinder/files/d1?scope=sales');

  apiClient.get.mockClear();
  await fetchIntegrationFileMetadata({ integration: 'ifinder', ref: { id: 'd1' } });
  expect(urlOfCall()).toBe('/integrations/ifinder/files/d1');
});

test('the content is the original unless another format is asked for', async () => {
  await fetchIntegrationFileContent({ integration: 'ifinder', ref: { id: 'd1' } });
  expect(urlOfCall()).toBe('/integrations/ifinder/files/d1/content');
  expect(apiClient.get.mock.calls[0][1]).toMatchObject({ responseType: 'blob' });

  apiClient.get.mockClear();
  await fetchIntegrationFileContent({
    integration: 'ifinder',
    ref: { id: 'd1', scope: 'sales' },
    format: 'text'
  });
  expect(urlOfCall()).toBe('/integrations/ifinder/files/d1/content?scope=sales&format=text');
});

test('an id and an integration are encoded, whatever characters they carry', async () => {
  await fetchIntegrationFileMetadata({
    integration: 'my integration',
    ref: { id: 'sp:site/Shared Documents/Q1 #2?.pdf' }
  });
  expect(urlOfCall()).toBe(
    '/integrations/my%20integration/files/sp%3Asite%2FShared%20Documents%2FQ1%20%232%3F.pdf'
  );
});

test('a file name goes after the content and is encoded; it is not part of the query', async () => {
  await fetchIntegrationFileContent({
    integration: 'ifinder',
    ref: { id: 'd1', scope: 'sales' },
    filename: 'Prüfung 文档.pdf'
  });
  expect(urlOfCall()).toBe(
    '/integrations/ifinder/files/d1/content/Pr%C3%BCfung%20%E6%96%87%E6%A1%A3.pdf?scope=sales'
  );
});

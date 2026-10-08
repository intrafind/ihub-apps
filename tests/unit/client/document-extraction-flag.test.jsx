/**
 * Admin switch of structure-preserving extraction (concepts/document-extraction/):
 * `structuredDocumentExtraction`, read from the platform config the client already loads.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn()
}));

const config = require('../../../client/src/api/endpoints/config');
const {
  STRUCTURED_EXTRACTION_FEATURE,
  isStructuredExtractionEnabled,
  processDocxFile
} = require('../../../client/src/features/upload/utils/fileProcessing');
const { buildDocxFile, p } = require('../../utils/officeFixtures');

describe('isStructuredExtractionEnabled', () => {
  it('uses the feature id the server registers', () => {
    expect(STRUCTURED_EXTRACTION_FEATURE).toBe('structuredDocumentExtraction');
  });

  it('T-FLAG-02: is off when the admin turned the feature off', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: STRUCTURED_EXTRACTION_FEATURE, enabled: false }]
    });
    expect(await isStructuredExtractionEnabled()).toBe(false);
  });

  it('T-FLAG-02: is on when enabled, when other features are off, and when the feature is absent', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: STRUCTURED_EXTRACTION_FEATURE, enabled: true }]
    });
    expect(await isStructuredExtractionEnabled()).toBe(true);

    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'workflows', enabled: false }]
    });
    expect(await isStructuredExtractionEnabled()).toBe(true);

    config.fetchPlatformConfig.mockResolvedValue({});
    expect(await isStructuredExtractionEnabled()).toBe(true);
  });

  it('T-FLAG-03: is on when the platform config cannot be loaded', async () => {
    config.fetchPlatformConfig.mockRejectedValue(new Error('offline'));
    expect(await isStructuredExtractionEnabled()).toBe(true);
    config.fetchPlatformConfig.mockImplementation(() => {
      throw new TypeError('fetchPlatformConfig is not available yet');
    });
    expect(await isStructuredExtractionEnabled()).toBe(true);
  });

  it('T-FLAG-03: an unreadable platform config does not stop a Word upload', async () => {
    config.fetchPlatformConfig.mockRejectedValue(new Error('offline'));
    const file = await buildDocxFile({ body: p('Eins') + p('Zwei') });
    expect(await processDocxFile(file)).toBe('Eins\n\nZwei');
  });
});

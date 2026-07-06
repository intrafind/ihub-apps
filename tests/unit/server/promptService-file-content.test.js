/**
 * Tests for PromptService.processMessageTemplates file-content injection.
 *
 * Regression test for: "Answer is based on AI knowledge even if content is uploaded"
 * When a user uploads a document and an app uses a prompt template with {{content}},
 * the {{content}} placeholder must be replaced with the uploaded file text — not left
 * as the (empty) user-typed message.
 */

import { describe, it, expect, jest, beforeAll } from '@jest/globals';

// All mocks must be registered before the module under test is dynamically imported.
jest.unstable_mockModule('../../../server/configCache.js', () => ({
  default: {
    getPlatform: jest.fn(() => ({ defaultLanguage: 'en' })),
    getFeatures: jest.fn(() => ({})),
    getStyles: jest.fn(() => ({})),
    getSkillsForApp: jest.fn(() => Promise.resolve([]))
  }
}));

jest.unstable_mockModule('../../../server/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

jest.unstable_mockModule('../../../server/featureRegistry.js', () => ({
  isFeatureEnabled: jest.fn(() => false)
}));

jest.unstable_mockModule('../../../server/sources/index.js', () => ({
  createSourceManager: jest.fn()
}));

jest.unstable_mockModule('../../../server/services/SourceResolutionService.js', () => ({
  default: jest.fn()
}));

jest.unstable_mockModule('../../../server/config.js', () => ({
  default: { CONTENTS_DIR: 'contents' }
}));

jest.unstable_mockModule('../../../server/pathUtils.js', () => ({
  getRootDir: jest.fn(() => '/tmp')
}));

// Dynamic import after mock setup so mocks are active.
const { default: promptService } = await import('../../../server/services/PromptService.js');

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a minimal summariser-style user message with a prompt template */
function createTestMessage({
  userText = '',
  fileData = null,
  promptTemplate = null,
  variables = null
} = {}) {
  const msg = {
    role: 'user',
    content: userText,
    promptTemplate: promptTemplate ?? 'Please summarize the following content: "{{content}}"',
    variables: variables ?? { action: 'summarize' }
  };
  if (fileData) msg.fileData = fileData;
  return msg;
}

/** Run processMessageTemplates with no app (skips system-prompt/sources block).
 *  Returns the processed messages array directly. */
async function processMessages(messages) {
  return promptService.processMessageTemplates(messages, null, null, null, 'en');
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('PromptService.processMessageTemplates — file content in {{content}}', () => {
  it('injects single uploaded file text into {{content}} placeholder', async () => {
    const msg = createTestMessage({
      userText: '',
      fileData: {
        fileName: 'report.pdf',
        fileType: 'application/pdf',
        displayType: 'PDF',
        content: 'This is the report text.'
      }
    });

    const result = await processMessages([msg]);
    const processed = result[0];

    expect(processed.content).toContain('This is the report text.');
    // The template instruction should wrap the file content, not be empty.
    expect(processed.content).toContain('Please summarize the following content:');
    // Ensure the content is NOT empty inside the quotes.
    expect(processed.content).not.toMatch(/following content:\s*""\s*$/);
  });

  it('sets _fileContentInjectedViaTemplate marker when file content is injected', async () => {
    const msg = createTestMessage({
      fileData: {
        fileName: 'doc.txt',
        fileType: 'text/plain',
        displayType: 'TXT',
        content: 'Document body.'
      }
    });

    const result = await processMessages([msg]);
    expect(result[0]._fileContentInjectedViaTemplate).toBe(true);
  });

  it('does NOT set the marker when fileData has no text content (image-based PDF)', async () => {
    const msg = createTestMessage({
      fileData: {
        fileName: 'scan.pdf',
        fileType: 'application/pdf',
        displayType: 'PDF',
        pageImages: ['base64imagedata']
        // no .content property
      }
    });

    const result = await processMessages([msg]);
    expect(result[0]._fileContentInjectedViaTemplate).toBeUndefined();
  });

  it('does NOT set the marker when there is no fileData', async () => {
    const msg = createTestMessage({ userText: 'Hello world' });
    const result = await processMessages([msg]);
    expect(result[0]._fileContentInjectedViaTemplate).toBeUndefined();
  });

  it('combines multiple uploaded files into {{content}}', async () => {
    const msg = createTestMessage({
      fileData: [
        {
          fileName: 'a.txt',
          fileType: 'text/plain',
          displayType: 'TXT',
          content: 'Content of A.'
        },
        {
          fileName: 'b.txt',
          fileType: 'text/plain',
          displayType: 'TXT',
          content: 'Content of B.'
        }
      ]
    });

    const result = await processMessages([msg]);
    const processed = result[0];

    expect(processed.content).toContain('Content of A.');
    expect(processed.content).toContain('Content of B.');
    expect(processed._fileContentInjectedViaTemplate).toBe(true);
  });

  it('includes user-typed text after the file content in {{content}}', async () => {
    const msg = createTestMessage({
      userText: 'Focus on the conclusion.',
      fileData: {
        fileName: 'report.pdf',
        fileType: 'application/pdf',
        displayType: 'PDF',
        content: 'Report text here.'
      }
    });

    const result = await processMessages([msg]);
    const processed = result[0];

    // File content should appear before user text in the template substitution.
    const fileIdx = processed.content.indexOf('Report text here.');
    const userIdx = processed.content.indexOf('Focus on the conclusion.');
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeLessThan(userIdx);
  });

  it('preserves fileData on the processed message (for knowledge-source tracking)', async () => {
    const fileData = {
      fileName: 'doc.pdf',
      fileType: 'application/pdf',
      displayType: 'PDF',
      content: 'Some content.'
    };
    const msg = createTestMessage({ fileData });

    const result = await processMessages([msg]);
    expect(result[0].fileData).toEqual(fileData);
  });

  it('does not duplicate file content when template has no {{content}} placeholder', async () => {
    const msg = {
      role: 'user',
      content: '',
      promptTemplate: 'Please process the document.',
      variables: { action: 'analyze' },
      fileData: {
        fileName: 'doc.txt',
        fileType: 'text/plain',
        displayType: 'TXT',
        content: 'Document text.'
      }
    };

    const result = await processMessages([msg]);
    const processed = result[0];
    const occurrences = (processed.content.match(/Document text\./g) || []).length;
    // File content should appear exactly once.
    expect(occurrences).toBe(1);
  });

  it('ignores array file entries without text content when building {{content}}', async () => {
    const msg = createTestMessage({
      fileData: [
        {
          fileName: 'scan.pdf',
          fileType: 'application/pdf',
          displayType: 'PDF',
          pageImages: ['imgdata'] // image-only, no .content
        },
        {
          fileName: 'notes.txt',
          fileType: 'text/plain',
          displayType: 'TXT',
          content: 'Notes text.'
        }
      ]
    });

    const result = await processMessages([msg]);
    const processed = result[0];

    expect(processed.content).toContain('Notes text.');
    expect(processed._fileContentInjectedViaTemplate).toBe(true);
  });
});

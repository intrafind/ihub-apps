/**
 * Regression tests for issue #1672 / #1673:
 * "Answer is based on AI knowledge even if content is uploaded."
 *
 * When a document is uploaded to an app whose prompt template contains a
 * {{content}} placeholder (e.g. Summarizer), the placeholder must be filled with
 * the uploaded file text — not left empty while the file floats disconnected
 * above the instruction. The file text must also not be duplicated once
 * PromptService has folded it into {{content}} and RequestBuilder runs after it.
 */
import { describe, it, expect, jest } from '@jest/globals';

// import.meta cannot be expressed by babel-jest's CJS transform — stub the
// modules that use it (or that drag in the config/auth stack) with equivalents.
jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => require('path').join(__dirname, '../../../')
}));
jest.mock('../../../server/configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getFeatures: () => ({}),
    getStyles: () => ({}),
    getSkillsForApp: async () => [],
    getApps: () => ({ data: [] }),
    getModels: () => ({ data: [] })
  }
}));
jest.mock('../../../server/config.js', () => ({
  __esModule: true,
  default: { CONTENTS_DIR: 'contents' }
}));
jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));
jest.mock('../../../server/featureRegistry.js', () => ({ isFeatureEnabled: () => false }));
jest.mock('../../../server/sources/index.js', () => ({ createSourceManager: jest.fn() }));
jest.mock('../../../server/services/SourceResolutionService.js', () => ({
  __esModule: true,
  default: class {}
}));
// RequestBuilder-only transitive imports (unused by preprocessMessagesWithFileData).
jest.mock('../../../server/adapters/index.js', () => ({ createCompletionRequest: jest.fn() }));
jest.mock('../../../server/toolLoader.js', () => ({ getToolsForApp: jest.fn(async () => []) }));
jest.mock('../../../server/utils/ErrorHandler.js', () => ({ __esModule: true, default: class {} }));
jest.mock('../../../server/utils/ApiKeyVerifier.js', () => ({
  __esModule: true,
  default: class {}
}));

import promptService from '../../../server/services/PromptService.js';
import { preprocessMessagesWithFileData } from '../../../server/services/chat/RequestBuilder.js';

const SUMMARIZER_TEMPLATE = {
  en: 'Please {{action}} the following content: "{{content}}"'
};

function summarizerMessage({ userText = '', fileData = null } = {}) {
  const msg = {
    role: 'user',
    content: userText,
    promptTemplate: SUMMARIZER_TEMPLATE,
    variables: { action: 'summarize' }
  };
  if (fileData) msg.fileData = fileData;
  return msg;
}

async function template(messages) {
  return promptService.processMessageTemplates(messages, null, null, null, 'en');
}

describe('PromptService — file text folded into {{content}}', () => {
  it('fills {{content}} with the uploaded file text (not an empty placeholder)', async () => {
    const [msg] = await template([
      summarizerMessage({
        fileData: {
          type: 'document',
          fileName: 'report.pdf',
          displayType: 'PDF',
          content: 'QUARTERLY REVENUE UP 12%.'
        }
      })
    ]);
    expect(msg.content).toContain('QUARTERLY REVENUE UP 12%.');
    expect(msg.content).toContain('Please summarize the following content:');
    // The placeholder must not be left empty.
    expect(msg.content).not.toMatch(/following content:\s*""\s*$/);
    expect(msg._fileTextInjectedViaTemplate).toBe(true);
    // fileData preserved so the answer-source badge still resolves to "file".
    expect(msg.fileData).toBeTruthy();
  });

  it('keeps typed text after the file text inside {{content}}', async () => {
    const [msg] = await template([
      summarizerMessage({
        userText: 'Focus on risks.',
        fileData: { type: 'document', fileName: 'a.txt', content: 'BODY TEXT.' }
      })
    ]);
    expect(msg.content.indexOf('BODY TEXT.')).toBeLessThan(msg.content.indexOf('Focus on risks.'));
  });

  it('combines multiple uploaded documents into {{content}}', async () => {
    const [msg] = await template([
      summarizerMessage({
        fileData: [
          { type: 'document', fileName: 'a.txt', content: 'CONTENT A.' },
          { type: 'document', fileName: 'b.txt', content: 'CONTENT B.' }
        ]
      })
    ]);
    expect(msg.content).toContain('CONTENT A.');
    expect(msg.content).toContain('CONTENT B.');
    expect(msg._fileTextInjectedViaTemplate).toBe(true);
  });

  it('does NOT set the marker for image-only files (pageImages, no .content)', async () => {
    const [msg] = await template([
      summarizerMessage({
        fileData: { type: 'document', fileName: 'scan.pdf', pageImages: ['b64img'] }
      })
    ]);
    expect(msg._fileTextInjectedViaTemplate).toBeUndefined();
  });

  it('does NOT set the marker when there is no fileData', async () => {
    const [msg] = await template([summarizerMessage({ userText: 'hello' })]);
    expect(msg._fileTextInjectedViaTemplate).toBeUndefined();
  });
});

describe('PromptService + preprocessMessagesWithFileData — no double injection', () => {
  it('includes the file text exactly once and strips the internal marker', async () => {
    const templated = await template([
      summarizerMessage({
        fileData: {
          type: 'document',
          fileName: 'r.pdf',
          displayType: 'PDF',
          content: 'UNIQUE_DOC_BODY_123'
        }
      })
    ]);
    const [msg] = preprocessMessagesWithFileData(templated);

    const occurrences = (msg.content.match(/UNIQUE_DOC_BODY_123/g) || []).length;
    expect(occurrences).toBe(1);
    // Marker never reaches the adapter.
    expect(msg._fileTextInjectedViaTemplate).toBeUndefined();
    // fileData is still present for downstream answer-source detection.
    expect(msg.fileData).toBeTruthy();
  });

  it('mixed text + image upload: text once in {{content}}, images attached as imageData', async () => {
    const templated = await template([
      summarizerMessage({
        fileData: [
          { type: 'document', fileName: 'notes.txt', content: 'TEXT_ONLY_ONCE' },
          { type: 'document', fileName: 'scan.pdf', pageImages: ['IMGDATA1', 'IMGDATA2'] }
        ]
      })
    ]);
    const [msg] = preprocessMessagesWithFileData(templated);

    const occurrences = (msg.content.match(/TEXT_ONLY_ONCE/g) || []).length;
    expect(occurrences).toBe(1); // not duplicated
    expect(Array.isArray(msg.imageData)).toBe(true);
    expect(msg.imageData).toHaveLength(2); // image pages preserved
  });

  it('a non-template message with a document still prepends the file text (unchanged path)', async () => {
    const templated = await template([
      {
        role: 'user',
        content: 'hi',
        fileData: { type: 'document', fileName: 'x.txt', content: 'PLAIN_DOC_BODY' }
      }
    ]);
    const [msg] = preprocessMessagesWithFileData(templated);
    expect(msg.content).toContain('PLAIN_DOC_BODY');
  });
});

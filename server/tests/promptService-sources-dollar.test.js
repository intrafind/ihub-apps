import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// {{sources}}/{{source}} substitution used to pass source content as the raw
// *replacement string* argument to String.replace, where `$&`, `$1`, `` $` ``,
// `$'` are magic. A source (a fetched page, an uploaded document, an iFinder
// hit) commonly contains such sequences incidentally, corrupting the prompt
// silently. This test drives the real source-loading pipeline with a fixture
// file containing those sequences, isolated from `server/defaults` via a
// private temp CONTENTS_DIR so it never touches shipped default content.
const tmpContentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-sources-dollar-'));
fs.mkdirSync(path.join(tmpContentsDir, 'sources'), { recursive: true });
const DOLLAR_SOURCE_CONTENT =
  "Budget line: $50 total. Formula reference: $& should stay literal, as should $1 and $` and $'.";
fs.writeFileSync(path.join(tmpContentsDir, 'sources', 'dollar.md'), DOLLAR_SOURCE_CONTENT, 'utf-8');
process.env.CONTENTS_DIR = tmpContentsDir;

const { default: PromptService } = await import('../services/PromptService.js');
const { default: configCache } = await import('../configCache.js');

const DOLLAR_SOURCE = {
  id: 'dollar',
  name: { en: 'Dollar fixture' },
  description: { en: 'Fixture source with $-patterns' },
  type: 'filesystem',
  enabled: true,
  exposeAs: 'prompt',
  config: { path: 'sources/dollar.md', encoding: 'utf-8' }
};

Object.assign(configCache, {
  getPlatform: () => ({ defaultLanguage: 'en' }),
  getSources: () => ({ data: [DOLLAR_SOURCE] })
});

describe('PromptService {{sources}} $-pattern handling', () => {
  it('keeps $-patterns in source content literal when substituted into {{sources}}', async () => {
    const messages = [{ role: 'user', content: 'What is the budget?' }];
    const app = {
      id: 'test-app-dollar-source',
      system: { en: 'Context: {{sources}}' },
      sources: ['dollar']
    };

    const result = await PromptService.processMessageTemplates(
      messages,
      app,
      null,
      null,
      'en',
      null,
      null,
      null,
      null
    );

    const systemContent = result[0].content;
    assert.ok(
      systemContent.includes(DOLLAR_SOURCE_CONTENT),
      `Source content with $-patterns should appear literally, unmodified. Got: ${systemContent}`
    );

    console.log('✓ {{sources}} $-pattern content stays literal');
  });
});

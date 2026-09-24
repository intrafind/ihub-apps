#!/usr/bin/env node

/**
 * Section retrieval for text sources exposed as tools.
 *
 * A source tool used to return the whole file. For the ~2 MB iHub
 * Documentation that result was replaced by a 16 KB preview in the agent
 * loop (anything above the 64 KB spill threshold is), so the iHub Support Bot
 * only ever saw the book's front matter. These specs pin the fix: small
 * content still comes back whole; large content comes back as the sections a
 * `query` matches, one `section` by id, or an outline — always within one
 * tool result's budget.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESULT_BUDGET_CHARS,
  selectContent,
  splitIntoParts,
  splitSections,
  tokenize
} from '../sources/documentRetrieval.js';
import SourceManager from '../sources/SourceManager.js';

/** The loop's default `policies.context.spillThresholdBytes`. */
const SPILL_THRESHOLD_BYTES = 64 * 1024;

const filler = (topic, n) =>
  Array.from(
    { length: n },
    (_, i) => `Paragraph ${i} about ${topic}. It explains ${topic} in some detail for readers.`
  ).join('\n\n');

/** A consolidated document like scripts/export-docs-markdown.js writes. */
function bigDocument() {
  const chapters = [];
  for (let i = 0; i < 40; i++) {
    chapters.push(
      `<!-- Source: chapter-${i}.md -->\n\n# Chapter ${i}\n\n${filler(`general topic ${i}`, 8)}\n\n` +
        `## Overview\n\n${filler(`overview ${i}`, 6)}`
    );
  }
  chapters.push(
    '<!-- Source: oidc.md -->\n\n# OIDC Authentication\n\nSingle sign-on with OpenID Connect.\n\n' +
      '## Provider Setup\n\n### Microsoft Azure AD\n\n' +
      'Register an app registration in Azure AD and set the `clientId` and `clientSecret` in ' +
      '`oidcAuth.providers`. Group claims map to iHub groups with `groupMapping`.\n\n' +
      '```bash\n# not a heading: a shell comment\nexport OIDC_CLIENT_ID=abc\n```\n'
  );
  chapters.push(
    '<!-- Source: releases/ -->\n\n# Release Notes\n\n## Version 5.5.11\n\n### Breaking Changes\n\n' +
      '#### Feedback moved\n\nAdmin feedback is a page of its own.\n\n' +
      '#### MCP clients need approval\n\nNew MCP clients wait for an administrator.\n\n' +
      '## Version 5.5.7\n\n### Features\n\n#### Reasoning levels\n\nReasoning effort is a level.\n'
  );
  chapters.push(`# Huge Reference\n\n${filler('reference tables', 900)}`);
  return chapters.join('\n\n');
}

describe('splitSections', () => {
  it('splits at headings, tracks the heading path and the consolidated file', () => {
    const sections = splitSections(bigDocument());
    const azure = sections.find(s => s.title === 'Microsoft Azure AD');
    assert.ok(azure);
    assert.equal(azure.level, 3);
    assert.deepEqual(azure.path, ['OIDC Authentication', 'Provider Setup']);
    assert.equal(azure.file, 'oidc.md');
    assert.match(azure.text, /clientSecret/);
  });

  it('does not treat `#` lines inside fenced code as headings', () => {
    const sections = splitSections(bigDocument());
    assert.equal(
      sections.some(s => s.title.includes('shell comment')),
      false
    );
    const azure = sections.find(s => s.title === 'Microsoft Azure AD');
    assert.match(azure.text, /# not a heading: a shell comment/);
  });

  it('gives repeated headings unique ids', () => {
    const ids = splitSections(bigDocument()).map(s => s.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes('overview'));
    assert.ok(ids.includes('overview-2'));
  });

  it('keeps angle brackets in titles and escapes them in the result', () => {
    const [section] = splitSections('#### Uploads reach the model as `<content>` blocks\n\ntext');
    assert.equal(section.title, 'Uploads reach the model as <content> blocks');
    const doc = `${bigDocument()}\n\n# Uploads as \`<content>\` blocks\n\nUploads arrive wrapped.`;
    const { content } = selectContent(doc, { section: 'uploads-as-content-blocks' });
    assert.match(content, /path="Uploads as &lt;content> blocks"/);
  });

  it('keeps level 5+ headings inside their section', () => {
    const sections = splitSections('# A\n\n##### Deep\n\ntext');
    assert.equal(sections.length, 1);
    assert.match(sections[0].text, /##### Deep/);
  });
});

describe('tokenize', () => {
  it('matches inflected forms and compound identifiers', () => {
    assert.deepEqual(tokenize('configure'), tokenize('configured'));
    assert.deepEqual(tokenize('configuration'), tokenize('configuring'));
    assert.ok(tokenize('set exposeAs').includes(tokenize('expose')[0]));
    assert.ok(tokenize('Version 5.5.11').includes('5.5.11'));
    assert.deepEqual(tokenize('How do I do it?'), []);
  });
});

describe('splitIntoParts', () => {
  it('splits long text at paragraphs and keeps every part within the limit', () => {
    const parts = splitIntoParts(filler('paging', 200), 2000);
    assert.ok(parts.length > 1);
    for (const part of parts) assert.ok(part.length <= 2000);
  });

  it('never splits inside a fenced code block that fits', () => {
    const code = '```js\n' + 'const a = 1;\n\n'.repeat(20) + '```';
    const parts = splitIntoParts(`${filler('intro', 30)}\n\n${code}`, 2000);
    assert.ok(parts.some(p => p.includes(code)));
  });
});

describe('selectContent', () => {
  const doc = bigDocument();

  it('returns small content whole, whatever is asked', () => {
    const small = '# FAQ\n\nShort answer.';
    for (const options of [{}, { query: 'answer' }, { section: 'faq' }]) {
      assert.deepEqual(selectContent(small, options), {
        content: small,
        retrieval: { mode: 'full' }
      });
    }
  });

  it('returns the sections that match a query for large content', () => {
    assert.ok(doc.length > RESULT_BUDGET_CHARS);
    const { content, retrieval } = selectContent(doc, {
      query: 'How do I configure Azure AD groups?',
      name: 'iHub Documentation'
    });
    assert.equal(retrieval.mode, 'search');
    assert.equal(retrieval.sections[0], 'microsoft-azure-ad');
    assert.match(content, /<section id="microsoft-azure-ad" path="OIDC Authentication › /);
    assert.match(content, /file="oidc\.md"/);
    assert.match(content, /groupMapping/);
    assert.match(content, /too large to return in full/);
    assert.ok(content.length <= RESULT_BUDGET_CHARS + 1000);
    assert.ok(retrieval.totalTokens > retrieval.returnedTokens);
  });

  it('brings the subsections of a heading-only hit along', () => {
    const { content, retrieval } = selectContent(doc, { query: 'breaking changes 5.5.11' });
    assert.equal(retrieval.sections[0], 'breaking-changes');
    assert.match(content, /Admin feedback is a page of its own/);
    assert.match(content, /New MCP clients wait for an administrator/);
  });

  it('reads one section with its subsections', () => {
    const { content, retrieval } = selectContent(doc, { section: 'version-5-5-11' });
    assert.equal(retrieval.mode, 'section');
    assert.deepEqual(retrieval.sections, [
      'version-5-5-11',
      'breaking-changes',
      'feedback-moved',
      'mcp-clients-need-approval'
    ]);
    assert.doesNotMatch(content, /Reasoning effort/);
  });

  it('finds a section by its title too', () => {
    const { retrieval } = selectContent(doc, { section: 'Microsoft Azure AD' });
    assert.deepEqual(retrieval.sections, ['microsoft-azure-ad']);
  });

  it('pages through a section too long for one result', () => {
    const first = selectContent(doc, { section: 'huge-reference' });
    assert.ok(first.content.length <= RESULT_BUDGET_CHARS + 1000);
    const next = /call this tool again with `section` set to "(huge-reference#\d+)"/.exec(
      first.content
    );
    assert.ok(next, 'names the part to continue with');
    const second = selectContent(doc, { section: next[1] });
    assert.equal(second.retrieval.sections[0], next[1]);
    assert.notEqual(second.content, first.content);
  });

  it('answers with an outline when nothing is asked, nothing matches, or the id is unknown', () => {
    for (const options of [{}, { query: 'xyzzy frobnicate' }, { section: 'no-such-section' }]) {
      const { content, retrieval } = selectContent(doc, options);
      assert.equal(retrieval.mode, 'outline');
      assert.match(content, /Outline:\n/);
      assert.match(content, /- oidc-authentication: OIDC Authentication/);
    }
  });

  it('keeps every result below the agent loop spill threshold', () => {
    const huge = `${doc}\n\n${Array.from({ length: 50 }, (_, i) => `# Zone ${i}\n\n${filler('zone', 120)}`).join('\n\n')}`;
    const cases = [{}, { query: 'zone paragraph readers detail' }, { section: 'zone-3' }];
    for (const options of cases) {
      const result = selectContent(huge, options);
      const bytes = Buffer.byteLength(JSON.stringify({ content: result.content, metadata: {} }));
      assert.ok(bytes < SPILL_THRESHOLD_BYTES, `${JSON.stringify(options)}: ${bytes} bytes`);
    }
  });
});

describe('SourceManager source tools', () => {
  let baseDir;
  let manager;
  const docSource = {
    id: 'big-docs',
    name: { en: 'Big Docs' },
    description: { en: 'Product documentation' },
    type: 'filesystem',
    exposeAs: 'tool',
    config: { path: 'sources/big.md', encoding: 'utf-8' }
  };

  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-source-tools-'));
    await fs.mkdir(path.join(baseDir, 'sources'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'sources/big.md'), bigDocument(), 'utf8');
    await fs.writeFile(path.join(baseDir, 'sources/other.md'), '# Other\n\nsecret', 'utf8');
    await fs.writeFile(path.join(baseDir, 'sources/small.md'), '# Small\n\nAll of it.', 'utf8');
    manager = new SourceManager({ filesystem: { basePath: baseDir } });
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('offers query and section, not a file path, and says how to use them', () => {
    const [tool] = manager.generateTools([docSource]);
    assert.equal(tool.name, 'source_big-docs');
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['query', 'section']);
    assert.match(tool.description, /^Product documentation /);
    assert.match(tool.description, /pass `query`/);
  });

  it('returns the matching sections without the server path', async () => {
    manager.generateTools([docSource]);
    const result = await manager.executeTool('source_big-docs', {
      query: 'Azure AD client secret',
      chatId: 'chat-1'
    });
    assert.match(result.content, /<section id="microsoft-azure-ad"/);
    assert.equal(result.metadata.retrieval.mode, 'search');
    assert.equal(result.metadata.fullPath, undefined);
    assert.equal(result.metadata.link, undefined);
    assert.equal(result.metadata.path, 'sources/big.md');
    assert.doesNotMatch(
      JSON.stringify(result),
      new RegExp(baseDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))
    );
  });

  it('reads the configured file even when the model names another one', async () => {
    manager.generateTools([docSource]);
    const result = await manager.executeTool('source_big-docs', {
      path: 'sources/other.md',
      section: 'microsoft-azure-ad'
    });
    assert.equal(result.metadata.path, 'sources/big.md');
    assert.match(result.content, /clientSecret/);
  });

  it('still returns a small source whole', async () => {
    const small = { ...docSource, id: 'small', config: { path: 'sources/small.md' } };
    manager.generateTools([small]);
    const result = await manager.executeTool('source_small', { query: 'anything' });
    assert.equal(result.content, '# Small\n\nAll of it.');
    assert.equal(result.metadata.retrieval.mode, 'full');
  });

  it('leaves iFinder tools as they were', () => {
    const [tool] = manager.generateTools([
      { id: 'kb', type: 'ifinder', exposeAs: 'tool', description: { en: 'KB' }, config: {} }
    ]);
    assert.equal(tool.description, 'KB');
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
      'documentId',
      'maxResults',
      'query'
    ]);
  });
});

describe('SourceManager.estimateSourceTokens', () => {
  let baseDir;
  let manager;

  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-source-tokens-'));
    await fs.mkdir(path.join(baseDir, 'sources'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'sources/doc.md'), 'x'.repeat(4000), 'utf8');
    manager = new SourceManager({ filesystem: { basePath: baseDir } });
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('measures filesystem sources', async () => {
    const estimate = await manager.estimateSourceTokens({
      id: 'doc',
      type: 'filesystem',
      config: { path: 'sources/doc.md' }
    });
    assert.equal(estimate.characters, 4000);
    assert.equal(estimate.bytes, 4000);
    assert.ok(estimate.tokens > 0);
  });

  it('does not fetch URL sources unless asked to', async () => {
    const estimate = await manager.estimateSourceTokens({
      id: 'web',
      type: 'url',
      config: { url: 'https://example.invalid' }
    });
    assert.deepEqual(estimate, { tokens: null, reason: 'remote' });
  });

  it('gives iFinder sources an upper bound', async () => {
    const search = await manager.estimateSourceTokens({
      id: 'kb',
      type: 'ifinder',
      config: { query: 'x', maxResults: 5, maxLength: 8000 }
    });
    assert.deepEqual(search, { tokens: null, reason: 'dynamic', maxTokens: 10000 });
    const pinned = await manager.estimateSourceTokens({
      id: 'kb',
      type: 'ifinder',
      config: { documentId: 'd1', maxLength: 8000 }
    });
    assert.equal(pinned.maxTokens, 2000);
  });

  it('reports the budget of one tool result', () => {
    assert.equal(manager.getToolResultBudgetTokens(), Math.round(RESULT_BUDGET_CHARS / 4));
  });
});

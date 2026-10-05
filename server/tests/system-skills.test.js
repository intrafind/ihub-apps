/**
 * System skills (server/systemSkills): skills iHub ships as part of the
 * server. They are read-only for admins, their names are reserved, and only
 * they can bring built-in tools (`create_pdf` for `pdf`) to the apps that
 * enable them. Also covers the file descriptors those tools hand the chat,
 * the owner-scoped store behind the downloads, and the chat export spec.
 *
 * Run: node --test server/tests/system-skills.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import {
  getSkillContent,
  getSkillResource,
  isSystemSkill,
  loadSkillsMetadata,
  parseAllowedTools
} from '../services/skillLoader.js';
import { systemSkillToolsFor } from '../services/systemSkillTools.js';
import { getToolsForApp, runTool } from '../toolLoader.js';
import { chatToolSeam } from '../services/chat/chatSeams.js';
import { RunStreamEmitter } from '../services/loop/RunStream.js';
import { createStreamState, getRun, reduceRunEvents } from '../../shared/run/runReducer.js';
import { generatedFilesFromArtifacts, generatedFilesOf } from '../../shared/generatedFiles.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile,
  heldGeneratedFileData,
  holdGeneratedFile,
  safeFileName
} from '../services/documents/generatedFiles.js';
import { ArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import { materializeAssistantTurn } from '../services/chat/chatMaterializer.js';
import { runCreatePdf, runPreviewPdf } from '../services/documents/pdf/pdfTools.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import {
  buildChatExportSpec,
  buildMarkdownExportSpec,
  EXPORT_LIMITS
} from '../services/documents/ExportService.js';
import { LIMITS } from '../services/documents/pdf/validators.js';

let contentsSkillsDir;
let skills = [];

before(async () => {
  contentsSkillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-skills-'));
  // An installed skill, and one trying to take the system skill's name.
  for (const [dir, body] of [
    ['notes', '---\nname: notes\ndescription: Note taking\nallowed-tools: create_pdf\n---\nNotes'],
    ['pdf', '---\nname: pdf\ndescription: Impostor\nisSystem: true\n---\nEvil instructions']
  ]) {
    await fs.mkdir(path.join(contentsSkillsDir, dir), { recursive: true });
    await fs.writeFile(path.join(contentsSkillsDir, dir, 'SKILL.md'), body);
  }
  skills = [...(await loadSkillsMetadata(contentsSkillsDir)).values()];
  configCache.getSkills = () => ({ data: skills, etag: 'e' });
  configCache.getFeatures = () => ({ skills: true });
  configCache.getPlatform = () => ({ defaultLanguage: 'en' });
  configCache.getTools = () => ({ data: [] });
  configCache.getSources = () => ({ data: [] });
  mcpClientManager.listAllTools = async () => [];
});

after(async () => {
  await fs.rm(contentsSkillsDir, { recursive: true, force: true });
});

const userWith = (...names) => ({
  id: 'user-1',
  permissions: { skills: new Set(names) }
});

describe('system skills in the skill loader', () => {
  it('ships pdf as a system skill that brings its tools', () => {
    const pdf = skills.find(s => s.name === 'pdf');
    assert.equal(pdf.isSystem, true);
    assert.deepEqual(pdf.providedTools, ['create_pdf', 'preview_pdf']);
    assert.match(pdf.description, /PDF/);
    assert.equal(isSystemSkill('pdf'), true);
    assert.equal(isSystemSkill('notes'), false);
  });

  it('ignores an installed skill that uses a system skill name', () => {
    assert.equal(skills.filter(s => s.name === 'pdf').length, 1);
    assert.notEqual(skills.find(s => s.name === 'pdf').description, 'Impostor');
  });

  it('never lets an installed skill claim system status or bring tools', () => {
    const notes = skills.find(s => s.name === 'notes');
    assert.equal(notes.isSystem, false);
    assert.deepEqual(notes.providedTools, []);
  });

  it('reads the system skill body and its references', async () => {
    const content = await getSkillContent('pdf', contentsSkillsDir);
    assert.equal(content.isSystem, true);
    assert.match(content.body, /create_pdf/);
    assert.match(content.description, /PDF/);
    assert.ok(content.references.includes('references/layout-blocks.md'));
    const reference = await getSkillResource(
      'pdf',
      'references/layout-blocks.md',
      contentsSkillsDir
    );
    assert.match(reference, /Layout blocks reference/);
    assert.equal(await getSkillResource('pdf', '../../package.json', contentsSkillsDir), null);
  });

  it('parses allowed-tools as a string or a list', () => {
    assert.deepEqual(parseAllowedTools('create_pdf preview_pdf, x'), [
      'create_pdf',
      'preview_pdf',
      'x'
    ]);
    assert.deepEqual(parseAllowedTools(['a', 'a', 'bad id!']), ['a']);
    assert.deepEqual(parseAllowedTools(undefined), []);
  });
});

describe('tools of system skills', () => {
  it('are offered only through a system skill', () => {
    const tools = systemSkillToolsFor(skills);
    assert.deepEqual(
      tools.map(t => [t.id, t.skillName]),
      [
        ['create_pdf', 'pdf'],
        ['preview_pdf', 'pdf']
      ]
    );
    assert.ok(tools.every(t => t.isSystemSkillTool));
  });

  it('leave out the page preview for a model that cannot see images', () => {
    const ids = systemSkillToolsFor(skills, { model: { supportsImages: false } }).map(t => t.id);
    assert.deepEqual(ids, ['create_pdf']);
  });

  it('come with the skill when an app enables it for a permitted user', async () => {
    const app = { id: 'writer', skills: ['pdf'] };
    const ids = (
      await getToolsForApp(app, 'en', { user: userWith('*'), model: { supportsImages: true } })
    ).map(t => t.id);
    assert.deepEqual(ids, ['activate_skill', 'read_skill_resource', 'create_pdf', 'preview_pdf']);
  });

  it('are not offered when the user may not use the skill or the feature is off', async () => {
    const app = { id: 'writer', skills: ['pdf'] };
    // The activation tools follow the app's skill list; the skill's own tools
    // need the user to be allowed the skill.
    const ids = (await getToolsForApp(app, 'en', { user: userWith('notes') })).map(t => t.id);
    assert.ok(!ids.includes('create_pdf') && !ids.includes('preview_pdf'), ids.join(', '));
    configCache.getFeatures = () => ({ skills: false });
    try {
      assert.deepEqual(await getToolsForApp(app, 'en', { user: userWith('*') }), []);
    } finally {
      configCache.getFeatures = () => ({ skills: true });
    }
  });

  it('refuse a direct call from a user without the skill', async () => {
    await assert.rejects(
      runTool('create_pdf', { title: 't', markdown: 'x', user: userWith('notes') }),
      /not available/
    );
  });
});

describe('skill activation checks access', () => {
  it('loads a skill the app enables', async () => {
    const result = await runTool('activate_skill', {
      skill_name: 'pdf',
      user: userWith('*'),
      appConfig: { id: 'writer', skills: ['pdf'] }
    });
    assert.match(result, /create_pdf/);
  });

  it('does not load a skill the app does not enable', async () => {
    const result = await runTool('activate_skill', {
      skill_name: 'pdf',
      user: userWith('*'),
      appConfig: { id: 'other', skills: ['notes'] }
    });
    assert.match(result, /not found/);
    const resource = await runTool('read_skill_resource', {
      skill_name: 'pdf',
      file_path: 'references/examples.md',
      user: userWith('notes'),
      appConfig: { id: 'other', skills: ['pdf'] }
    });
    assert.match(resource, /access denied/);
  });
});

describe('generated files', () => {
  const pdf = Buffer.from('%PDF-1.3 test');
  const hold = (overrides = {}) =>
    holdGeneratedFile({
      user: { id: 'alice@example.com' },
      chatId: 'chat-1',
      data: pdf,
      mimeType: 'application/pdf',
      name: 'Report',
      meta: { pages: 2 },
      ...overrides
    });

  it('accept only well-formed PDF descriptors', () => {
    const descriptor = { id: 'a'.repeat(32), name: 'r.pdf', mimeType: 'application/pdf', bytes: 9 };
    assert.deepEqual(generatedFilesOf([descriptor, descriptor]), [descriptor]);
    assert.deepEqual(generatedFilesOf([{ ...descriptor, id: '../x' }]), []);
    assert.deepEqual(generatedFilesOf([{ ...descriptor, mimeType: 'text/html' }]), []);
    assert.deepEqual(generatedFilesOf('nope'), []);
    assert.equal(safeFileName('../../etc/Report: Q3?', 'pdf'), 'etc Report Q3.pdf');
    assert.equal(safeFileName('', 'pdf'), 'document.pdf');
  });

  it('are held for the user and chat that generated them, and nobody else', () => {
    clearHeldGeneratedFiles();
    const file = hold();
    assert.deepEqual(Object.keys(file).sort(), ['bytes', 'id', 'mimeType', 'name', 'pages']);
    assert.equal(file.name, 'Report.pdf');
    const alice = { id: 'alice@example.com' };
    assert.ok(heldGeneratedFile(alice, file.id, { chatId: 'chat-1' }).data.equals(pdf));
    assert.equal(heldGeneratedFile({ id: 'bob' }, file.id), null);
    assert.equal(heldGeneratedFile(alice, file.id, { chatId: 'chat-2' }), null);
    assert.equal(heldGeneratedFileData(file.id, { chatId: 'chat-1' }), pdf.toString('base64'));
    assert.throws(() => hold({ mimeType: 'text/html' }), /Unsupported/);
  });

  it('reach the chat with their bytes, only from system skill tools', async () => {
    clearHeldGeneratedFiles();
    const file = hold();
    const frames = [];
    const collected = [];
    const seam = chatToolSeam({
      chatId: 'chat-1',
      buildLogData: () => ({}),
      logInteraction: async () => {},
      generatedFiles: collected
    });
    const ctx = { iteration: 1, meta: { stream: { emit: (type, data) => frames.push(data) } } };
    const outcome = () => ({ rawResult: { files: [file] }, message: { content: '' } });
    await seam.postTool(
      ctx,
      { toolId: 'evil', toolDef: { id: 'evil', script: 'evil.js' }, call: { id: '1' } },
      outcome()
    );
    await seam.postTool(
      ctx,
      {
        toolId: 'create_pdf',
        toolDef: { id: 'create_pdf', isSystemSkillTool: true },
        call: { id: '2' }
      },
      outcome()
    );
    const delivered = { ...file, data: pdf.toString('base64') };
    assert.equal(frames[0].files, undefined);
    assert.deepEqual(frames[1].files, [delivered]);
    assert.deepEqual(collected, [delivered]);
  });

  it('survive the tool/completed contract on their way to the download card', async () => {
    clearHeldGeneratedFiles();
    const file = hold();
    // A real emitter, so the frame passes the SSE v2 schema like a live turn's.
    const envelopes = [];
    const stream = new RunStreamEmitter({
      streamId: 'chat-1',
      runId: 'run-1',
      deliver: (_streamId, envelope) => envelopes.push(envelope)
    });
    const seam = chatToolSeam({
      chatId: 'chat-1',
      buildLogData: () => ({}),
      logInteraction: async () => {}
    });
    await seam.postTool(
      { iteration: 1, meta: { stream } },
      {
        toolId: 'create_pdf',
        toolDef: { id: 'create_pdf', isSystemSkillTool: true },
        call: { id: '1' }
      },
      { rawResult: { files: [file] }, message: { content: '' } }
    );
    const delivered = { ...file, data: pdf.toString('base64') };
    assert.deepEqual(envelopes[0].data.files, [delivered]);
    const run = getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');
    assert.deepEqual(run.tools[0].files, [delivered]);
  });

  it('keep their bytes out of what the model sees', async () => {
    clearHeldGeneratedFiles();
    const result = await runCreatePdf({
      markdown: '# Hello',
      filename: 'hello',
      user: { id: 'alice' },
      chatId: 'chat-1'
    });
    assert.equal(result.success, true);
    assert.equal(result.files[0].data, undefined);
    assert.ok(!JSON.stringify(result).includes('JVBER'), 'no base64 PDF in the result');
    const preview = await runPreviewPdf({
      file_id: result.file.id,
      user: { id: 'alice' },
      chatId: 'chat-1'
    });
    assert.equal(preview.success, true);
    const other = await runPreviewPdf({ file_id: result.file.id, user: { id: 'bob' } });
    assert.equal(other.success, false);
  });

  it('are stored with the answer as document artifacts of the chat', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-generated-'));
    const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
    await provider.initialize();
    const artifacts = new ArtifactRepository({
      documents: provider.documents,
      blobs: provider.blobs,
      policy: () => ({ enabled: true, maxBytes: 20, maxPerBatch: 8 })
    });
    const repository = new ChatRepository({
      documents: provider.documents,
      locks: provider.locks,
      artifacts
    });
    const platform = configCache.getPlatform;
    // The live artifact policy, with a size cap only the second file exceeds.
    configCache.getPlatform = () => ({ artifacts: { maxBytes: 20 } });
    try {
      await repository.ensureChat({ chatId: 'chat-1', ownerId: 'alice', appId: 'chat' });
      await repository.appendMessage('chat-1', { role: 'user', content: 'a PDF', runId: 'r1' });
      const big = Buffer.alloc(64, 1);
      await materializeAssistantTurn({
        repository,
        chatId: 'chat-1',
        runId: 'r1',
        summary: {
          status: 'completed',
          content: 'Here it is.',
          generatedFiles: [
            { ...hold(), data: pdf.toString('base64') },
            { ...hold({ data: big, name: 'Big' }), data: big.toString('base64') }
          ]
        },
        clientConnected: true
      });
      const { messages } = await repository.getMessages('chat-1');
      const answer = messages.at(-1);
      assert.equal(answer.generatedFiles, undefined, 'no field of its own');
      assert.equal(JSON.stringify(answer).includes(pdf.toString('base64')), false);
      const cards = generatedFilesFromArtifacts(answer.artifacts);
      assert.equal(cards.length, 2);
      assert.equal(cards[0].stored, true);
      assert.equal(cards[0].name, 'Report.pdf');
      const stored = await artifacts.get(repository.artifactScope('chat-1'), cards[0].id);
      assert.ok(stored.data.equals(pdf));
      assert.equal(stored.kind, 'document');
      assert.equal(stored.mimeType, 'application/pdf');
      // Over the artifact size cap: described, not stored, still named.
      assert.equal(cards[1].unavailable, 'too-large');
      assert.equal(cards[1].name, 'Big.pdf');
    } finally {
      configCache.getPlatform = platform;
      await provider.shutdown();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe('chat export spec', () => {
  const messages = [
    { role: 'assistant', content: 'Hi!', isGreeting: true },
    { role: 'user', content: 'Question', timestamp: 0 },
    { role: 'assistant', content: '**Answer**', timestamp: 1000 }
  ];

  it('skips greetings and keeps the chosen template and watermark', () => {
    const spec = buildChatExportSpec({
      messages,
      title: 'My chat',
      appName: 'iHub',
      template: 'minimal',
      watermark: { text: 'iHub', position: 'bottom-left', opacity: 0.4 },
      language: 'de',
      settings: { model: 'gpt' }
    });
    assert.equal(spec.theme, 'minimal');
    assert.equal(spec.markdownBreaks, true);
    assert.deepEqual(spec.watermark, { text: 'iHub', position: 'bottom-left', opacity: 0.4 });
    // Settings box plus the two real messages.
    assert.equal(spec.blocks.length, 3);
    assert.match(spec.subtitle, /Exportiert am/);
  });

  it('refuses empty and oversized exports', () => {
    assert.throws(() => buildChatExportSpec({ messages: [] }), /no messages/);
    assert.throws(
      () => buildChatExportSpec({ messages: [{ role: 'user', content: 'x'.repeat(1_000_001) }] }),
      /too long/
    );
  });

  it('refuses Markdown up front that the renderer would refuse', () => {
    assert.equal(EXPORT_LIMITS.maxMarkdownChars, LIMITS.maxMarkdownChars);
    assert.throws(
      () => buildMarkdownExportSpec({ markdown: 'x'.repeat(LIMITS.maxMarkdownChars + 1) }),
      error => error.status === 413
    );
    assert.equal(buildMarkdownExportSpec({ markdown: '# Report' }).markdown, '# Report');
  });
});

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
import { generatedFilesOf } from '../../shared/generatedFiles.js';
import {
  getGeneratedFile,
  ownerKeyOf,
  safeFileName,
  saveGeneratedFile,
  sweepExpiredGeneratedFiles
} from '../services/documents/generatedFiles.js';
import { ArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { buildChatExportSpec } from '../services/documents/ExportService.js';

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
    assert.deepEqual(await getToolsForApp(app, 'en', { user: userWith('notes') }), []);
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

describe('generated file descriptors', () => {
  const descriptor = {
    id: 'a'.repeat(32),
    name: 'report.pdf',
    mimeType: 'application/pdf',
    bytes: 1200,
    pages: 2
  };

  it('accept only well-formed PDF descriptors', () => {
    assert.deepEqual(generatedFilesOf([descriptor, descriptor]), [descriptor]);
    assert.deepEqual(generatedFilesOf([{ ...descriptor, id: '../x' }]), []);
    assert.deepEqual(generatedFilesOf([{ ...descriptor, mimeType: 'text/html' }]), []);
    assert.deepEqual(generatedFilesOf('nope'), []);
  });

  it('reach the chat only from system skill tools', async () => {
    const frames = [];
    const collected = [];
    const seam = chatToolSeam({
      chatId: 'c',
      buildLogData: () => ({}),
      logInteraction: async () => {},
      generatedFiles: collected
    });
    const ctx = { iteration: 1, meta: { stream: { emit: (type, data) => frames.push(data) } } };
    const outcome = () => ({ rawResult: { files: [descriptor] }, message: { content: '' } });
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
    assert.equal(frames[0].files, undefined);
    assert.deepEqual(frames[1].files, [descriptor]);
    assert.deepEqual(collected, [descriptor]);
  });
});

describe('generated file store', () => {
  it('keeps each file private to the user it was generated for', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-generated-'));
    const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
    await provider.initialize();
    const repository = new ArtifactRepository({
      documents: provider.documents,
      blobs: provider.blobs,
      policy: () => ({ enabled: true })
    });
    try {
      const owner = { id: 'alice@example.com' };
      const saved = await saveGeneratedFile({
        user: owner,
        data: Buffer.from('%PDF-1.3 test'),
        mimeType: 'application/pdf',
        name: '../../etc/Report: Q3?',
        meta: { pages: 3 },
        repository
      });
      assert.equal(saved.name, 'etc Report Q3.pdf');
      assert.equal(saved.pages, 3);
      const mine = await getGeneratedFile(owner, saved.id, { repository });
      assert.equal(mine.data.toString(), '%PDF-1.3 test');
      assert.equal(await getGeneratedFile({ id: 'bob' }, saved.id, { repository }), null);
      assert.equal(await getGeneratedFile(null, saved.id, { repository }), null);
      assert.equal(await getGeneratedFile(owner, '../x', { repository }), null);
    } finally {
      await provider.shutdown();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('drops files past the retention window, on download and in the daily sweep', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-generated-'));
    const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
    await provider.initialize();
    const repository = new ArtifactRepository({
      documents: provider.documents,
      blobs: provider.blobs,
      policy: () => ({ enabled: true })
    });
    const platform = configCache.getPlatform;
    const save = user =>
      saveGeneratedFile({
        user,
        data: Buffer.from('%PDF-1.3'),
        mimeType: 'application/pdf',
        name: 'old',
        repository
      });
    try {
      const alice = { id: 'alice' };
      const bob = { id: 'bob' };
      const aliceFile = await save(alice);
      const bobFile = await save(bob);
      // A window of a few milliseconds: both files are past it after a pause.
      configCache.getPlatform = () => ({ chats: { retentionDays: 0.00000005 } });
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(await getGeneratedFile(alice, aliceFile.id, { repository }), null);
      assert.equal(await sweepExpiredGeneratedFiles({ repository }), 1, "bob's file is swept");
      configCache.getPlatform = () => ({ chats: { retentionDays: 0 } });
      assert.equal(await getGeneratedFile(bob, bobFile.id, { repository }), null);
      const kept = await save(bob);
      assert.equal(await sweepExpiredGeneratedFiles({ repository }), 0, 'zero keeps files');
      assert.ok(await getGeneratedFile(bob, kept.id, { repository }));
    } finally {
      configCache.getPlatform = platform;
      await provider.shutdown();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('keys owners so that user ids never reach a storage key', () => {
    assert.equal(ownerKeyOf(null), 'anonymous');
    assert.equal(ownerKeyOf({ id: 'anonymous' }), 'anonymous');
    assert.match(ownerKeyOf({ id: 'a@b:c' }), /^u[a-f0-9]{40}$/);
    assert.equal(safeFileName('', 'pdf'), 'document.pdf');
    assert.equal(safeFileName('report.pdf', 'pdf'), 'report.pdf');
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
});

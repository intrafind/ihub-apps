// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Slice 4 (#3160) foundation: what every integration builds on — the `user`
 * scope, `meta` / `source` on stored files, the e-mail / meeting / page origins,
 * dedupe per chat by item id or URL, and replacing a file in place (connector
 * refresh) without its bytes counting twice.
 *
 * Run: node --test server/tests/chat-files-foundation.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FilesystemStorageProvider } from '../storage/index.js';
import {
  CHAT_FILE_ORIGINS,
  ChatFileQuotaError,
  ChatFileRepository,
  normalizeFileScope,
  sanitizeFileMeta,
  sanitizeFileSource,
  userFileScope
} from '../services/chatFiles/ChatFileRepository.js';
import {
  ingestChatFile,
  prepareTurnFiles,
  toPromptFileData
} from '../services/chatFiles/ChatFileService.js';

describe('chat file foundation', () => {
  let tmpDir;
  let provider;
  let repo;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-files-foundation-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('user scope', () => {
    it('hashes the owner id into a storable scope that never contains the id', () => {
      const scope = userFileScope('user@example.com/with weird chars');
      assert.equal(scope.type, 'user');
      assert.match(scope.id, /^u[0-9a-f]{32}$/);
      assert.ok(!scope.id.includes('example'));
      assert.deepEqual(userFileScope('user@example.com/with weird chars'), scope);
      assert.notDeepEqual(userFileScope('someone-else'), scope);
      assert.deepEqual(normalizeFileScope(scope), scope);
      assert.equal(normalizeFileScope({ type: 'team', id: 'x' }), null);
    });

    it('stores, lists and deletes files of a user without touching a chat of the same id', async () => {
      const scope = userFileScope('ada');
      const chat = { type: 'chat', id: scope.id };
      const mine = await ingestChatFile({
        scope,
        ownerId: 'ada',
        name: 'brief.md',
        mimeType: 'text/markdown',
        text: 'Hello from the API',
        origin: 'api',
        store: repo
      });
      assert.equal(mine.origin, 'api');
      assert.equal((await repo.list(scope)).length, 1);
      assert.equal((await repo.list(chat)).length, 0);
      assert.equal(await repo.getText(chat, mine.id), null);
      assert.equal((await repo.getText(scope, mine.id)).text, 'Hello from the API');
      assert.equal(await repo.delete(scope, mine.id), true);
      assert.equal((await repo.list(scope)).length, 0);
    });

    it('lets the TTL sweep and quota eviction discard originals of user files, never task files', async () => {
      const policy = { evictOldestOriginalsOnQuota: true };
      const user = userFileScope('ada');
      const task = { type: 'task', id: 'task_1' };
      const old = '2026-01-01T00:00:00.000Z';
      for (const scope of [user, task]) {
        await repo.put(scope, {
          ownerId: 'ada',
          name: `${scope.type}.bin`,
          mimeType: 'application/pdf',
          text: 'text',
          originalBuffer: Buffer.from('ORIGINAL'),
          createdAt: old,
          policy
        });
      }
      const swept = await repo.discardExpiredOriginals({
        originalRetentionDays: 14,
        now: () => Date.parse('2026-11-03T00:00:00Z')
      });
      assert.equal(swept.discarded, 1);
      const [u] = await repo.list(user);
      const [t] = await repo.list(task);
      assert.equal(u.hasOriginal, false);
      assert.equal(t.hasOriginal, true);
    });
  });

  describe('meta, source and origin', () => {
    it('keeps meta and source on the descriptor and only known origins', async () => {
      const file = await repo.put(
        { type: 'chat', id: 'chat-meta' },
        {
          ownerId: 'ada',
          name: 'Offer.eml',
          mimeType: 'message/rfc822',
          text: 'Subject: Offer\n\nHi',
          origin: 'email',
          meta: { itemId: 'AAMk123', mailboxUser: 'ada@example.com', isCurrent: true },
          source: { kind: 'nextcloud', ref: { path: '/a.docx' }, refreshOnRun: true }
        }
      );
      assert.equal(file.origin, 'email');
      assert.deepEqual(file.meta, {
        itemId: 'AAMk123',
        mailboxUser: 'ada@example.com',
        isCurrent: true
      });
      assert.deepEqual(file.source, {
        kind: 'nextcloud',
        ref: { path: '/a.docx' },
        refreshOnRun: true
      });
      const listed = (await repo.list({ type: 'chat', id: 'chat-meta' }))[0];
      assert.deepEqual(listed.meta, file.meta);

      const odd = await repo.put(
        { type: 'chat', id: 'chat-meta' },
        { ownerId: 'ada', name: 'x.txt', mimeType: 'text/plain', text: 'x', origin: 'nonsense' }
      );
      assert.equal(odd.origin, 'upload');
      assert.ok(CHAT_FILE_ORIGINS.includes('connector'));
    });

    it('drops meta that is not plain JSON or too large instead of failing the upload', () => {
      assert.equal(sanitizeFileMeta(null), null);
      assert.equal(sanitizeFileMeta([1, 2]), null);
      assert.equal(sanitizeFileMeta({ big: 'x'.repeat(10_000) }), null);
      const circular = {};
      circular.self = circular;
      assert.equal(sanitizeFileMeta(circular), null);
      assert.deepEqual(sanitizeFileMeta({ a: 1, f: () => 1, u: undefined }), { a: 1 });
      assert.equal(sanitizeFileSource({ kind: 'x' }), null);
      assert.deepEqual(sanitizeFileSource({ kind: 'google-drive', ref: { fileId: '1' } }), {
        kind: 'google-drive',
        ref: { fileId: '1' }
      });
    });

    it('finds a file by the item it was made from', async () => {
      const scope = { type: 'chat', id: 'chat-find' };
      await repo.put(scope, {
        ownerId: 'ada',
        name: 'A.eml',
        mimeType: 'message/rfc822',
        text: 'a',
        origin: 'email',
        meta: { itemId: 'id-a' }
      });
      await repo.put(scope, {
        ownerId: 'ada',
        name: 'Docs.md',
        mimeType: 'text/markdown',
        text: 'b',
        origin: 'page',
        meta: { url: 'https://example.com/docs' }
      });
      assert.equal((await repo.findByMeta(scope, 'itemId', 'id-a')).name, 'A.eml');
      assert.equal(
        (await repo.findByMeta(scope, 'url', 'https://example.com/docs')).name,
        'Docs.md'
      );
      assert.equal(await repo.findByMeta(scope, 'itemId', 'missing'), null);
      assert.equal(await repo.findByMeta(scope, 'itemId', ''), null);
      assert.equal(await repo.findByMeta({ type: 'chat', id: 'other' }, 'itemId', 'id-a'), null);
    });
  });

  describe('replacing a file in place', () => {
    it('overwrites by id, drops the old original and does not count the old bytes twice', async () => {
      const scope = { type: 'task', id: 'task_replace' };
      const policy = { quotas: { maxChatFiles: 1, maxChatBytes: 300 } };
      const first = await repo.put(scope, {
        ownerId: 'ada',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        text: 't1',
        originalBuffer: Buffer.alloc(200, 1),
        policy
      });
      // A second file would break the count; replacing the first must not.
      await assert.rejects(
        repo.put(scope, {
          ownerId: 'ada',
          name: 'other.txt',
          mimeType: 'text/plain',
          text: 'x',
          policy
        }),
        ChatFileQuotaError
      );
      const second = await repo.put(scope, {
        id: first.id,
        ownerId: 'ada',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        text: 'newer text',
        originalBuffer: Buffer.alloc(250, 2),
        policy
      });
      assert.equal(second.id, first.id);
      assert.equal((await repo.list(scope)).length, 1);
      assert.equal((await repo.getText(scope, first.id)).text, 'newer text');
      assert.equal((await repo.getOriginal(scope, first.id)).data.length, 250);

      // Replaced by a text-only copy: no original is left behind.
      await repo.put(scope, {
        id: first.id,
        ownerId: 'ada',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        text: 'text only now',
        storageMode: 'server_text_only',
        policy
      });
      const gone = await repo.getOriginal(scope, first.id);
      assert.equal(gone.discarded, true);
      assert.equal((await repo.list(scope))[0].hasOriginal, false);
    });

    it('refuses a replacement that does not fit and keeps the old copy', async () => {
      const scope = { type: 'task', id: 'task_keep' };
      const policy = { quotas: { maxChatBytes: 300 } };
      const first = await repo.put(scope, {
        ownerId: 'ada',
        name: 'a.pdf',
        mimeType: 'application/pdf',
        text: 'keep me',
        originalBuffer: Buffer.alloc(100),
        policy
      });
      await assert.rejects(
        repo.put(scope, {
          id: first.id,
          ownerId: 'ada',
          name: 'a.pdf',
          mimeType: 'application/pdf',
          text: 'too big',
          originalBuffer: Buffer.alloc(900),
          policy
        }),
        ChatFileQuotaError
      );
      assert.equal((await repo.getText(scope, first.id)).text, 'keep me');
    });
  });

  describe('inline items of a turn (e-mail, meeting, page)', () => {
    const scope = { type: 'chat', id: 'chat-turn' };
    const email = (overrides = {}) => ({
      fileName: 'Offer.eml',
      fileType: 'message/rfc822',
      type: 'document',
      origin: 'email',
      content: 'Subject: Offer\nFrom: ada@example.com\n\nPlease find the offer.',
      meta: { itemId: 'AAMk1', mailboxUser: 'ada@example.com', isCurrent: true },
      ...overrides
    });

    it('stores an e-mail once per chat however many turns send it', async () => {
      const first = await prepareTurnFiles({
        chatId: scope.id,
        ownerId: 'ada',
        message: { role: 'user', content: 'summarize', fileData: email() },
        store: repo
      });
      const second = await prepareTurnFiles({
        chatId: scope.id,
        ownerId: 'ada',
        message: { role: 'user', content: 'and now?', fileData: email() },
        store: repo
      });
      const stored = await repo.list(scope);
      assert.equal(stored.length, 1);
      assert.equal(stored[0].origin, 'email');
      assert.equal(first.attachments[0].id, second.attachments[0].id);
      assert.equal(first.attachments[0].origin, 'email');
      // The prompt keeps the structure the renderer needs.
      const sent = second.promptMessage.fileData;
      assert.equal(sent.origin, 'email');
      assert.equal(sent.meta.mailboxUser, 'ada@example.com');
    });

    it('replaces the stored copy when the same item arrives changed', async () => {
      await prepareTurnFiles({
        chatId: scope.id,
        ownerId: 'ada',
        message: { role: 'user', content: 'a', fileData: email() },
        store: repo
      });
      const changed = await prepareTurnFiles({
        chatId: scope.id,
        ownerId: 'ada',
        message: {
          role: 'user',
          content: 'b',
          fileData: email({ content: 'Subject: Offer\n\nRevised offer.' })
        },
        store: repo
      });
      const stored = await repo.list(scope);
      assert.equal(stored.length, 1);
      assert.equal(
        (await repo.getText(scope, stored[0].id)).text,
        'Subject: Offer\n\nRevised offer.'
      );
      assert.equal(changed.attachments[0].id, stored[0].id);
    });

    it('keeps different items apart and dedupes pages by URL', async () => {
      const page = (url, content) => ({
        type: 'document',
        origin: 'page',
        fileName: 'Docs.md',
        fileType: 'text/markdown',
        content,
        meta: { url }
      });
      await prepareTurnFiles({
        chatId: scope.id,
        ownerId: 'ada',
        message: {
          role: 'user',
          content: 'x',
          fileData: [
            email(),
            email({ meta: { itemId: 'AAMk2' }, fileName: 'Other.eml' }),
            page('https://a.example/1', 'one')
          ]
        },
        store: repo
      });
      await prepareTurnFiles({
        chatId: scope.id,
        ownerId: 'ada',
        message: { role: 'user', content: 'y', fileData: page('https://a.example/1', 'one') },
        store: repo
      });
      assert.equal((await repo.list(scope)).length, 3);
    });

    it('keeps the raw bytes of an Outlook attachment so it can serve as a template', async () => {
      const bytes = Buffer.from('PK-fake-docx-bytes');
      const { attachments } = await prepareTurnFiles({
        chatId: 'chat-attachment',
        ownerId: 'ada',
        message: {
          role: 'user',
          content: 'use this',
          fileData: {
            type: 'document',
            origin: 'attachment',
            fileName: 'letter.docx',
            fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            content: 'Dear customer',
            base64: bytes.toString('base64')
          }
        },
        store: repo
      });
      assert.equal(attachments[0].hasOriginal, true);
      assert.equal(attachments[0].canUseAsTemplate, true);
      assert.equal(attachments[0].origin, 'attachment');
      const original = await repo.getOriginal(
        { type: 'chat', id: 'chat-attachment' },
        attachments[0].id
      );
      assert.ok(original.data.equals(bytes));
    });

    it('hands the origin and meta of stored files to the prompt', async () => {
      const stored = await repo.put(scope, {
        ownerId: 'ada',
        name: 'Standup.ics',
        mimeType: 'text/calendar',
        text: 'SUMMARY:Standup',
        origin: 'meeting',
        meta: { itemId: 'evt1' }
      });
      const data = toPromptFileData(await repo.getText(scope, stored.id));
      assert.equal(data.origin, 'meeting');
      assert.deepEqual(data.meta, { itemId: 'evt1' });
    });
  });

  describe('server-wide quota', () => {
    const policy = maxServerBytes => ({ quotas: { maxServerBytes } });
    const put = (n, extra = {}) =>
      repo.put(
        { type: 'chat', id: `chat-srv-${n}` },
        {
          ownerId: `u${n}`,
          name: `f${n}.txt`,
          mimeType: 'text/plain',
          text: 'x'.repeat(100),
          ...extra
        }
      );

    it('does not read every file document on each upload while far from the limit', async () => {
      let scans = 0;
      const scan = repo._listAllDocs.bind(repo);
      repo._listAllDocs = async () => {
        scans += 1;
        return scan();
      };
      const limit = policy(1_000_000);
      for (let i = 0; i < 6; i += 1) await put(i, { policy: limit });
      assert.equal(scans, 1, 'one read fills the cache, the next uploads add to it');
    });

    it('checks the exact total near the limit, so a stale cache never refuses a fitting upload', async () => {
      const limit = policy(1000);
      const first = await put(1, { policy: limit, text: 'a'.repeat(600) });
      // Another instance frees the space behind this one's cache.
      const other = new ChatFileRepository({
        documents: provider.documents,
        blobs: provider.blobs
      });
      await other.delete({ type: 'chat', id: 'chat-srv-1' }, first.id);
      const stored = await put(2, { policy: limit, text: 'b'.repeat(600) });
      assert.ok(stored.id);
      // And a full server is still reported as full.
      await assert.rejects(put(3, { policy: limit, text: 'c'.repeat(600) }), error => {
        assert.equal(error.code, 'QUOTA_SERVER_BYTES');
        assert.equal(error.status, 507);
        return true;
      });
    });

    it('forgets the cached total when a file is deleted', async () => {
      const limit = policy(1000);
      const first = await put(1, { policy: limit, text: 'a'.repeat(800) });
      await assert.rejects(put(2, { policy: limit, text: 'b'.repeat(800) }), {
        code: 'QUOTA_SERVER_BYTES'
      });
      await repo.delete({ type: 'chat', id: 'chat-srv-1' }, first.id);
      const stored = await put(2, { policy: limit, text: 'b'.repeat(800) });
      assert.ok(stored.id);
    });
  });
});

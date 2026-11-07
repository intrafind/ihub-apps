// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files in the inference API (concepts/chat-files, section 8.3): `/api/inference/v1/files`,
 * `file_id` references, inline files read by the shared chat-file pipeline (Excel, scanned
 * PDFs), `file` parts on plain-model chat completions, and files of persisted conversation
 * turns living in the chat's file store — shared with the Web UI.
 *
 * Everything below the HTTP layer is real (routes, chat pipeline, storage over a temp dir,
 * the chat-file repository) except the provider, which is a scripted transport that records
 * what it was sent.
 *
 * Run: node --test server/tests/inference-files.test.js
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import configCache from '../configCache.js';
import registerOpenAIProxyRoutes from '../routes/openaiProxy.js';
import ChatService from '../services/chat/ChatService.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import { AgentLoop } from '../services/loop/AgentLoop.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getChatFileRepository, userFileScope } from '../services/chatFiles/ChatFileRepository.js';
import { makeClient, sseResponse, openaiText, captureRunLog } from './loop/helpers/llmFixtures.js';
import { buildPdfBytes } from './helpers/structuredPdf.js';
import { buildDocx, p } from './helpers/docxFile.js';

const MODELS = [
  {
    id: 'oa',
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    default: true
  }
];
const APPS = [
  {
    id: 'summarizer',
    name: { en: 'Summarizer' },
    system: { en: 'You summarize.' },
    prompt: { en: 'TPL: {{content}}' },
    preferredModel: 'oa',
    enabled: true
  },
  {
    id: 'plain',
    name: { en: 'Plain' },
    system: { en: 'You answer.' },
    preferredModel: 'oa',
    enabled: true
  }
];

const permissions = { apps: new Set(['*']), models: new Set(['*']) };
const ADA = { id: 'user-ada', name: 'Ada', permissions };
const GRACE = { id: 'user-grace', name: 'Grace', permissions };
const ANONYMOUS = { id: 'anonymous', permissions };

const FILES = '/api/inference/v1/files';
const CHAT = '/api/inference/v1/chat/completions';
const RESPONSES = '/api/inference/v1/responses';
const CONVERSATIONS = '/api/inference/v1/conversations';
const PDF = 'application/pdf';

let baseDir;
let ledger;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-inference-files-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  configCache.setCacheEntry('config/apps.json', APPS);
  configCache.setCacheEntry('config/models.json', MODELS);
  await configCache.loadAndCacheLocale('en');
  ledger = await captureRunLog();
});

after(async () => {
  await shutdownStorageBootstrap();
  const rm = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(baseDir);
  await rm(ledger.baseDir);
});

/** Platform config of a test: uploads quotas and the like. */
const setPlatform = (uploads, extra = {}) =>
  configCache.setCacheEntry('config/platform.json', {
    chats: { enabled: true },
    uploads,
    ...extra
  });
const setUploads = uploads => setPlatform(uploads);
setUploads({});

/** Every test starts without files of its own: the callers' uploads are removed. */
afterEach(async () => {
  setUploads({});
  const repository = getChatFileRepository();
  for (const user of [ADA, GRACE]) {
    const scope = userFileScope(user.id);
    for (const file of await repository.list(scope)) await repository.delete(scope, file.id);
  }
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function setup(script = [], { user = ADA } = {}) {
  const queue = [...script];
  const requests = [];
  const { client } = makeClient({
    models: MODELS,
    runLog: ledger.runLog,
    transport: async req => {
      requests.push(req);
      const next = queue.shift();
      if (!next) throw new Error(`script exhausted after ${requests.length} calls`);
      return sseResponse(next);
    }
  });
  const requestBuilder = new RequestBuilder();
  requestBuilder.apiKeyVerifier = {
    verifyApiKey: async () => ({ success: true, apiKey: 'sk-test' })
  };
  const chatService = new ChatService({
    requestBuilder,
    agentLoop: new AgentLoop({ llmClient: client, logger: silent, runLog: ledger.runLog }),
    runLog: ledger.runLog,
    logInteraction: async () => {},
    runTool: async () => ({}),
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} }
  });
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  let current = user;
  app.use((req, _res, next) => {
    req.user = current;
    next();
  });
  registerOpenAIProxyRoutes(app, {
    llmClient: client,
    chatService,
    getLocalizedError: async key => key,
    DEFAULT_TIMEOUT: 30000
  });
  return {
    app,
    requests,
    as: next => {
      current = next;
    }
  };
}

const sent = req => req.body.messages;
const userMessages = req => sent(req).filter(m => m.role === 'user');
/** Everything the model was sent as user text, in one string. */
const userText = req =>
  userMessages(req)
    .map(m => m.content)
    .join('\n---\n');

const upload = (app, content, { filename = 'notes.txt', type = 'text/plain', purpose } = {}) => {
  const call = request(app)
    .post(FILES)
    .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), {
      filename,
      contentType: type
    });
  return purpose ? call.field('purpose', purpose) : call;
};

const dataUrl = (bytes, type) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

async function makeXlsx() {
  const XLSX = (await import('xlsx')).default || (await import('xlsx'));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Item', 'Amount'],
      ['Rent', 1200],
      ['Deposit', 2400]
    ]),
    'Budget'
  );
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

describe('/v1/files', () => {
  it('uploads, lists, reads, downloads and deletes a file', async () => {
    const { app } = setup();
    const created = await upload(app, 'Clause 7: liability capped', { purpose: 'assistants' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const file = created.body;
    assert.equal(file.object, 'file');
    assert.match(file.id, /^file_[0-9a-f]{24}$/);
    assert.equal(file.filename, 'notes.txt');
    assert.equal(file.purpose, 'assistants');
    assert.equal(file.status, 'processed');
    assert.equal(file.bytes, 'Clause 7: liability capped'.length);
    assert.equal(typeof file.created_at, 'number');

    const list = await request(app).get(FILES);
    assert.equal(list.status, 200);
    assert.equal(list.body.object, 'list');
    assert.deepEqual(
      list.body.data.map(entry => entry.id),
      [file.id]
    );
    assert.equal(list.body.has_more, false);
    assert.equal((await request(app).get(`${FILES}?purpose=batch`)).body.data.length, 0);

    const read = await request(app).get(`${FILES}/${file.id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, file);

    const content = await request(app).get(`${FILES}/${file.id}/content`).buffer(true);
    assert.equal(content.status, 200);
    assert.equal(content.headers['content-type'].split(';')[0], 'text/plain');
    assert.equal(content.text, 'Clause 7: liability capped');
    const text = await request(app).get(`${FILES}/${file.id}/content?format=text`);
    assert.equal(text.text, 'Clause 7: liability capped');

    const removed = await request(app).delete(`${FILES}/${file.id}`);
    assert.deepEqual(removed.body, { id: file.id, object: 'file', deleted: true });
    const gone = await request(app).get(`${FILES}/${file.id}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, 'file_not_found');
    assert.equal((await request(app).delete(`${FILES}/${file.id}`)).status, 404);
  });

  it("keeps the file in the caller's user scope, read by the same extraction as a chat upload", async () => {
    const { app } = setup();
    const docx = await buildDocx({ body: p('Mietvertrag') + p('Laufzeit: zwei Jahre') });
    const res = await upload(app, docx, {
      filename: 'vertrag.docx',
      type: 'application/octet-stream'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      res.body.mime_type,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    const stored = await getChatFileRepository().getText(userFileScope(ADA.id), res.body.id);
    assert.match(stored.text, /Laufzeit: zwei Jahre/);
    assert.equal(stored.origin, 'api');
    assert.equal(stored.hasOriginal, true);
    // The original comes back byte for byte.
    const original = await request(app)
      .get(`${FILES}/${res.body.id}/content`)
      .buffer(true)
      .parse((response, done) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });
    assert.ok(Buffer.from(docx).equals(original.body));
  });

  it('accepts JSON uploads (text content, base64, data URL) and defaults the purpose', async () => {
    const { app } = setup();
    const text = await request(app)
      .post(FILES)
      .send({ filename: 'a.md', content: '# Heading\n\nBody' });
    assert.equal(text.status, 200, JSON.stringify(text.body));
    assert.equal(text.body.purpose, 'user_data');
    assert.equal(text.body.filename, 'a.md');
    const b64 = await request(app)
      .post(FILES)
      .send({ filename: 'b.txt', base64: Buffer.from('plain bytes').toString('base64') });
    assert.equal(b64.status, 200);
    assert.equal(b64.body.bytes, 'plain bytes'.length);
    const url = await request(app)
      .post(FILES)
      .send({ filename: 'c.csv', base64: dataUrl('a,b\n1,2', 'text/csv'), purpose: 'batch' });
    assert.equal(url.status, 200);
    assert.equal(url.body.purpose, 'batch');
    const none = await request(app).post(FILES).send({ filename: 'x.txt' });
    assert.equal(none.status, 400);
    assert.equal(none.body.error.code, 'missing_file');
    assert.equal((await request(app).get(FILES)).body.data.length, 3);
  });

  it('answers a file that cannot be read in the inference error envelope', async () => {
    const { app } = setup();
    const zip = await upload(app, Buffer.from('PK\u0003\u0004'), {
      filename: 'a.zip',
      type: 'application/zip'
    });
    assert.equal(zip.status, 400);
    assert.equal(zip.body.error.code, 'unsupported_file_type');
    assert.equal(zip.body.error.type, 'invalid_request_error');
    const broken = await upload(app, 'not a zip at all', {
      filename: 'a.docx',
      type: 'application/octet-stream'
    });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'invalid_file');
  });

  it("keeps a user's files from every other user: 404 for read, content and delete", async () => {
    const { app, as } = setup();
    const mine = (await upload(app, "Ada's secret", { filename: 'secret.txt' })).body;
    as(GRACE);
    assert.equal((await request(app).get(FILES)).body.data.length, 0);
    for (const probe of [
      request(app).get(`${FILES}/${mine.id}`),
      request(app).get(`${FILES}/${mine.id}/content`),
      request(app).get(`${FILES}/${mine.id}/content?format=text`),
      request(app).delete(`${FILES}/${mine.id}`)
    ]) {
      const res = await probe;
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'file_not_found');
    }
    as(ADA);
    assert.equal(
      (await request(app).get(`${FILES}/${mine.id}`)).status,
      200,
      'Grace deleted nothing'
    );
  });

  it('needs an authenticated caller: files are per caller, and the anonymous principal is shared', async () => {
    // With anonymous access on, the request reaches the route as the anonymous principal.
    setPlatform({}, { anonymousAuth: { enabled: true } });
    const { app, as } = setup();
    as(ANONYMOUS);
    const res = await upload(app, 'x');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'authentication_required');
    assert.equal((await request(app).get(FILES)).status, 401);
    const viaReference = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_x' }] }]
      });
    assert.equal(viaReference.status, 401);
  });

  it('answers 410 for an original that is gone and still serves the text', async () => {
    const { app } = setup();
    const file = (await upload(app, 'kept text')).body;
    await getChatFileRepository().discardOriginal(userFileScope(ADA.id), file.id, {
      reason: 'ttl_expired'
    });
    const res = await request(app).get(`${FILES}/${file.id}/content`);
    assert.equal(res.status, 410);
    assert.equal(res.body.error.code, 'original_discarded');
    assert.equal(
      (await request(app).get(`${FILES}/${file.id}/content?format=text`)).text,
      'kept text'
    );
    assert.equal((await request(app).get(`${FILES}/${file.id}`)).body.has_original, false);
  });

  it('pages and orders a listing', async () => {
    const { app } = setup();
    const ids = [];
    for (const name of ['1.txt', '2.txt', '3.txt']) {
      ids.push((await upload(app, `file ${name}`, { filename: name })).body.id);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const asc = await request(app).get(`${FILES}?order=asc&limit=2`);
    assert.deepEqual(
      asc.body.data.map(file => file.id),
      ids.slice(0, 2)
    );
    assert.equal(asc.body.has_more, true);
    const next = await request(app).get(`${FILES}?order=asc&after=${asc.body.last_id}`);
    assert.deepEqual(
      next.body.data.map(file => file.id),
      ids.slice(2)
    );
    assert.equal((await request(app).get(`${FILES}?limit=0`)).status, 400);
  });
});

describe('/v1/files quotas', () => {
  it('maps a file over the size limit to 413, from a multipart and from a JSON upload', async () => {
    setUploads({ quotas: { maxFileBytes: 20 } });
    const { app } = setup();
    const multipart = await upload(app, 'x'.repeat(100));
    assert.equal(multipart.status, 413);
    assert.equal(multipart.body.error.code, 'quota_file_bytes');
    assert.equal(multipart.body.error.type, 'invalid_request_error');
    const json = await request(app)
      .post(FILES)
      .send({ filename: 'big.txt', base64: Buffer.from('x'.repeat(100)).toString('base64') });
    assert.equal(json.status, 413);
    assert.equal(json.body.error.code, 'quota_file_bytes');
  });

  it('maps the file count of the user scope to 413 and a full server to 507', async () => {
    // The API user scope has limits of its own: the per-chat ones do not apply to it.
    setUploads({ quotas: { maxChatFiles: 1, maxApiFiles: 2 } });
    const { app } = setup();
    assert.equal((await upload(app, 'one')).status, 200);
    assert.equal((await upload(app, 'two')).status, 200);
    const third = await upload(app, 'three');
    assert.equal(third.status, 413);
    assert.equal(third.body.error.code, 'quota_api_files');

    setUploads({ quotas: { maxServerBytes: 10 }, evictOldestOriginalsOnQuota: false });
    const full = await upload(app, 'this is more than ten bytes');
    assert.equal(full.status, 507);
    assert.equal(full.body.error.code, 'quota_server_bytes');
    assert.equal(full.body.error.type, 'server_error');
  });

  it('answers 403 when uploads are switched off', async () => {
    setUploads({ enabled: false });
    const { app } = setup();
    const res = await upload(app, 'x');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'uploads_disabled');
  });
});

describe('file_id references', () => {
  it('feeds an uploaded file into /responses, for a plain model and for an app', async () => {
    const { app, requests } = setup([openaiText(['ok']), openaiText(['ok'])]);
    const file = (await upload(app, 'Clause 7: liability capped', { filename: 'c.txt' })).body;
    const input = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Summarize' },
          { type: 'input_file', file_id: file.id }
        ]
      }
    ];
    const plain = await request(app).post(RESPONSES).send({ model: 'oa', input });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.match(userText(requests[0]), /liability capped/);
    assert.match(userText(requests[0]), /name="c\.txt"/);
    const viaApp = await request(app).post(RESPONSES).send({ model: 'app:summarizer', input });
    assert.equal(viaApp.status, 200, JSON.stringify(viaApp.body));
    assert.match(userText(requests[1]), /TPL:/);
    assert.match(userText(requests[1]), /liability capped/);
  });

  it('feeds an uploaded file into /chat/completions, for a plain model and for an app', async () => {
    const { app, requests } = setup([openaiText(['ok']), openaiText(['ok'])]);
    const file = (await upload(app, 'Clause 7: liability capped', { filename: 'c.txt' })).body;
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize' },
          { type: 'file', file: { file_id: file.id } }
        ]
      }
    ];
    const plain = await request(app).post(CHAT).send({ model: 'oa', messages });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.match(userText(requests[0]), /liability capped/);
    assert.match(userText(requests[0]), /Summarize/);
    const viaApp = await request(app).post(CHAT).send({ model: 'app:summarizer', messages });
    assert.equal(viaApp.status, 200, JSON.stringify(viaApp.body));
    assert.match(userText(requests[1]), /liability capped/);
  });

  it("answers an unknown id, another user's id and a deleted id with 404, in each envelope", async () => {
    const { app, as } = setup([]);
    const file = (await upload(app, 'Ada only')).body;
    const responsesBody = id => ({
      model: 'oa',
      input: [{ role: 'user', content: [{ type: 'input_file', file_id: id }] }]
    });
    const chatBody = id => ({
      model: 'oa',
      messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: id } }] }]
    });

    const unknown = await request(app).post(RESPONSES).send(responsesBody('file_nope'));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'file_not_found');
    assert.equal(unknown.body.error.param, 'input[0].content[0]');
    const flat = await request(app).post(CHAT).send(chatBody('file_nope'));
    assert.equal(flat.status, 404);
    assert.equal(flat.body.code, 'file_not_found', 'chat completions keep their flat error body');

    as(GRACE);
    assert.equal((await request(app).post(RESPONSES).send(responsesBody(file.id))).status, 404);
    assert.equal((await request(app).post(CHAT).send(chatBody(file.id))).status, 404);

    as(ADA);
    await request(app).delete(`${FILES}/${file.id}`);
    assert.equal((await request(app).post(RESPONSES).send(responsesBody(file.id))).status, 404);
  });

  it('keeps refusing remote file URLs and image file ids', async () => {
    const { app } = setup([]);
    const url = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        input: [{ role: 'user', content: [{ type: 'input_file', file_url: 'https://x/y.pdf' }] }]
      });
    assert.equal(url.status, 400);
    assert.equal(url.body.error.code, 'unsupported_file_reference');
    const image = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_x' }] }]
      });
    assert.equal(image.body.error.code, 'unsupported_file_reference');
  });
});

describe('inline files through the shared pipeline', () => {
  it('reads an .xlsx as tables', async () => {
    const { app, requests } = setup([openaiText(['ok'])]);
    const res = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Total?' },
              {
                type: 'input_file',
                filename: 'budget.xlsx',
                file_data: dataUrl(await makeXlsx(), 'application/octet-stream')
              }
            ]
          }
        ]
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(userText(requests[0]), /Deposit/);
    assert.match(userText(requests[0]), /2400/);
  });

  it('renders a scanned PDF to page images for a plain model and for an app, instead of failing', async () => {
    const scanned = await buildPdfBytes([[], []]);
    const input = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read this scan' },
          { type: 'input_file', filename: 'scan.pdf', file_data: dataUrl(scanned, PDF) }
        ]
      }
    ];
    const { app, requests } = setup([openaiText(['ok']), openaiText(['ok'])]);
    const plain = await request(app).post(RESPONSES).send({ model: 'oa', input });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    const plainUser = userMessages(requests[0]).at(-1);
    assert.equal(plainUser.imageData.length, 2);
    assert.match(plainUser.content, /pages_as_images="2"/);
    const viaApp = await request(app).post(RESPONSES).send({ model: 'app:summarizer', input });
    assert.equal(viaApp.status, 200, JSON.stringify(viaApp.body));
    assert.equal(userMessages(requests[1]).at(-1).imageData.length, 2);
  });

  it('honors `file` parts on a plain-model /chat/completions, streamed or not', async () => {
    const { app, requests } = setup([openaiText(['ok']), openaiText(['ok'])]);
    const messages = [
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize' },
          {
            type: 'file',
            file: {
              filename: 'budget.xlsx',
              file_data: dataUrl(await makeXlsx(), 'application/octet-stream')
            }
          }
        ]
      }
    ];
    const res = await request(app).post(CHAT).send({ model: 'oa', messages });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sent(requests[0])[0].content, 'Be brief.');
    assert.match(userText(requests[0]), /Deposit/);
    assert.match(userText(requests[0]), /Summarize/);
    const streamed = await request(app).post(CHAT).send({ model: 'oa', messages, stream: true });
    assert.equal(streamed.status, 200);
    assert.match(userText(requests[1]), /Deposit/);
  });

  it('forwards messages without file parts untouched (images, tool calls)', async () => {
    const { app, requests } = setup([openaiText(['ok'])]);
    const messages = [
      { role: 'user', content: 'plain' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
      { role: 'user', content: 'next' }
    ];
    const res = await request(app).post(CHAT).send({ model: 'oa', messages });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sent(requests[0]).at(-1).content, 'next');
    assert.equal(sent(requests[0]).length, 4);
  });

  it('refuses a file over the size limit with 413 instead of a server error', async () => {
    setUploads({ quotas: { maxFileBytes: 20 } });
    const { app } = setup([]);
    const res = await request(app)
      .post(CHAT)
      .send({
        model: 'oa',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                file: { filename: 'big.txt', file_data: dataUrl('x'.repeat(100), 'text/plain') }
              }
            ]
          }
        ]
      });
    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'quota_file_bytes');
  });
});

describe('files of conversation turns', () => {
  const textInput = (text, file) => [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...(file
          ? [
              {
                type: 'input_file',
                filename: file.name,
                file_data: dataUrl(file.body, 'text/plain')
              }
            ]
          : [])
      ]
    }
  ];
  const clause = { name: 'c.txt', body: 'Clause 7: liability capped' };

  for (const model of ['oa', 'app:summarizer']) {
    it(`stores an inline file in the chat's file store and replays it on the next turn (${model})`, async () => {
      const { app, requests } = setup([openaiText(['first']), openaiText(['second'])]);
      const { body: conv } = await request(app).post(CONVERSATIONS).send({});
      const first = await request(app)
        .post(RESPONSES)
        .send({ model, conversation: conv.id, input: textInput('Here is the contract.', clause) });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.match(userText(requests[0]), /liability capped/);

      // Stored as a file with its original, named by the message instead of baked into it.
      const [stored] = (await getChatRepository().getMessages(conv.id)).messages;
      assert.equal(stored.content, 'Here is the contract.');
      assert.equal(
        stored.renderedContent === undefined || !/liability/.test(stored.renderedContent),
        true
      );
      const [attachment] = stored.attachments;
      assert.equal(attachment.name, 'c.txt');
      assert.match(attachment.id, /^file_/);
      const files = await getChatRepository().fileStore().list({ type: 'chat', id: conv.id });
      assert.equal(files.length, 1);
      assert.equal(files[0].id, attachment.id);
      assert.equal(files[0].origin, 'api');
      assert.equal(files[0].hasOriginal, true);

      // The conversation's items name the file.
      const items = await request(app).get(`${CONVERSATIONS}/${conv.id}/items?order=asc`);
      assert.equal(items.body.data[0].content[1].file_id, attachment.id);

      // The second turn sends no file; the model still sees the first turn's.
      const second = await request(app)
        .post(RESPONSES)
        .send({ model, conversation: conv.id, input: 'What is capped?' });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.match(userText(requests[1]), /liability capped/);
      assert.match(userText(requests[1]), /What is capped\?/);
      // …and it is not stored twice.
      assert.equal(
        (await getChatRepository().fileStore().list({ type: 'chat', id: conv.id })).length,
        1
      );
    });
  }

  it('shares files with the Web UI: a file uploaded to the chat there reaches API turns, and the other way round', async () => {
    const { app, requests } = setup([openaiText(['one']), openaiText(['two'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const chats = getChatRepository();
    const scope = { type: 'chat', id: conv.id };

    // A Web UI turn: the file went to POST /api/chats/:id/files, the message names it.
    const uiFile = await chats.fileStore().put(scope, {
      ownerId: ADA.id,
      name: 'ui.txt',
      mimeType: 'text/plain',
      text: 'Uploaded in the browser: ticket 4711',
      originalBuffer: Buffer.from('Uploaded in the browser: ticket 4711')
    });
    await chats.appendMessage(conv.id, {
      role: 'user',
      content: 'See the attachment',
      attachments: [{ id: uiFile.id, type: 'text/plain', name: 'ui.txt' }]
    });
    await chats.appendMessage(conv.id, { role: 'assistant', content: 'Seen.', runId: 'run-ui' });

    const api = await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', conversation: conv.id, input: 'Which ticket?' });
    assert.equal(api.status, 200, JSON.stringify(api.body));
    assert.match(userText(requests[0]), /ticket 4711/);

    // The same file can be referenced by its id from a response in that conversation…
    const byId = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        conversation: conv.id,
        input: [{ role: 'user', content: [{ type: 'input_file', file_id: uiFile.id }] }]
      });
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.match(userText(requests[1]), /ticket 4711/);
    // …and nowhere else: the id belongs to the chat, not to the caller's uploads.
    const outside = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        input: [{ role: 'user', content: [{ type: 'input_file', file_id: uiFile.id }] }]
      });
    assert.equal(outside.status, 404);
  });

  it('does not let a conversation of someone else open its files', async () => {
    const { app, as } = setup([]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const file = await getChatRepository()
      .fileStore()
      .put(
        { type: 'chat', id: conv.id },
        { ownerId: ADA.id, name: 'a.txt', mimeType: 'text/plain', text: 'secret' }
      );
    as(GRACE);
    const res = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        conversation: conv.id,
        input: [{ role: 'user', content: [{ type: 'input_file', file_id: file.id }] }]
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'conversation_not_found');
  });

  it('copies an uploaded file into the conversation, once, so deleting the upload does not break the chat', async () => {
    const { app, requests } = setup([openaiText(['a']), openaiText(['b']), openaiText(['c'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const upload1 = (await upload(app, 'Clause 7: liability capped', { filename: 'c.txt' })).body;
    const input = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read it' },
          { type: 'input_file', file_id: upload1.id }
        ]
      }
    ];
    for (const model of ['oa', 'oa']) {
      const res = await request(app).post(RESPONSES).send({ model, conversation: conv.id, input });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const chatFiles = await getChatRepository().fileStore().list({ type: 'chat', id: conv.id });
    assert.equal(chatFiles.length, 1, 'the same upload is copied once');
    assert.equal(chatFiles[0].meta.sourceFileId, upload1.id);
    assert.equal(chatFiles[0].hasOriginal, true);

    await request(app).delete(`${FILES}/${upload1.id}`);
    const after = await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', conversation: conv.id, input: 'Still there?' });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.match(userText(requests[2]), /liability capped/);
  });

  it('stores a scanned PDF with its page images and replays them', async () => {
    const { app, requests } = setup([openaiText(['a']), openaiText(['b'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const scanned = await buildPdfBytes([[], []]);
    const first = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        conversation: conv.id,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Scan' },
              { type: 'input_file', filename: 'scan.pdf', file_data: dataUrl(scanned, PDF) }
            ]
          }
        ]
      });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const [file] = await getChatRepository().fileStore().list({ type: 'chat', id: conv.id });
    assert.equal(file.hasPageImages, true);
    assert.equal(file.pageImageCount, 2);
    await request(app).post(RESPONSES).send({ model: 'oa', conversation: conv.id, input: 'Again' });
    const replayed = userMessages(requests[1]).find(m => /pages_as_images/.test(m.content));
    assert.equal(replayed.imageData.length, 2);
  });

  it('answers a chat file quota with 413 and gives the conversation back', async () => {
    setUploads({ quotas: { maxChatFiles: 1 } });
    const { app } = setup([openaiText(['a'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const two = [
      { role: 'user', content: textInput('one', clause)[0].content },
      { role: 'user', content: textInput('two', { name: 'd.txt', body: 'second doc' })[0].content }
    ];
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', conversation: conv.id, input: two });
    assert.equal(res.status, 413, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'quota_chat_files');
    assert.equal((await getChatRepository().getChat(conv.id)).activeRunId, null);
  });

  it('keeps requests without files exactly as they were: no file store traffic, content as sent', async () => {
    const { app, requests } = setup([openaiText(['a']), openaiText(['b'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    await request(app).post(RESPONSES).send({ model: 'oa', conversation: conv.id, input: 'hello' });
    await request(app).post(RESPONSES).send({ model: 'oa', conversation: conv.id, input: 'again' });
    assert.deepEqual(
      userMessages(requests[1]).map(m => m.content),
      ['hello', 'again']
    );
    const stored = (await getChatRepository().getMessages(conv.id)).messages;
    assert.equal(stored[0].attachments, undefined);
    assert.equal(
      (await getChatRepository().fileStore().list({ type: 'chat', id: conv.id })).length,
      0
    );
  });
});

describe('files on conversation items', () => {
  const part = (name, body) => ({
    type: 'input_file',
    filename: name,
    file_data: dataUrl(body, 'text/plain')
  });
  const item = (text, ...files) => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }, ...files]
  });

  it('stores an inline file of an added item in the conversation and names it on the item', async () => {
    const { app, requests } = setup([openaiText(['ok'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const added = await request(app)
      .post(`${CONVERSATIONS}/${conv.id}/items`)
      .send({
        items: [item('Please keep this.', part('terms.txt', 'Term 9: notice period 3 months'))]
      });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const [stored] = (await getChatRepository().getMessages(conv.id)).messages;
    assert.equal(stored.content, 'Please keep this.');
    const [attachment] = stored.attachments;
    assert.equal(attachment.name, 'terms.txt');
    assert.match(attachment.id, /^file_/);
    const files = await getChatRepository().fileStore().list({ type: 'chat', id: conv.id });
    assert.equal(files.length, 1);
    assert.equal(files[0].origin, 'api');
    assert.equal(files[0].hasOriginal, true);
    assert.equal(added.body.data[0].content[1].file_id, attachment.id);

    // The next response in the conversation sees the file.
    const answer = await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', conversation: conv.id, input: 'Which notice period?' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.match(userText(requests[0]), /notice period 3 months/);
  });

  it('copies an uploaded file by id, once, and reads a Chat Completions file part', async () => {
    const { app } = setup([]);
    const uploaded = await upload(app, 'Uploaded memo text', { filename: 'memo.txt' });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    for (let i = 0; i < 2; i += 1) {
      const added = await request(app)
        .post(`${CONVERSATIONS}/${conv.id}/items`)
        .send({
          items: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `again ${i}` },
                { type: 'file', file: { file_id: uploaded.body.id } }
              ]
            }
          ]
        });
      assert.equal(added.status, 200, JSON.stringify(added.body));
    }
    const files = await getChatRepository().fileStore().list({ type: 'chat', id: conv.id });
    assert.equal(files.length, 1, 'the same upload is not copied twice');
    assert.equal(files[0].name, 'memo.txt');
  });

  it('takes files when a conversation is created with items', async () => {
    const { app } = setup([]);
    const created = await request(app)
      .post(CONVERSATIONS)
      .send({ items: [item('Start here', part('seed.txt', 'seed content'))] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const files = await getChatRepository().fileStore().list({ type: 'chat', id: created.body.id });
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'seed.txt');
  });

  it('refuses files on assistant items, other parts, foreign file ids and URLs', async () => {
    const { app } = setup([]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const post = items => request(app).post(`${CONVERSATIONS}/${conv.id}/items`).send({ items });
    const assistant = await post([
      { role: 'assistant', content: [{ type: 'output_text', text: 'x' }, part('a.txt', 'a')] }
    ]);
    assert.equal(assistant.status, 400);
    assert.equal(assistant.body.error.code, 'invalid_items');
    const image = await post([
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }
    ]);
    assert.equal(image.status, 400);
    assert.equal(image.body.error.code, 'unsupported_content_part');
    const unknown = await post([
      { role: 'user', content: [{ type: 'input_file', file_id: 'file_doesnotexist0000000000' }] }
    ]);
    assert.equal(unknown.status, 404);
    const url = await post([
      { role: 'user', content: [{ type: 'input_file', file_url: 'https://example.com/a.pdf' }] }
    ]);
    assert.equal(url.status, 400);
    assert.equal((await getChatRepository().getMessages(conv.id)).messages.length, 0);
  });
});

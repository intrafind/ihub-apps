// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** The run ledger records uploads as references, never their bytes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ledgerMessages } from '../../services/loop/ledgerMessages.js';
import { renderUserMessage } from '../../../shared/promptContext.js';
import { attachDocumentPageImages } from '../../services/chat/RequestBuilder.js';
import { hashPayload } from '../../services/loop/RunLog.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { makeClient, sseResponse, openaiText, captureRunLog } from './helpers/llmFixtures.js';

const hex = v => crypto.createHash('sha256').update(v).digest('hex');
const docText = 'Quarterly report. '.repeat(500);
const doc = {
  fileId: 'file_a',
  fileName: 'report.pdf',
  fileType: 'application/pdf',
  content: docText,
  chatFile: true
};
const pngBytes = crypto.randomBytes(3000);
const pngB64 = pngBytes.toString('base64');
const scan = {
  fileId: 'file_s',
  fileName: 'scan.pdf',
  pageImages: [pngB64, pngB64],
  chatFile: true
};

function userMessage(files) {
  return {
    role: 'user',
    content: renderUserMessage({ content: 'Summarize', files }),
    fileData: files
  };
}

test('a stored document becomes a reference to its chat file; fileData is left out', () => {
  const [msg] = ledgerMessages([userMessage([doc])]);
  assert.equal(msg.fileData, undefined);
  assert.ok(!msg.content.includes('Quarterly report'), 'text is not copied');
  assert.match(
    msg.content,
    /<content type="document" origin="upload" id="file_a" name="report.pdf"/
  );
  assert.ok(msg.content.includes(`text_sha256="${hex(docText)}" chars="${docText.length}"/>`));
  assert.ok(msg.content.includes('Summarize'), 'the typed instruction stays');
});

test('a document with no chat file behind it keeps its text', () => {
  const [msg] = ledgerMessages([userMessage([{ ...doc, chatFile: undefined }])]);
  assert.ok(msg.content.includes('Quarterly report'));
  assert.equal(msg.fileData, undefined, 'the duplicate in fileData still goes');
});

test('stored pages and pictures become references hashed over their bytes; others stay', () => {
  const [withPages] = attachDocumentPageImages([userMessage([scan])]);
  const pasted = {
    base64: `data:image/png;base64,${pngB64}`,
    fileType: 'image/png',
    fileId: 'file_p'
  };
  const unstored = { base64: pngB64, fileType: 'image/png' };
  const [msg] = ledgerMessages([
    { ...withPages, imageData: [...withPages.imageData, pasted, unstored] }
  ]);
  assert.deepEqual(msg.imageData[0], {
    fileType: 'image/jpeg',
    fileId: 'file_s',
    page: 0,
    sha256: hex(pngBytes),
    bytes: pngBytes.length
  });
  assert.deepEqual(msg.imageData[2], {
    fileType: 'image/png',
    fileId: 'file_p',
    sha256: hex(pngBytes),
    bytes: pngBytes.length
  });
  assert.equal(msg.imageData[3], unstored, 'no chat file: kept in full');
});

test('pages rendered outside the chat files (workflows) carry no id and stay', () => {
  const [withPages] = attachDocumentPageImages([userMessage([{ ...scan, chatFile: undefined }])]);
  assert.equal(withPages.imageData[0].fileId, undefined);
  const [msg] = ledgerMessages([withPages]);
  assert.equal(msg.imageData[0].base64, pngB64);
});

test('audio and inference content parts are not touched', () => {
  const audio = {
    role: 'user',
    content: 'listen',
    audioData: { base64: pngB64, fileType: 'audio/wav' }
  };
  const parts = {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } }]
  };
  const out = ledgerMessages([audio, parts]);
  assert.equal(out[0], audio);
  assert.equal(out[1], parts);
});

test('a block not rendered as-is keeps its text (fails safe, never lossy)', () => {
  const msg = { role: 'user', content: `custom template: ${docText}`, fileData: [doc] };
  const [out] = ledgerMessages([msg]);
  assert.equal(out.content, msg.content);
});

test('plain messages pass through untouched and the input is not modified', () => {
  const input = [{ role: 'system', content: 'sys' }, userMessage([doc])];
  const before = structuredClone(input);
  const out = ledgerMessages(input);
  assert.equal(out[0], input[0]);
  assert.deepEqual(input, before);
});

test('request/header records the reference copy but hashes the real messages', async () => {
  const { runLog, events } = await captureRunLog();
  const { client } = makeClient({ runLog, transport: async () => sseResponse(openaiText(['ok'])) });
  const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
  const messages = [userMessage([doc])];
  await client.complete({ modelId: 'oa', messages, telemetry: { runId, step: 0 } });
  const [header] = events.filter(e => e.type === RUN_LOG_EVENTS.REQUEST_HEADER);
  assert.equal(header.data.messagesHash, hashPayload(messages));
  assert.ok(!JSON.stringify(header.data.messages).includes('Quarterly report'));
  assert.equal(header.data.messages[0].fileData, undefined);
});

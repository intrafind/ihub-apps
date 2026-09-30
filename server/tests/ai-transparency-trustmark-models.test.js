/**
 * EU AI Act transparency (#2569): the TrustMark models are downloaded by iHub,
 * asynchronously, so a slow or blocked network can never freeze the server
 * (c2pa-node's own download blocks the event loop).
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { cleanup, setConfig, tempContents } from './helpers/aiTransparencyEnv.js';

const {
  ensureTrustmarkModels,
  resetTrustmarkModelState,
  trustmarkModelDownloadState,
  trustmarkModelsPresent
} = await import('../services/provenance/image/trustmarkModels.js');

const ENCODER = Buffer.from('fake encoder model bytes '.repeat(400));
const DECODER = Buffer.from('fake decoder model bytes '.repeat(900));
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const FILES = [
  { name: 'encoder_P.onnx', size: ENCODER.length, sha256: sha256(ENCODER) },
  { name: 'decoder_P.onnx', size: DECODER.length, sha256: sha256(DECODER) }
];

let server;
let baseUrl;
let requests = 0;
/** name -> 'ok' | 'corrupt' | 'stall' | 404 */
let behaviour = {};
let dirCount = 0;

function modelDir() {
  dirCount += 1;
  return path.join(tempContents, 'data', `trustmark-models-${dirCount}`);
}

before(async () => {
  setConfig({ platform: {}, features: {} });
  server = http.createServer((req, res) => {
    requests += 1;
    const name = path.basename(req.url);
    const body = { 'encoder_P.onnx': ENCODER, 'decoder_P.onnx': DECODER }[name];
    const mode = behaviour[name] ?? 'ok';
    if (!body || mode === 404) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    if (mode === 'stall') {
      res.write(body.subarray(0, 100)); // then nothing, connection stays open
      return;
    }
    if (mode === 'corrupt') {
      const bad = Buffer.from(body);
      bad[0] ^= 0xff;
      res.end(bad);
      return;
    }
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  behaviour = {};
  requests = 0;
  resetTrustmarkModelState();
});

after(() => {
  server.closeAllConnections?.();
  server.close();
  cleanup();
});

describe('TrustMark model download', () => {
  it('downloads the missing models, verified, into the model path', async () => {
    const dir = modelDir();
    assert.equal(trustmarkModelsPresent(dir, FILES), false);
    await ensureTrustmarkModels(dir, { baseUrl, files: FILES });
    assert.equal(trustmarkModelsPresent(dir, FILES), true);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'decoder_P.onnx')), DECODER);
    assert.deepEqual(
      fs.readdirSync(dir).filter(f => f.endsWith('.part')),
      [],
      'no temporary files are left'
    );
    // Present models need no network.
    requests = 0;
    await ensureTrustmarkModels(dir, { baseUrl, files: FILES });
    assert.equal(requests, 0);
  });

  it('shares one download between concurrent callers', async () => {
    const dir = modelDir();
    await Promise.all([
      ensureTrustmarkModels(dir, { baseUrl, files: FILES }),
      ensureTrustmarkModels(dir, { baseUrl, files: FILES }),
      ensureTrustmarkModels(dir, { baseUrl, files: FILES })
    ]);
    assert.equal(requests, 2, 'one request per file');
  });

  it('rejects a model whose hash does not match, and keeps nothing', async () => {
    const dir = modelDir();
    behaviour = { 'decoder_P.onnx': 'corrupt' };
    await assert.rejects(
      ensureTrustmarkModels(dir, { baseUrl, files: FILES }),
      /does not match its pinned SHA-256/
    );
    assert.equal(fs.existsSync(path.join(dir, 'decoder_P.onnx')), false);
    assert.deepEqual(
      fs.readdirSync(dir).filter(f => f.endsWith('.part')),
      []
    );
    assert.match(trustmarkModelDownloadState(dir).error, /SHA-256/);
  });

  it('waits before trying again after a failure', async () => {
    const dir = modelDir();
    behaviour = { 'encoder_P.onnx': 404 };
    await assert.rejects(ensureTrustmarkModels(dir, { baseUrl, files: FILES }), /HTTP 404/);
    behaviour = {};
    requests = 0;
    await assert.rejects(
      ensureTrustmarkModels(dir, { baseUrl, files: FILES }),
      /TrustMark model download failed: HTTP 404/
    );
    assert.equal(requests, 0, 'no new attempt inside the retry window');
    await ensureTrustmarkModels(dir, { baseUrl, files: FILES, retryAfterMs: 0 });
    assert.equal(trustmarkModelsPresent(dir, FILES), true);
  });

  it('aborts a stalled download without blocking the event loop', async () => {
    const dir = modelDir();
    behaviour = { 'encoder_P.onnx': 'stall' };
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = Date.now();
    const download = ensureTrustmarkModels(dir, { baseUrl, files: FILES, stallTimeoutMs: 300 });
    assert.equal(trustmarkModelDownloadState(dir).downloading, true);
    await assert.rejects(download, /no data from 127\.0\.0\.1:\d+ for 0\.3 s/);
    clearInterval(ticker);
    assert.ok(Date.now() - started < 5000, 'gives up after the stall timeout');
    assert.ok(ticks >= 5, `timers kept firing during the download (${ticks})`);
    assert.equal(trustmarkModelDownloadState(dir).downloading, false);
    assert.equal(fs.existsSync(path.join(dir, 'encoder_P.onnx')), false);
  });
});

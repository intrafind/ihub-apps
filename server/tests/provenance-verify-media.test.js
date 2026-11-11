// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/provenance/_verify` with a file (#3328): a hash hit returns the
 * record, an unknown image still gets its C2PA read, a WAV-wrapped TTS clip
 * matches by its PCM payload, and refused input (oversize, SVG, spoofed
 * Content-Type, two files, other body types) fails with problem+json. The
 * JSON lookup is unchanged.
 */
import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  makePcm,
  makePng,
  makeWav,
  makeWavWithC2pa,
  readSignedJpeg
} from './helpers/mediaFixtures.js';

const platform = {
  provenance: { verify: { access: 'authenticated' }, media: { maxVerifyBytes: 200000 } },
  rateLimit: {}
};
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform }
}));
const { ServiceError } = await import('../utils/ServiceError.js');
// Signed-in callers carry `x-test-user`; everyone else is turned away. The route uses
// `authenticatedOnly`; `authRequired` stays exported for anything else that imports it.
const signedInOnly = (req, res, next) =>
  req.headers['x-test-user']
    ? next()
    : next(new ServiceError('AUTH_REQUIRED', 'Authentication required'));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: signedInOnly,
  authenticatedOnly: signedInOnly
}));

const { startTestStorage } = await import('./helpers/testStorage.js');
const { default: registerProvenanceRoutes } = await import('../routes/provenanceRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { getProvenanceStore } = await import('../services/provenance/ProvenanceStore.js');
const { buildMediaRecord, hashBytes } = await import('../services/provenance/mediaMarking.js');
const { readC2pa } = await import('../services/provenance/c2paReader.js');

let storage;
let app;
const generated = makePng([], 42);
const signed = readSignedJpeg();

async function store(kind, bytes, extra = {}) {
  const record = buildMediaRecord({
    outputId: extra.outputId,
    kind,
    contentHash: hashBytes(bytes),
    byteLength: bytes.length,
    mimeType: kind === 'image' ? 'image/png' : 'audio/L16;rate=24000',
    model: { id: extra.modelId || 'img-model' },
    modelConfig: { contentMarking: { image: { by: 'provider', scheme: 'synthid' } } },
    c2pa: kind === 'image' ? await readC2pa(bytes) : null,
    installationId: 'inst_test',
    version: '1.0.0'
  });
  await getProvenanceStore().record(record);
  return record;
}

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-provenance-media-' });
  await store('image', generated, { outputId: '01JCIMAGE00000000000000001' });
  app = express();
  app.use(express.json({ limit: '2mb' }));
  registerProvenanceRoutes(app);
  app.use(errorHandler);
});

afterAll(async () => {
  await storage.stop();
});

const verify = () => request(app).post('/api/provenance/_verify').set('x-test-user', 'u1');
const upload = (bytes, name = 'file.bin', type) =>
  verify().attach('file', bytes, { filename: name, ...(type ? { contentType: type } : {}) });

describe('POST /api/provenance/_verify with a file', () => {
  test('a generated image is found by its bytes, with the record and the C2PA read', async () => {
    const res = await upload(generated, 'a.png');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      found: true,
      kind: 'image',
      normalization: 'none',
      declared: 'synthid',
      synthid: 'declared-not-detectable'
    });
    expect(res.body.contentHash).toMatchObject({
      alg: 'sha-256',
      value: hashBytes(generated),
      bytes: generated.length,
      mimeType: 'image/png'
    });
    expect(res.body.records[0]).toMatchObject({
      output_id: '01JCIMAGE00000000000000001',
      kind: 'image'
    });
    expect(res.body.records[0].verify).toMatch(/_verify$/);
    expect(res.body.records[0].provider_marking.declared).toBe('synthid');
    expect(res.body.c2pa).toMatchObject({
      present: false,
      status: 'absent',
      trust: 'not-evaluated'
    });
    expect(res.body.technique).toEqual(['hash-lookup']);
    expect(res.body.caveats).toContain('trust-not-evaluated');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('an unknown image is a 200 miss that still carries the C2PA result', async () => {
    const res = await upload(signed, 'c.jpg');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.records).toBeUndefined();
    expect(res.body.c2pa).toMatchObject({
      present: true,
      status: 'present',
      valid: true,
      issuer: 'C2PA Test Signing Cert',
      trust: 'not-evaluated'
    });
    expect(res.body.technique).toEqual(['metadata']);
    expect(res.body.synthid).toBe('not-detectable');
    expect(res.body.caveats).toEqual(['trust-not-evaluated', 'absence-is-not-proof']);
  });

  test('an audio file gets its C2PA read and never a hash hit', async () => {
    const res = await upload(makeWavWithC2pa(), 'clip.wav');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      found: false,
      kind: 'audio',
      contentHash: { mimeType: 'audio/wav' }
    });
    expect(res.body.c2pa).toMatchObject({ present: true, trust: 'not-evaluated' });
    expect(res.body.records).toBeUndefined();
    const plain = await upload(makeWav(makePcm(0.1)), 'plain.wav');
    expect(plain.body.c2pa).toMatchObject({ present: false });
  });

  test('spoofed Content-Type does not help: the bytes decide', async () => {
    const asText = await upload(Buffer.from('not media at all, just text'), 'x.png', 'image/png');
    expect(asText.status).toBe(415);
    expect(asText.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(asText.headers['content-type']).toMatch(/problem\+json/);
    const png = await upload(generated, 'x.txt', 'text/plain');
    expect(png.status).toBe(200);
    expect(png.body.found).toBe(true);
  });

  test('SVG is refused', async () => {
    const res = await upload(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'),
      'x.svg',
      'image/svg+xml'
    );
    expect(res.status).toBe(415);
  });

  test('a declared kind that does not match the bytes is a 415', async () => {
    const res = await verify().field('kind', 'audio').attach('file', generated, 'a.png');
    expect(res.status).toBe(415);
  });

  test('an invalid kind field is a 400', async () => {
    const res = await verify().field('kind', 'video').attach('file', generated, 'a.png');
    expect(res.status).toBe(400);
  });

  test('a file over provenance.media.maxVerifyBytes is a 413', async () => {
    const big = Buffer.concat([makePng(), Buffer.alloc(platform.provenance.media.maxVerifyBytes)]);
    const res = await upload(big, 'big.png');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('two files are a 400, no file is a 400', async () => {
    const two = await verify().attach('file', generated, 'a.png').attach('file', signed, 'b.jpg');
    expect(two.status).toBe(400);
    const none = await verify().field('kind', 'image');
    expect(none.status).toBe(400);
  });

  test('another body type is a 415', async () => {
    const res = await verify().set('Content-Type', 'text/plain').send('hello');
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('a file needs a signed-in caller by default', async () => {
    const res = await request(app)
      .post('/api/provenance/_verify')
      .attach('file', generated, 'a.png');
    expect(res.status).toBe(401);
  });

  test('the JSON text/hash lookup is unchanged', async () => {
    const res = await verify().send({ contentHash: hashBytes(generated) });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.normalization).toBe('nfc-trim');
  });

  test('a record never holds the bytes', async () => {
    const res = await upload(generated, 'a.png');
    expect(JSON.stringify(res.body.records)).not.toContain(
      generated.toString('base64').slice(0, 30)
    );
    const stored = await getProvenanceStore().findByHash(hashBytes(generated));
    expect(JSON.stringify(stored)).not.toContain(generated.toString('base64').slice(0, 30));
  });
});

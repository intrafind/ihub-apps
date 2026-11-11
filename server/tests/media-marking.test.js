// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Reading provider marks (#3328): the C2PA reader on a real signed file and
 * synthetic ones, the negative control, "no network by construction", the
 * dependency-free presence fallback, the byte sniffers and `declared`.
 */
import { jest, describe, test, expect, afterEach } from '@jest/globals';
import {
  SOURCE_TYPE,
  flipByte,
  makeJpegWithXmp,
  makePcm,
  makePlainJpeg,
  makePng,
  makePngWithCaBX,
  makeWav,
  makeWavWithC2pa,
  readSignedJpeg
} from './helpers/mediaFixtures.js';

const { readC2pa, C2PA_READER_CONTEXT } = await import('../services/provenance/c2paReader.js');
const { detectC2paPresence } = await import('../services/provenance/c2paPresence.js');
const { sniffMedia } = await import('../services/provenance/mediaSniff.js');
const { buildMediaRecord, declaredMarking, hashBytes, stampGeneratedImage } =
  await import('../services/provenance/mediaMarking.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('C2PA reader', () => {
  test('reads the signed upstream fixture: valid, issuer, source type, trust not evaluated', async () => {
    const result = await readC2pa(readSignedJpeg());
    expect(result).toMatchObject({
      present: true,
      status: 'present',
      valid: true,
      issuer: 'C2PA Test Signing Cert',
      digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia',
      trust: 'not-evaluated',
      reader: 'c2pa-wasm'
    });
    expect(result.claimGenerator).toContain('make_test_images');
    expect(result.signedAt).toBeTruthy();
  });

  test('negative control: one flipped byte makes the binding fail', async () => {
    const result = await readC2pa(flipByte(readSignedJpeg()));
    expect(result.present).toBe(true);
    expect(result.valid).toBe(false);
  });

  test('never calls fetch, whatever the file carries', async () => {
    globalThis.fetch = jest.fn(() => {
      throw new Error('outbound request attempted');
    });
    await readC2pa(readSignedJpeg());
    await readC2pa(flipByte(readSignedJpeg()));
    await readC2pa(makePngWithCaBX());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('is configured with remote manifest, OCSP and trust verification off', () => {
    expect(C2PA_READER_CONTEXT.verify).toEqual({
      remote_manifest_fetch: false,
      ocsp_fetch: false,
      verify_trust: false
    });
  });

  test('a file without a manifest is absent, not an error', async () => {
    for (const file of [makePlainJpeg(), makePng()]) {
      const result = await readC2pa(file);
      expect(result).toMatchObject({ present: false, status: 'absent', valid: null });
    }
  });

  test('an unknown or garbage file is unsupported_format', async () => {
    expect((await readC2pa(Buffer.alloc(64, 7))).status).toBe('unsupported_format');
  });

  test('reports the XMP digital source type separately from the manifest', async () => {
    const result = await readC2pa(makeJpegWithXmp());
    expect(result.present).toBe(false);
    expect(result.xmpDigitalSourceType).toBe(SOURCE_TYPE);
    expect(result.digitalSourceType).toBeNull();
  });
});

describe('presence fallback', () => {
  test('agrees with the reader on presence for the same fixtures', async () => {
    const files = [
      [readSignedJpeg(), 'jpeg', true],
      [makePngWithCaBX(), 'png', true],
      [makePng(), 'png', false],
      [makePlainJpeg(), 'jpeg', false],
      [makeWavWithC2pa(), 'wav', true],
      [makeWav(makePcm(0.1)), 'wav', false]
    ];
    for (const [file, container, present] of files) {
      const found = detectC2paPresence(file, container);
      expect(found.present).toBe(present);
      expect(found.validated).toBe(false);
      expect(found.issuer).toBeNull();
    }
    // The reader and the fallback agree where the reader can parse the file.
    expect((await readC2pa(readSignedJpeg())).present).toBe(true);
    expect((await readC2pa(makePlainJpeg())).present).toBe(false);
  });

  test('reads Iptc4xmpExt:DigitalSourceType from XMP', () => {
    expect(detectC2paPresence(makeJpegWithXmp(), 'jpeg').digitalSourceType).toBe(SOURCE_TYPE);
  });

  test('survives truncated and hostile input', () => {
    const truncated = readSignedJpeg().subarray(0, 5000);
    expect(() => detectC2paPresence(truncated, 'jpeg')).not.toThrow();
    expect(() => detectC2paPresence(Buffer.alloc(40, 0xff), 'jpeg')).not.toThrow();
    expect(() => detectC2paPresence(Buffer.alloc(40, 0xff), 'heic')).not.toThrow();
  });
});

describe('sniffMedia', () => {
  test('names the type from the bytes', () => {
    expect(sniffMedia(makePng())).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(sniffMedia(makePlainJpeg())).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' });
    expect(sniffMedia(makeWav(makePcm(0.1)))).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/wav'
    });
    expect(sniffMedia(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(20)]))).toMatchObject({
      kind: 'audio'
    });
    expect(sniffMedia(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]))).toMatchObject({
      mimeType: 'audio/mpeg'
    });
  });

  test('refuses SVG, HTML, text and unknown bytes', () => {
    expect(sniffMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffMedia(Buffer.from('<html><body>hello world</body></html>'))).toBeNull();
    expect(sniffMedia(Buffer.from('just some plain text here'))).toBeNull();
  });
});

describe('media records', () => {
  const image = () => ({ mimeType: 'image/png', data: makePng().toString('base64') });

  test('stampGeneratedImage hashes the decoded bytes, once, and leaves data alone', () => {
    const img = image();
    const before = img.data;
    const stamp = stampGeneratedImage(img);
    expect(stamp.created).toBe(true);
    expect(img.provenance.contentHash).toBe(hashBytes(Buffer.from(before, 'base64')));
    expect(img.provenance.contentHash).not.toBe(hashBytes(Buffer.from(before)));
    expect(img.data).toBe(before);
    const again = stampGeneratedImage(img);
    expect(again.created).toBe(false);
    expect(again.outputId).toBe(img.provenance.outputId);
  });

  test('declared follows the model config and never the response', () => {
    expect(
      declaredMarking({ contentMarking: { image: { by: 'provider', scheme: 'synthid' } } }, 'image')
    ).toBe('synthid');
    expect(declaredMarking({ contentMarking: { image: { by: 'none' } } }, 'image')).toBeNull();
    expect(declaredMarking({}, 'image')).toBeNull();
    expect(
      declaredMarking({ contentMarking: { image: { by: 'provider', scheme: 'synthid' } } }, 'audio')
    ).toBeNull();
  });

  test('a record carries provider_marking and no bytes', async () => {
    const png = makePng();
    const c2pa = await readC2pa(png);
    const record = buildMediaRecord({
      outputId: 'O'.repeat(26),
      kind: 'image',
      contentHash: hashBytes(png),
      byteLength: png.length,
      mimeType: 'image/png',
      model: { id: 'gemini-image' },
      modelConfig: { contentMarking: { image: { by: 'provider', scheme: 'synthid' } } },
      c2pa,
      installationId: 'inst_x',
      version: '1.0.0'
    });
    expect(record.kind).toBe('image');
    expect(record.content_hash).toMatchObject({
      normalization: 'none',
      bytes: png.length,
      mime_type: 'image/png'
    });
    expect(record.provider_marking.declared).toBe('synthid');
    expect(record.provider_marking.c2pa).toMatchObject({
      present: false,
      status: 'absent',
      trust: 'not-evaluated'
    });
    expect(JSON.stringify(record)).not.toContain(png.toString('base64').slice(0, 40));
  });
});

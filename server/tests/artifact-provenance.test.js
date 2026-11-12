// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the provider embedded in a stored generated image (#3328), looked up for
 * the chat's "About this answer" details: found by the bytes of the artifact,
 * so an image generated before the chat showed it has it too; never the
 * record's user; and nothing for a file that is no image or has no record.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { makePng, readSignedJpeg } from './helpers/mediaFixtures.js';

const { startTestStorage } = await import('./helpers/testStorage.js');
const { getProvenanceStore } = await import('../services/provenance/ProvenanceStore.js');
const { buildMediaRecord, hashBytes } = await import('../services/provenance/mediaMarking.js');
const { readC2pa } = await import('../services/provenance/c2paReader.js');
const { providerMarkingOfArtifact } = await import('../services/provenance/artifactProvenance.js');

let storage;
const signed = readSignedJpeg();
const unsigned = makePng([], 7);
const unrecorded = makePng([], 99);

async function record(bytes, outputId, extra = {}) {
  const built = buildMediaRecord({
    outputId,
    kind: 'image',
    contentHash: hashBytes(bytes),
    byteLength: bytes.length,
    mimeType: bytes === signed ? 'image/jpeg' : 'image/png',
    model: { id: 'img-model' },
    modelConfig: { contentMarking: { image: { by: 'provider', scheme: 'synthid' } } },
    c2pa: await readC2pa(bytes),
    installationId: 'inst_test',
    version: '1.0.0'
  });
  await getProvenanceStore().record({ ...built, ...extra });
}

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-artifact-provenance-' });
  await record(signed, '01JCSIGNED0000000000000001', {
    user: { mode: 'identified', id: 'u-secret' }
  });
  await record(unsigned, '01JCUNSIGNED00000000000001');
});

afterAll(async () => {
  await storage.stop();
});

describe('providerMarkingOfArtifact', () => {
  test('answers what the file carries: signer, tool, source type, signature, trust not evaluated', async () => {
    const result = await providerMarkingOfArtifact({ kind: 'image', data: signed });
    expect(result.outputId).toBe('01JCSIGNED0000000000000001');
    expect(result.providerMarking.c2pa).toMatchObject({
      present: true,
      status: 'present',
      valid: true,
      issuer: 'C2PA Test Signing Cert',
      digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia',
      trust: 'not-evaluated'
    });
    expect(result.providerMarking.declared).toBe('synthid');
  });

  test('a file without Content Credentials says so, by what the reader found', async () => {
    const result = await providerMarkingOfArtifact({ kind: 'image', data: unsigned });
    expect(result.providerMarking.c2pa).toMatchObject({ present: false, status: 'absent' });
  });

  test('never carries who produced it', async () => {
    const result = await providerMarkingOfArtifact({ kind: 'image', data: signed });
    expect(JSON.stringify(result)).not.toContain('u-secret');
    expect(result.user).toBeUndefined();
  });

  test('an image nobody recorded, or a file that is no image, has no answer', async () => {
    await expect(
      providerMarkingOfArtifact({ kind: 'image', data: unrecorded })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      providerMarkingOfArtifact({ kind: 'document', data: signed })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(providerMarkingOfArtifact({ kind: 'image' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
  });
});

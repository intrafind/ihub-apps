// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the provider embedded in a stored generated image, for the chat's
 * "About this answer" details (EU AI Act Art. 50(2), #3328).
 *
 * The record of a generated image is written when it is generated and holds the
 * result of reading its C2PA manifest (`provider_marking`, see `mediaMarking.js`).
 * That read happens after the picture was sent to the browser, so the chat asks
 * for it afterwards, per artifact, through the route that already authorizes the
 * artifact's bytes (the owner's chat or a share). Nothing is read from the file
 * again and nothing leaves the process.
 *
 * The record is found by the SHA-256 of the artifact's bytes, which is how it is
 * keyed ("bytes in = bytes out"), so a picture generated before the chat showed
 * this has it as well, as long as a record was kept for it.
 *
 * `valid` means the signature and the binding to the file hold, never that the
 * signer is trusted (`trust` is always `not-evaluated`). The record's `user` is
 * not part of the answer.
 *
 * @module services/provenance/artifactProvenance
 */
import { ServiceError } from '../../utils/ServiceError.js';
import { getProvenanceStore } from './ProvenanceStore.js';
import { hashBytes } from './mediaMarking.js';

const notFound = () => new ServiceError('NOT_FOUND', 'No provenance record for this artifact');

/**
 * The provider marking recorded for a stored image.
 *
 * @param {{kind?: string, data: Buffer}} artifact - The artifact with its payload.
 * @returns {Promise<{outputId: string, createdAt?: string, providerMarking: Object}>}
 * @throws {ServiceError} NOT_FOUND when it is not an image or no record was kept.
 */
export async function providerMarkingOfArtifact(artifact) {
  if (artifact?.kind !== 'image' || !artifact.data) throw notFound();
  const store = getProvenanceStore();
  if (!store.isAvailable()) throw notFound();
  const records = await store.findByHash(hashBytes(artifact.data));
  // Newest first. The same bytes give the same manifest read, so the newest
  // record of an image stands for it.
  const record = records.find(r => r?.kind === 'image' && r.provider_marking);
  if (!record) throw notFound();
  return {
    outputId: String(record.output_id),
    ...(record.created_at ? { createdAt: String(record.created_at) } : {}),
    providerMarking: record.provider_marking
  };
}

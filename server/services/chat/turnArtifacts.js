// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Storing what a chat turn produced — generated pictures and files — as
 * artifacts of the chat. Used by the tool seam while the turn runs (a file is
 * stored when its tool finishes, so the browser is sent its card and not its
 * bytes) and by the materializer when the answer is stored.
 *
 * @module services/chat/turnArtifacts
 */

import logger from '../../utils/logger.js';
import { getArtifactRepository } from '../artifacts/ArtifactRepository.js';
import { artifactPolicy } from '../artifacts/artifactPolicy.js';
import { publicImageProvenance } from '../provenance/mediaMarking.js';
import { generatedFileKind } from '../../../shared/generatedFiles.js';

// The materializer's name: what the logs said before the store moved here.
const COMPONENT = 'chatMaterializer';

/**
 * Store the artifacts a turn produced and return the descriptors to record on
 * the assistant message.
 *
 * An artifact is anything a run produced that is content in its own right — a
 * generated image today. It is not a chat concept: the payloads go to the
 * shared `ArtifactRepository` under the scope `{ type: 'chat', id: chatId }`,
 * the same store a workflow's report or an agent's output belongs in. The
 * message keeps `{ id, kind, mimeType, bytes }`, which is what
 * `GET /api/chats/:chatId/artifacts/:artifactId` is addressed by.
 *
 * An artifact the policy refuses is still described, with `unavailable` saying
 * why. Leaving it out would make the stored answer claim the turn produced
 * less than it did, and the viewer who saw it live and comes back to a
 * transcript missing it has no way to tell a dropped artifact from one that
 * was never produced.
 *
 * Best effort, like everything else here: a storage failure costs the
 * artifact, never the answer.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {string} params.runId
 * @param {Array<{kind?: string, mimeType?: string, data?: string, name?: string}>} [params.artifacts]
 *   Artifacts as the loop collected them.
 * @param {import('../artifacts/ArtifactRepository.js').ArtifactRepository} [params.store]
 *   Artifact store; defaults to the shared one.
 * @param {Object} [params.policy] - Artifact policy; defaults to the live one.
 * @param {number} [params.alreadyStored=0] - Artifacts the turn stored before, which
 *   count against the same `maxPerBatch`.
 * @returns {Promise<Array<Object>>} Descriptors, in the order they came.
 */
export async function storeGeneratedArtifacts({
  chatId,
  runId,
  artifacts,
  store,
  policy,
  alreadyStored = 0
}) {
  const candidates = (Array.isArray(artifacts) ? artifacts : []).filter(
    artifact => artifact && typeof artifact.data === 'string' && artifact.data.length > 0
  );
  if (candidates.length === 0) return [];
  const { enabled, maxBytes, maxPerBatch } = policy || artifactPolicy();
  if (!enabled) return [];
  const repository = store || getArtifactRepository();
  const scope = { type: 'chat', id: chatId };
  const descriptors = [];
  // Counted on what was actually written, not on how many descriptors exist:
  // an artifact refused for its size is described too, and letting it consume
  // a slot would turn one oversized file into a cap on all the others.
  let stored = Number.isInteger(alreadyStored) && alreadyStored > 0 ? alreadyStored : 0;
  for (const artifact of candidates) {
    const kind = typeof artifact.kind === 'string' && artifact.kind ? artifact.kind : 'image';
    const mimeType =
      typeof artifact.mimeType === 'string' && artifact.mimeType ? artifact.mimeType : 'image/png';
    // What the picture actually weighs. The loop reports base64; the store
    // keeps raw bytes, so the cap is measured on the decoded size — the same
    // number a viewer sees and the same number the store records.
    const bytes = Buffer.byteLength(artifact.data, 'base64');
    // A refused file keeps its name, so the card can still say which one.
    const name = typeof artifact.name === 'string' && artifact.name ? artifact.name : null;
    // The provenance of a generated image (#3328, EU AI Act Art. 50(2)): the
    // output id names the record that describes it, and the object lets a
    // reopened chat show the "AI generated" details of the picture.
    const provenance = publicImageProvenance(artifact.provenance);
    const described = provenance ? { outputId: provenance.output_id, provenance } : {};
    const refused = {
      kind,
      mimeType,
      bytes,
      ...(name ? { name } : {}),
      ...described
    };
    if (maxPerBatch > 0 && stored >= maxPerBatch) {
      descriptors.push({ ...refused, unavailable: 'too-many' });
      continue;
    }
    if (maxBytes > 0 && bytes > maxBytes) {
      logger.warn('Artifact not stored: over the configured size cap', {
        component: COMPONENT,
        chatId,
        runId,
        kind,
        bytes,
        maxBytes
      });
      descriptors.push({ ...refused, unavailable: 'too-large' });
      continue;
    }
    try {
      const descriptor = await repository.put(scope, {
        kind,
        mimeType,
        data: artifact.data,
        name: artifact.name,
        runId
      });
      if (descriptor) stored += 1;
      descriptors.push(
        descriptor ? { ...descriptor, ...described } : { ...refused, unavailable: 'not-stored' }
      );
    } catch (error) {
      logger.error('Artifact not stored', {
        component: COMPONENT,
        chatId,
        runId,
        kind,
        error: error.message
      });
      descriptors.push({ ...refused, unavailable: 'not-stored' });
    }
  }
  return descriptors;
}

/** What a download card shows beyond the artifact's own descriptor. */
export function cardCounts(file) {
  return {
    ...(file.pages ? { pages: file.pages } : {}),
    ...(file.slides ? { slides: file.slides } : {}),
    ...(file.sheets ? { sheets: file.sheets } : {})
  };
}

/**
 * Store the files a tool just generated as artifacts of the chat, while the
 * turn is still running, so the browser is sent the card of each file — name,
 * type, size — and fetches the bytes from the artifact route when the user
 * opens or downloads it, rather than receiving them on `tool/completed`.
 *
 * A stored file comes back as its card with `stored: true` and the artifact's
 * id, and carries the artifact's descriptor on `artifact` for the stored
 * answer ({@link settleAssistantTurn}); the bytes are dropped. A file the
 * policy refuses or the store fails on (artifacts turned off, over the size
 * cap, past the per-turn count) keeps its bytes, as before: the live card is
 * then the only copy there is.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {string} params.runId
 * @param {Array<Object>} params.files - Cards with their bytes (`data`), see `shared/generatedFiles.js`
 * @param {Object} params.store - The chat's artifact store
 * @param {number} [params.alreadyStored=0] - Artifacts the turn stored before
 * @param {Object} [params.policy] - Artifact policy; defaults to the live one
 * @returns {Promise<{files: Array<Object>, stored: number}>} the cards in the
 *   order they came, and how many were stored
 */
export async function storeGeneratedFilesNow({
  chatId,
  runId,
  files,
  store,
  alreadyStored = 0,
  policy
}) {
  const list = Array.isArray(files) ? files : [];
  if (!store || !chatId || list.length === 0) return { files: list, stored: 0 };
  const descriptors = await storeGeneratedArtifacts({
    chatId,
    runId,
    store,
    policy,
    alreadyStored,
    artifacts: list.map(file => ({
      kind: generatedFileKind(file.mimeType),
      mimeType: file.mimeType,
      data: file.data,
      name: file.name
    }))
  });
  // Only files with bytes are stored, in order; one without has no descriptor.
  let next = 0;
  let stored = 0;
  const out = list.map(file => {
    if (typeof file.data !== 'string' || !file.data) return file;
    const descriptor = descriptors[next++];
    if (!descriptor?.id || descriptor.unavailable) return file;
    stored += 1;
    const { data: _data, ...card } = file;
    return {
      ...card,
      id: descriptor.id,
      bytes: descriptor.bytes ?? card.bytes,
      stored: true,
      artifact: { ...descriptor, ...cardCounts(file) }
    };
  });
  return { files: out, stored };
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a model can take as input, in one place so the uploader (`useFileUploadHandler`) and anything
 * that attaches a file on the user's behalf (the pending-document attachment) answer the same.
 *
 * - **vision**: the model's own metadata (`supportsVision`, then `supportsImages`), and only when it
 *   says nothing a guess from the model id (older configurations);
 * - **audio**: `supportsAudio`;
 * - **transcription** models take audio and video only, which are their whole input: no images, no
 *   documents.
 *
 * @module shared/utils/modelInputCapabilities
 */

const VISION_ID_HINTS = ['vision', 'gpt-4', 'claude-3', 'gemini', '4o'];

/**
 * @param {Object|null|undefined} model - a model object as served by `/api/models`
 * @returns {{transcription: boolean, vision: boolean, audio: boolean}}
 */
export function modelInputCapabilities(model) {
  const transcription = model?.modelType === 'transcription';
  const modelId = model?.id || '';
  const vision = Boolean(
    model?.supportsVision ??
    model?.supportsImages ??
    (modelId && VISION_ID_HINTS.some(hint => modelId.includes(hint)))
  );
  return { transcription, vision, audio: model?.supportsAudio === true };
}

/**
 * Whether a model takes a file of this kind (the uploader's rules without the app's settings).
 *
 * @param {'image'|'audio'|'document'} kind
 * @param {Object|null|undefined} model
 * @returns {boolean}
 */
export function modelTakesFileKind(kind, model) {
  const { transcription, vision, audio } = modelInputCapabilities(model);
  if (kind === 'image') return vision && !transcription;
  if (kind === 'audio') return audio || transcription;
  return !transcription;
}

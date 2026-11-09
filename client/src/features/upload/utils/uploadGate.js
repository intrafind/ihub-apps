// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Why the uploader refuses a file the app would take if the selected model could.
 *
 * An upload type the model cannot take is switched off for the uploader (its list of formats is
 * empty), so a file of that type used to fall through to the generic "unsupported format" answer
 * that lists what the app accepts. That answer is right when the app itself does not take the
 * type, and wrong when the app does and the model does not: the user should be told to pick
 * another model. The two cases differ in `blockedByModel`, which `createUploadConfig` sets.
 *
 * @module features/upload/utils/uploadGate
 */

/** The error code of each kind, in the order they are checked. */
const REFUSALS = [
  ['image', 'image-upload-disabled'],
  ['audio', 'audio-upload-disabled'],
  ['video', 'video-upload-disabled']
];

/**
 * @typedef {Object} KindGate
 * @property {boolean} enabled - the uploader takes this kind now
 * @property {boolean} blockedByModel - the app allows this kind and the selected model cannot take it
 * @property {string[]} offered - the formats of the kind the app lists, whether or not it is enabled
 */

/**
 * The refusal that applies to a file, if the model is the reason.
 *
 * @param {(formats: string[]) => boolean} isListed - whether the file is one of these formats
 * @param {{ image?: KindGate, audio?: KindGate, video?: KindGate }} kinds
 * @returns {'image-upload-disabled'|'audio-upload-disabled'|'video-upload-disabled'|null}
 */
export function capabilityRefusal(isListed, kinds) {
  for (const [kind, code] of REFUSALS) {
    const gate = kinds?.[kind];
    if (gate && !gate.enabled && gate.blockedByModel === true && isListed(gate.offered || [])) {
      return code;
    }
  }
  return null;
}

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { normalizeModelHint } from '../components/ModelHintSection';

/**
 * The parts of a model form that a save drops before it sends the model: the
 * `tts` block of a model that is no longer a text-to-speech model, voices
 * added without a voice ID, and hint languages without text (a hint without
 * any text goes). The save sends what this returns, and the form validates
 * it, so a field the save would drop never blocks a save.
 *
 * @param {object} model - The model as the form holds it.
 * @returns {object} A copy without those parts.
 *
 * @example
 * withoutDroppedParts({ modelType: 'chat', tts: { voices: { de: '' } } }); // → { modelType: 'chat' }
 */
export function withoutDroppedParts(model) {
  const result = { ...model };
  if ((result.modelType || 'chat') !== 'tts') {
    delete result.tts;
  } else if (result.tts?.voices) {
    const voices = Object.entries(result.tts.voices).filter(([, voice]) => voice);
    result.tts = { ...result.tts };
    if (voices.length) result.tts.voices = Object.fromEntries(voices);
    else delete result.tts.voices;
  }
  const hint = normalizeModelHint(result.hint);
  if (hint) result.hint = hint;
  else delete result.hint;
  return result;
}

export default withoutDroppedParts;

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a model provider says about marking the output of its models, applied to
 * the models an admin imports from the provider's listing (EU AI Act Art. 50(2)).
 *
 * iHub applies no mark to the output of a hosted model; the provider does. What
 * iHub records is the provider's claim (`contentMarking.<kind>.by: "provider"`),
 * which the operator vouches for. Importing a model from a provider that
 * publishes such a claim fills that declaration in, so the admin does not have to
 * enter it model by model. It is a starting point: the admin can change or remove
 * it in **Admin → Models → Output marking**, and should replace the reference
 * with the provider's written confirmation for their own contract.
 *
 * Google (Gemini API):
 *   - Text: Gemini marks its text with SynthID-Text. There is no public detector
 *     for API text, so the claim is all iHub can keep.
 *   - Images: Gemini and Imagen images carry SynthID. (Some also carry a C2PA
 *     manifest, which iHub reads from the bytes itself — see mediaMarking.js —
 *     so no scheme for it is declared here.) SynthID itself cannot be detected
 *     by iHub.
 *
 * Pure: no I/O, so the admin routes, the import and the model sync can all use it.
 *
 * @module services/provenance/providerMarking
 */

/**
 * Where Google states that its generative output is marked with SynthID. Kept as
 * the `statementRef` of the declarations below (a reference only, never fetched).
 *
 * The page is Google's public statement. It names the Gemini app and web
 * experience for text and generated images in general; it does not mention the
 * Gemini API by name. An operator who relies on the marking for API output should
 * point `statementRef` at Google's written confirmation instead (Code of
 * Practice on marking, 4.2).
 */
export const GOOGLE_SYNTHID_STATEMENT_REF =
  'Google DeepMind, SynthID: https://deepmind.google/technologies/synthid/';

/** `contentMarking` member declaring a SynthID mark by Google. A fresh object per call. */
function googleSynthId() {
  return { by: 'provider', scheme: 'synthid', statementRef: GOOGLE_SYNTHID_STATEMENT_REF };
}

/**
 * Whether a Gemini model returns images (Nano Banana: `gemini-2.5-flash-image`,
 * `gemini-3-pro-image-preview`, …). The Gemini API listing does not say what a
 * model outputs, so the id decides, like the type guesses of the import.
 */
function isGeminiImageModel(id) {
  return /^gemini-(.*-)?image(-|$)/i.test(id);
}

/**
 * Settings an import adds to the config of a model of a provider that declares how it
 * marks output. Only models that generate text or images get any: a speech,
 * embedding or rerank model has nothing to mark.
 *
 * @param {string} apiType - API type of the provider the model is listed by
 * @param {{ id: string, type: string }} entry - Normalized listing entry
 * @returns {{ contentMarking?: Object, supportsImageGeneration?: true }} Empty when the provider
 *   makes no claim for this model
 */
export function providerMarkingFacts(apiType, entry) {
  if (apiType !== 'google' || entry?.type !== 'chat') return {};
  // Gemma and the other open models in the listing are not Gemini: no claim.
  if (!/^gemini-/i.test(entry.id)) return {};

  if (isGeminiImageModel(entry.id)) {
    // Text answers of an image model carry the text mark too.
    return {
      supportsImageGeneration: true,
      contentMarking: { text: googleSynthId(), image: googleSynthId() }
    };
  }
  return { contentMarking: { text: googleSynthId() } };
}

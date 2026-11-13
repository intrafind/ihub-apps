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
 * enter it model by model. The admin can change or remove it in
 * **Admin → Models → Output marking**.
 *
 * Google (Gemini API):
 *   - Text: Gemini marks its text with SynthID-Text. There is no public detector
 *     for API text, so the claim is all iHub can keep.
 *   - Images: Gemini and Imagen images carry SynthID. (Some also carry a C2PA
 *     manifest, which iHub reads from the bytes itself — see mediaMarking.js —
 *     so no scheme for it is declared here.) SynthID itself cannot be detected
 *     by iHub.
 *
 * Anthropic (Claude API): the text of the supported models carries Anthropic's
 *   text watermark, "a version of the SynthID-Text approach". It cannot be switched
 *   off and is not applied where an exact output is required (code syntax,
 *   arithmetic). Only the models in {@link ANTHROPIC_MARKED_MODELS} are declared,
 *   which is the list of Anthropic's own page "How Claude marks AI-generated
 *   content": a model that is not named there makes no claim. Some models carry the
 *   mark on Anthropic's own API but not through a cloud partner (AWS, Google Cloud,
 *   Microsoft Foundry), so those are declared only for `api.anthropic.com`.
 *   Anthropic's detection API is in private preview, so, as for Google, the claim
 *   is all iHub can keep.
 *
 * Mistral: declares nothing. Mistral signed Section 1 of the Code of Practice
 *   (marking and detection), but publishes no technical description of a mark for
 *   its API or Le Chat, so there is no scheme to declare. Add `contentMarking` by
 *   hand once Mistral documents one.
 *
 * Pure: no I/O, so the admin routes, the import and the model sync can all use it.
 *
 * @module services/provenance/providerMarking
 */

/**
 * Where Google states that its generative output is marked with SynthID. Kept as
 * the `statementRef` of the declarations below (a reference only, never fetched).
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
 * Where Anthropic states which models carry its text watermark. Kept as the
 * `statementRef` of the declarations below (a reference only, never fetched).
 */
export const ANTHROPIC_WATERMARK_STATEMENT_REF =
  'Anthropic, How Claude marks AI-generated content: https://support.claude.com/en/articles/16266773-how-claude-marks-ai-generated-content';

/** `contentMarking` member declaring Anthropic's text watermark. A fresh object per call. */
function anthropicWatermark() {
  return {
    by: 'provider',
    scheme: 'synthid-text',
    statementRef: ANTHROPIC_WATERMARK_STATEMENT_REF
  };
}

/**
 * The Claude models whose text carries the watermark: the models Anthropic's page
 * marks for first-party text. Matched by API id or by the display name the listing
 * gives (`display_name`), so a model is found either way. A model that is not here
 * makes no claim, whatever its line: newer and older models are added when
 * Anthropic names them.
 *
 * `id` is the API id. Models before the 4.6 generation are listed by their dated
 * snapshot (`claude-haiku-4-5-20251001`) and also answer to the dateless alias, so
 * an id with an eight-digit date after it is the same model.
 *
 * `firstPartyOnly`: Anthropic's page does not list the model for cloud partners
 * (AWS, Google Cloud, Microsoft Foundry), so it is declared only when the provider
 * points at `api.anthropic.com` itself.
 *
 * `defaultSamplingOnly`: the watermark may not appear when `temperature`, `top_p`
 * or `top_k` is set to a non-default value (Sonnet 4.6). The import sets none of
 * them; the model sync does not offer the declaration to a model that does.
 */
export const ANTHROPIC_MARKED_MODELS = Object.freeze([
  { name: 'Claude Fable 5.2', id: 'claude-fable-5-2' },
  { name: 'Claude Fable 5.1', id: 'claude-fable-5-1' },
  { name: 'Claude Fable 5', id: 'claude-fable-5' },
  { name: 'Claude Mythos 5.2', id: 'claude-mythos-5-2' },
  { name: 'Claude Mythos 5.1', id: 'claude-mythos-5-1' },
  { name: 'Claude Mythos 5', id: 'claude-mythos-5' },
  { name: 'Claude Opus 5.5', id: 'claude-opus-5-5' },
  { name: 'Claude Opus 5', id: 'claude-opus-5' },
  { name: 'Claude Opus 4.8', id: 'claude-opus-4-8' },
  { name: 'Claude Opus 4.7', id: 'claude-opus-4-7' },
  { name: 'Claude Opus 4.6', id: 'claude-opus-4-6', firstPartyOnly: true },
  { name: 'Claude Opus 4.5', id: 'claude-opus-4-5', firstPartyOnly: true },
  { name: 'Claude Sonnet 5.5', id: 'claude-sonnet-5-5' },
  { name: 'Claude Sonnet 5', id: 'claude-sonnet-5' },
  { name: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6', defaultSamplingOnly: true },
  { name: 'Claude Sonnet 4.5', id: 'claude-sonnet-4-5', firstPartyOnly: true },
  { name: 'Claude Haiku 5.5', id: 'claude-haiku-5-5' },
  { name: 'Claude Haiku 4.5', id: 'claude-haiku-4-5', firstPartyOnly: true }
]);

/** The host of Anthropic's own API: the one place every listed model is marked. */
const ANTHROPIC_FIRST_PARTY_HOST = 'api.anthropic.com';

/** Whether `id` is `base` or its dated snapshot (`base-YYYYMMDD`). */
function isSnapshotOf(id, base) {
  return id === base || (id.startsWith(`${base}-`) && /^\d{8}$/.test(id.slice(base.length + 1)));
}

function isAnthropicFirstParty(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === ANTHROPIC_FIRST_PARTY_HOST;
  } catch {
    return false;
  }
}

function anthropicFacts(entry, context) {
  const model = ANTHROPIC_MARKED_MODELS.find(
    m => isSnapshotOf(entry.id, m.id) || entry.name === m.name
  );
  if (!model) return {};
  if (model.firstPartyOnly && !isAnthropicFirstParty(context.baseUrl)) return {};
  return {
    contentMarking: { text: anthropicWatermark() },
    ...(model.defaultSamplingOnly ? { markingNeedsDefaultSampling: true } : {})
  };
}

function googleFacts(entry) {
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

/**
 * Settings an import adds to the config of a model of a provider that declares how it
 * marks output. Only models that generate text or images get any: a speech,
 * embedding or rerank model has nothing to mark.
 *
 * @param {string} apiType - API type of the provider the model is listed by
 * @param {{ id: string, name?: string, type: string }} entry - Normalized listing entry
 * @param {{ baseUrl?: string }} [context] - The API base the listing was read from; some
 *   declarations hold for the provider's own endpoint only
 * @returns {{ contentMarking?: Object, supportsImageGeneration?: true,
 *   markingNeedsDefaultSampling?: true }} Empty when the provider makes no claim for this model
 *   (always for Mistral and every API type not named above). `markingNeedsDefaultSampling` is
 *   not part of the model config: the model sync reads it from the entry.
 */
export function providerMarkingFacts(apiType, entry, context = {}) {
  if (entry?.type !== 'chat') return {};
  if (apiType === 'google') return googleFacts(entry);
  if (apiType === 'anthropic') return anthropicFacts(entry, context);
  return {};
}

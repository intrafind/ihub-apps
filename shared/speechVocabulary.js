/**
 * Custom vocabulary ("hotwords") for speech-to-text.
 *
 * Domain jargon, product names and people's names are what a general-purpose
 * STT model gets wrong most often. A hotword list fixes that by naming the
 * terms the decoder should pay extra attention to, so "Voxtral" stops coming
 * back as "vox tral" or "Vox Trawl".
 *
 * `hotwords` is vLLM's own name and shape for this: a single string of terms
 * (see `SpeechToTextParams.hotwords` in vllm/config/speech_to_text.py). It is
 * deliberately NOT the `context_biasing: { words, bias_score }` object that
 * Mistral's hosted Voxtral Transcribe API uses — that shape does not exist in
 * vLLM, and there is no per-term weight to configure here.
 *
 * IMPORTANT — upstream support: vLLM's realtime WebSocket endpoint currently
 * reads only `model` off `session.update` and never builds SpeechToTextParams
 * for a realtime session, so a stock build ignores the hotwords iHub sends.
 * The field takes effect on an endpoint that forwards speech-to-text params
 * into the realtime session. See docs/voice-transcription.md.
 *
 * A vocabulary can be configured at three levels, each optional:
 *
 *   1. `platform.speech.realtime.vocabulary` — organization-wide terms that
 *      apply to every transcription session (dictation and model-based alike).
 *   2. `<transcription model>.vocabulary` — terms tied to one model.
 *   3. `<app>.transcription.vocabulary` — terms for one app's subject area.
 *
 * They are MERGED, not overridden (see `mergeVocabularies`): the term lists are
 * unioned so an app adds to the org-wide list instead of replacing it.
 *
 * Shared between server and client so the admin UI enforces exactly the limits
 * the server validates against.
 */

/** Hard cap on merged term count. Long lists cost upstream prompt space. */
export const VOCABULARY_MAX_TERMS = 250;
/** Hard cap on one term's length. Hotwords are words and short phrases. */
export const VOCABULARY_MAX_TERM_LENGTH = 80;
/** Separator used to render the term list into vLLM's single hotwords string. */
export const HOTWORDS_SEPARATOR = ', ';

/**
 * Parse the free-form text an admin types into a term list. Accepts one term
 * per line and/or comma-separated terms, so pasting either shape works.
 * Terms may contain spaces (multi-word phrases like "Deutsche Bahn").
 *
 * @param {string|string[]} raw
 * @returns {string[]} Trimmed, non-empty terms in input order (not deduped).
 */
export function parseVocabularyTerms(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter(term => typeof term === 'string')
      .map(term => term.trim())
      .filter(Boolean);
  }
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\n,]/)
    .map(term => term.trim())
    .filter(Boolean);
}

/** Render a term list back into the one-per-line form the admin textarea shows. */
export function formatVocabularyTerms(terms) {
  return Array.isArray(terms) ? terms.join('\n') : '';
}

/**
 * Normalize one configured vocabulary layer.
 *
 * `enabled` defaults to TRUE when omitted: a layer that lists terms is meant to
 * be used, and requiring a second opt-in flag is the kind of trap where
 * hand-edited config silently does nothing. `enabled: false` is the off switch.
 *
 * @param {{enabled?: boolean, terms?: string[]|string}} [vocabulary]
 * @returns {{enabled: boolean, terms: string[]}|null} Null when the layer
 *   contributes nothing (absent, disabled, or no usable terms).
 */
export function normalizeVocabulary(vocabulary) {
  if (!vocabulary || typeof vocabulary !== 'object') return null;
  if (vocabulary.enabled === false) return null;

  const seen = new Set();
  const terms = [];
  for (const term of parseVocabularyTerms(vocabulary.terms)) {
    // Case matters to the model ("SAP" and "Sap" read differently), so dedupe
    // exactly rather than case-insensitively.
    const trimmed = term.slice(0, VOCABULARY_MAX_TERM_LENGTH).trim();
    // A term containing the separator would split into two on the wire.
    const safe = trimmed.split(',').join(' ').replace(/\s+/g, ' ').trim();
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    terms.push(safe);
    if (terms.length >= VOCABULARY_MAX_TERMS) break;
  }
  if (!terms.length) return null;

  return { enabled: true, terms };
}

/**
 * Merge vocabulary layers from least to most specific (platform, model, app).
 *
 * Terms are UNIONED in layer order — an app's vocabulary adds to the org-wide
 * one rather than replacing it, which is what an admin who set both expects.
 *
 * @param {...(Object|null|undefined)} layers - Raw (unnormalized) vocabularies.
 * @returns {{enabled: boolean, terms: string[]}|null}
 */
export function mergeVocabularies(...layers) {
  const seen = new Set();
  const terms = [];

  for (const layer of layers) {
    const normalized = normalizeVocabulary(layer);
    if (!normalized) continue;
    for (const term of normalized.terms) {
      if (seen.has(term) || terms.length >= VOCABULARY_MAX_TERMS) continue;
      seen.add(term);
      terms.push(term);
    }
  }

  return terms.length ? { enabled: true, terms } : null;
}

/**
 * Render the merged vocabulary into vLLM's `hotwords` string.
 *
 * Returns null when nothing is configured — the caller must then omit the field
 * entirely. That is deliberate: deployments that configure no vocabulary keep
 * sending exactly the frames they send today.
 *
 * @param {{terms: string[]}|null} vocabulary - Merged result.
 * @returns {string|null}
 */
export function buildHotwords(vocabulary) {
  if (!vocabulary?.terms?.length) return null;
  return vocabulary.terms.join(HOTWORDS_SEPARATOR);
}

export default {
  VOCABULARY_MAX_TERMS,
  VOCABULARY_MAX_TERM_LENGTH,
  HOTWORDS_SEPARATOR,
  parseVocabularyTerms,
  formatVocabularyTerms,
  normalizeVocabulary,
  mergeVocabularies,
  buildHotwords
};
